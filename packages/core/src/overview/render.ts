import { addDays, dateKeyOf, daysBetween, type DateKey } from "../planning/time";
import type {
  ActionHistoryEntry,
  CalendarEvent,
  Note,
  Reminder,
  Task,
  WorkBlock,
} from "../db/schema";

// The views Epi keeps up to date in Discord. Each is plain text built only from records, so the
// same records always produce the same message (which is what lets an unchanged view be skipped).
export const OVERVIEW_VIEWS = [
  "today",
  "schedule",
  "priorities",
  "notes-and-ideas",
  "check-ins",
  "activity-log",
] as const;
export type OverviewView = (typeof OVERVIEW_VIEWS)[number];

export interface OverviewData {
  now: Date;
  timezone: string;
  openTasks: Task[];
  // Open and recently completed tasks, notes, and categories, to put a name on history entries.
  knownTasks: Task[];
  notes: Note[];
  events: CalendarEvent[];
  blocks: WorkBlock[];
  history: ActionHistoryEntry[];
  reminders: Reminder[];
  categoryNames: ReadonlyMap<string, string>;
}

const MAX_CHARS = 1900;

// Overview text comes from the owner's own records, but a title must never ping anyone or break
// the layout: mentions are defused and markdown control characters are escaped.
export function plain(text: string): string {
  return text
    .replace(/[\r\n]+/g, " ")
    .replace(/@/g, "@\u200b")
    .replace(/([\\*_`~|>#[\]])/g, "\\$1")
    .trim();
}

export function marker(view: OverviewView): string {
  return `-# epi:${view}`;
}

const dayFormat = (timezone: string) =>
  new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    weekday: "short",
    month: "short",
    day: "numeric",
  });
const timeFormat = (timezone: string) =>
  new Intl.DateTimeFormat("en-US", { timeZone: timezone, hour: "numeric", minute: "2-digit" });

const clean = (value: string) => value.replace(/\u202f/g, " ");

function dayLabel(key: DateKey): string {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return dayFormat("UTC").format(new Date(Date.UTC(year, month - 1, day, 12)));
}

function timeLabel(at: Date, timezone: string): string {
  return clean(timeFormat(timezone).format(at));
}

function dueKey(task: Task, timezone: string): DateKey | null {
  if (!task.dueAt) return null;
  return task.dueDateOnly ? task.dueAt.toISOString().slice(0, 10) : dateKeyOf(task.dueAt, timezone);
}

function dueText(task: Task, timezone: string, withDay = true): string {
  const key = dueKey(task, timezone);
  if (!key || !task.dueAt) return "no deadline";
  const day = dayLabel(key);
  if (task.dueDateOnly) return withDay ? `due ${day}` : "all day";
  const time = timeLabel(task.dueAt, timezone);
  return withDay ? `due ${day}, ${time}` : time;
}

const review = (task: Task) => (task.reviewNote ? " ⚠ needs review" : "");

// Joins sections, keeping the message under Discord's limit by dropping whole trailing lines.
function assemble(view: OverviewView, title: string, lines: string[], empty: string): string {
  const tail = `\n${marker(view)}`;
  const body = lines.length > 0 ? lines : [empty];
  const head = `**${title}**`;
  let text = [head, ...body].join("\n");
  if (text.length + tail.length > MAX_CHARS) {
    const kept: string[] = [head];
    let used = head.length;
    let dropped = 0;
    for (const line of body) {
      if (used + line.length + 1 + tail.length + 40 > MAX_CHARS) dropped++;
      else {
        kept.push(line);
        used += line.length + 1;
      }
    }
    text = [...kept, `…and ${dropped} more lines (see the dashboard)`].join("\n");
  }
  return `${text}${tail}`;
}

function today(data: OverviewData): string {
  const { timezone } = data;
  const key = dateKeyOf(data.now, timezone);
  const lines: string[] = [];

  const overdue = data.openTasks.filter((task) => {
    const due = dueKey(task, timezone);
    return due !== null && due < key;
  });
  const dueToday = data.openTasks.filter((task) => dueKey(task, timezone) === key);
  const events = data.events.filter(
    (event) =>
      event.status === "scheduled" &&
      dateKeyOf(event.startsAt, event.allDay ? event.timezone : timezone) === key,
  );
  const blocks = data.blocks.filter(
    (block) => block.status === "planned" && dateKeyOf(block.startsAt, timezone) === key,
  );

  if (overdue.length > 0) {
    lines.push("__Overdue__");
    for (const task of overdue) {
      lines.push(`• ${plain(task.title)} (${dueText(task, timezone)})${review(task)}`);
    }
  }
  if (dueToday.length > 0) {
    lines.push("__Due today__");
    for (const task of dueToday) {
      lines.push(`• ${plain(task.title)} (${dueText(task, timezone, false)})${review(task)}`);
    }
  }
  if (events.length > 0) {
    lines.push("__Events__");
    for (const event of events.toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
      const when = event.allDay
        ? "all day"
        : `${timeLabel(event.startsAt, timezone)} to ${timeLabel(event.endsAt, timezone)}`;
      lines.push(`• ${plain(event.title)} (${when})`);
    }
  }
  if (blocks.length > 0) {
    lines.push("__Planned work__");
    for (const block of blocks.toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime())) {
      lines.push(
        `• ${plain(block.title ?? "Work block")} (${timeLabel(block.startsAt, timezone)} to ${timeLabel(block.endsAt, timezone)})`,
      );
    }
  }
  return assemble("today", `Today · ${dayLabel(key)}`, lines, "Nothing due or scheduled today.");
}

