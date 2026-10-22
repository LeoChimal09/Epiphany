import { addDays, parseDateKey } from "../planning/time";
import { MAX_CAPTURE_ITEMS, type CaptureItem, type Intent } from "./intent";

// Count only flat, consistently marked lists. Nested steps and unstructured prose are left to AI.
export function listedEntryCount(message: string): number | undefined {
  const entries = [...message.matchAll(/^([ \t]*)(?:(\d{1,3})[.)]|([-*•]))\s+\S.*$/gm)];
  if (entries.length < 2) return undefined;
  const indent = entries[0]![1]!;
  if (entries.some((entry) => entry[1] !== indent)) return undefined;
  if (entries[0]![2]) {
    const first = Number(entries[0]![2]);
    if (entries.some((entry, index) => Number(entry[2]) !== first + index)) return undefined;
  } else if (entries.some((entry) => entry[3] !== entries[0]![3])) {
    return undefined;
  }
  return entries.length;
}

// Recognize only complete, repeated course cards. A partial match goes to language understanding
// intact, rather than silently losing an item, guessing a date, or treating prose as a task.
export function parseCourseList(message: string, today: string): Intent | null {
  const lines = message
    .trim()
    .replace(
      /^(?:(?:hey|hi|hello)[ ,]+)?(?:epi[ ,]+)?here(?:['\u2019]?s| are)\s+my\s+(?:assignments|homework)(?:[ \t]*[:,][ \t]*(?:\r?\n)?|[ \t]*\r?\n)/i,
      "",
    )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 12 || lines.length % 6 !== 0) return null;
  const items: CaptureItem[] = [];
  for (let index = 0; index < lines.length; index += 6) {
    const [title, course, separator, link, points, due] = [
      lines[index],
      lines[index + 1],
      lines[index + 2],
      lines[index + 3],
      lines[index + 4],
      lines[index + 5],
    ];
    if (
      !title ||
      title.length > 300 ||
      !course ||
      !/^[A-Z]{2,10}-\d{2,4}(?:-[\w-]+| Sections? \d+(?: and \d+)*)$/.test(course) ||
      separator !== "|" ||
      link !== "Go to course" ||
      !points ||
      !/^\d+(?:\.\d+)? pts?$/.test(points) ||
      !due
    ) {
      return null;
    }
    const match = /^(Today|Tomorrow|\d{1,2}\/\d{1,2}\/\d{4}) (\d{1,2}):(\d{2}) (AM|PM)$/i.exec(due);
    if (!match) return null;
    const hour = Number(match[2]);
    const minute = Number(match[3]);
    if (hour < 1 || hour > 12 || minute > 59) return null;
    let date: string;
    if (/^today$/i.test(match[1]!)) date = today;
    else if (/^tomorrow$/i.test(match[1]!)) date = addDays(today, 1);
    else {
      const [month, day, year] = match[1]!.split("/");
      date = `${year}-${month!.padStart(2, "0")}-${day!.padStart(2, "0")}`;
    }
    try {
      parseDateKey(date);
    } catch {
      return null;
    }
    const hours = (hour % 12) + (match[4]!.toUpperCase() === "PM" ? 12 : 0);
    items.push({
      type: "task",
      title,
      details: `${course}, ${points}`,
      dueDate: date,
      dueTime: `${String(hours).padStart(2, "0")}:${match[3]}`,
    });
  }
  const omitted = Math.max(0, items.length - MAX_CAPTURE_ITEMS);
  return {
    kind: "capture",
    items: items.slice(0, MAX_CAPTURE_ITEMS),
    ...(omitted ? { omitted } : {}),
  };
}