function schedule(data: OverviewData): string {
  const { timezone } = data;
  const start = dateKeyOf(data.now, timezone);
  const days = new Map<DateKey, { at: number; text: string }[]>();
  const put = (key: DateKey, at: number, text: string) => {
    if (key < start || key > addDays(start, 6)) return;
    const list = days.get(key) ?? [];
    list.push({ at, text });
    days.set(key, list);
  };

  for (const task of data.openTasks) {
    const key = dueKey(task, timezone);
    if (!key || !task.dueAt) continue;
    put(
      key,
      task.dueDateOnly ? -1 : task.dueAt.getTime(),
      `Due: ${plain(task.title)} (${dueText(task, timezone, false)})${review(task)}`,
    );
  }
  for (const event of data.events) {
    if (event.status !== "scheduled") continue;
    const key = dateKeyOf(event.startsAt, event.allDay ? event.timezone : timezone);
    const when = event.allDay ? "all day" : timeLabel(event.startsAt, timezone);
    put(key, event.allDay ? -2 : event.startsAt.getTime(), `${when}: ${plain(event.title)}`);
  }
  for (const block of data.blocks) {
    if (block.status !== "planned") continue;
    put(
      dateKeyOf(block.startsAt, timezone),
      block.startsAt.getTime(),
      `${timeLabel(block.startsAt, timezone)}: work on ${plain(block.title ?? "a task")}`,
    );
  }

  const lines: string[] = [];
  for (const key of [...days.keys()].toSorted()) {
    lines.push(`__${dayLabel(key)}__`);
    for (const item of days.get(key)!.toSorted((a, b) => a.at - b.at)) lines.push(`• ${item.text}`);
  }
  return assemble("schedule", "Next 7 days", lines, "Nothing scheduled in the next 7 days.");
}

function priorities(data: OverviewData): string {
  const { timezone } = data;
  const todayKey = dateKeyOf(data.now, timezone);
  const ranked = data.openTasks.toSorted((a, b) => {
    if (!a.dueAt && !b.dueAt) return a.createdAt.getTime() - b.createdAt.getTime();
    if (!a.dueAt) return 1;
    if (!b.dueAt) return -1;
    return a.dueAt.getTime() - b.dueAt.getTime();
  });
  const lines = ranked.slice(0, 10).map((task, index) => {
    const key = dueKey(task, timezone);
    let countdown = "";
    if (key) {
      const days = daysBetween(todayKey, key);
      countdown = days < 0 ? `, ${-days}d overdue` : days === 0 ? ", today" : `, in ${days}d`;
    }
    const category = data.categoryNames.get(task.categoryId);
    return `${index + 1}. ${plain(task.title)} (${task.priority}, ${dueText(task, timezone)}${countdown}${category && category !== "Inbox" ? `, ${plain(category)}` : ""})${review(task)}`;
  });
  if (ranked.length > 10) lines.push(`…and ${ranked.length - 10} more open tasks`);
  return assemble(
    "priorities",
    `Priorities · ${ranked.length} open`,
    lines,
    "No open tasks. Nice.",
  );
}

function notesAndIdeas(data: OverviewData): string {
  const recent = data.notes.toSorted((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  const lines = recent.slice(0, 10).map((note) => {
    const title = plain(note.title?.trim() || note.body.trim().slice(0, 60));
    return `• ${title} (${note.kind})`;
  });
  if (recent.length > 10) lines.push(`…and ${recent.length - 10} more`);
  return assemble("notes-and-ideas", "Notes and ideas", lines, "No notes or ideas saved yet.");
}

function checkIns(data: OverviewData): string {
  const { timezone } = data;
  const stamp = (at: Date) => `${dayFormat(timezone).format(at)} ${timeLabel(at, timezone)}`;
  const short = (text: string) => plain(text.length > 90 ? `${text.slice(0, 87)}...` : text);
  const lines: string[] = [];

  const upcoming = data.reminders
    .filter((reminder) => reminder.status === "scheduled")
    .toSorted((a, b) => a.dueAt.getTime() - b.dueAt.getTime())
    .slice(0, 8);
  if (upcoming.length > 0) {
    lines.push("__Coming up__");
    for (const reminder of upcoming) {
      lines.push(`• ${stamp(reminder.dueAt)}: ${short(reminder.message)}`);
    }
  }

  const since = data.now.getTime() - 3 * 24 * 3_600_000;
  const problems = data.reminders
    .filter(
      (reminder) =>
        (reminder.status === "failed" || reminder.status === "unknown") &&
        reminder.dueAt.getTime() >= since,
    )
    .toSorted((a, b) => b.dueAt.getTime() - a.dueAt.getTime())
    .slice(0, 5);
  if (problems.length > 0) {
    lines.push("__Didn't reach you__");
    for (const reminder of problems) {
      lines.push(
        `• ${stamp(reminder.dueAt)}: ${short(reminder.message)} (${plain(reminder.detail ?? reminder.status)})`,
      );
    }
  }
  return assemble("check-ins", "Reminders and check-ins", lines, "No reminders scheduled.");
}

const VERBS: Record<string, string> = {
  "task.create": "Added task",
  "task.complete": "Completed",
  "task.reopen": "Reopened",
  "task.update": "Edited",
  "note.create": "Saved note",
  "note.update": "Edited note",
  "note.delete": "Deleted note",
  "event.create": "Added event",
  "event.cancel": "Canceled event",
  "work_block.create": "Planned work block",
  "work_block.remove": "Removed work block",
  "category.create": "Created category",
};

function activity(data: OverviewData): string {
  const { timezone } = data;
  const taskTitles = new Map(data.knownTasks.map((task) => [task.id, task.title]));
  const noteTitles = new Map(
    data.notes.map((note) => [note.id, note.title?.trim() || note.body.trim().slice(0, 60)]),
  );
  const lines: string[] = [];
  for (const entry of data.history) {
    const verb = VERBS[entry.action];
    if (!verb) continue;
    const name =
      entry.entityType === "task"
        ? taskTitles.get(entry.entityId)
        : entry.entityType === "note"
          ? noteTitles.get(entry.entityId)
          : undefined;
    const moved =
      entry.action === "task.update" &&
      ((entry.after as { fields?: string[] } | null)?.fields ?? []).includes("categoryId");
    const when = `${dayFormat(timezone).format(entry.createdAt)} ${timeLabel(entry.createdAt, timezone)}`;
    lines.push(
      `• ${when}: ${moved ? "Moved" : verb}${name ? ` "${plain(name)}"` : ""} (${entry.source})`,
    );
    if (lines.length >= 15) break;
  }
  return assemble("activity-log", "Recent activity", lines, "Nothing has changed yet.");
}

export function renderOverview(view: OverviewView, data: OverviewData): string {
  switch (view) {
    case "today":
      return today(data);
    case "schedule":
      return schedule(data);
    case "priorities":
      return priorities(data);
    case "notes-and-ideas":
      return notesAndIdeas(data);
    case "check-ins":
      return checkIns(data);
    case "activity-log":
      return activity(data);
  }
}

// The text of the morning briefing, built from today's records at the moment it is sent (a message
// scheduled the night before would be out of date). Plain DM text: no marker, no formatting that
// depends on a channel.
export function renderBriefing(data: OverviewData): string {
  const { timezone } = data;
  const key = dateKeyOf(data.now, timezone);
  const lines: string[] = [`Good morning! Here's ${dayLabel(key)}.`];

  const overdue = data.openTasks.filter((task) => {
    const due = dueKey(task, timezone);
    return due !== null && due < key;
  });
  const dueToday = data.openTasks.filter((task) => dueKey(task, timezone) === key);
  const events = data.events
    .filter(
      (event) =>
        event.status === "scheduled" &&
        dateKeyOf(event.startsAt, event.allDay ? event.timezone : timezone) === key,
    )
    .toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
  const blocks = data.blocks
    .filter((block) => block.status === "planned" && dateKeyOf(block.startsAt, timezone) === key)
    .toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime());

  if (events.length > 0) {
    lines.push("", "On your calendar:");
    for (const event of events) {
      const when = event.allDay ? "all day" : timeLabel(event.startsAt, timezone);
      lines.push(`• ${when}: ${plain(event.title)}`);
    }
  }
  if (blocks.length > 0) {
    lines.push("", "Work you planned:");
    for (const block of blocks) {
      lines.push(
        `• ${timeLabel(block.startsAt, timezone)} to ${timeLabel(block.endsAt, timezone)}: ${plain(block.title ?? "Work block")}`,
      );
    }
  }
  if (overdue.length > 0 || dueToday.length > 0) {
    lines.push("", "Needs attention:");
    for (const task of overdue.slice(0, 5)) {
      lines.push(`• Overdue: ${plain(task.title)} (${dueText(task, timezone)})`);
    }
    for (const task of dueToday.slice(0, 8)) {
      lines.push(`• Due today: ${plain(task.title)} (${dueText(task, timezone, false)})`);
    }
  }

  const upcoming = data.openTasks
    .filter((task) => task.dueAt && !dueToday.includes(task) && !overdue.includes(task))
    .toSorted((a, b) => a.dueAt!.getTime() - b.dueAt!.getTime())
    .slice(0, 3);
  if (upcoming.length > 0) {
    lines.push("", "Coming up:");
    for (const task of upcoming) lines.push(`• ${plain(task.title)} (${dueText(task, timezone)})`);
  }

  if (lines.length === 1)
    lines.push("", "Nothing is due or scheduled today. A good day to get ahead.");
  else lines.push("", "Want me to help plan time for these? Just tell me.");
  const text = lines.join("\n");
  return text.length > MAX_CHARS ? `${text.slice(0, MAX_CHARS - 1)}…` : text;
}
