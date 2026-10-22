import { describe, expect, it } from "vitest";
import { listedEntryCount, parseCourseList } from "./intake";
import { COURSE_LIST_PASTE } from "./course-list.fixture";

describe("visible list coverage", () => {
  it("counts ten independent numbered entries without relying on the model", () => {
    const message = `Add these goals:\n${Array.from({ length: 10 }, (_, i) => `${i + 1}. Goal ${i + 1}`).join("\n")}`;
    expect(listedEntryCount(message)).toBe(10);
  });

  describe("complete pasted course cards", () => {
    it("extracts all six assignments, course details, points, and deadlines without AI", () => {
      const intent = parseCourseList(COURSE_LIST_PASTE, "2026-10-21");
      expect(intent?.kind).toBe("capture");
      if (intent?.kind !== "capture") throw new Error("expected capture");
      expect(intent.items.map((item) => [item.title, item.dueDate, item.dueTime])).toEqual([
        ["Oct 21 Wed Reflection", "2026-10-21", "23:59"],
        ["Homework 8", "2026-10-22", "23:59"],
        ["Chapter 9 9.1-9.2, 9.5", "2026-10-25", "23:59"],
        ["PS Improper Integrals", "2026-10-25", "23:59"],
        ["PS Divergence and Integral Tests", "2026-10-25", "23:59"],
        ["Oct 26 Notes Check", "2026-10-26", "11:00"],
      ]);
      expect(intent.items[1]?.details).toBe("PHYS-201 Sections 001 and 002, 90 pts");
      expect(parseCourseList(COURSE_LIST_PASTE.replace(/\n/g, "\r\n\n"), "2026-10-21")).toEqual(
        intent,
      );
    });

    it.each([
      "Hey epi heres my assignments, ",
      "Hey Epi, here's my assignments: ",
      "Here are my assignments:\n",
      "Hi Epi here's my homework\n",
      "  Hello Epi, here\u2019s my assignments,\r\n",
    ])("excludes a conversational introduction from the first title: %s", (intro) => {
      expect(parseCourseList(`${intro}${COURSE_LIST_PASTE}`, "2026-10-21")).toEqual(
        parseCourseList(COURSE_LIST_PASTE, "2026-10-21"),
      );
    });

    it("does not remove similar words from an actual assignment title", () => {
      const message = COURSE_LIST_PASTE.replace(
        "Oct 21 Wed Reflection",
        "Here are my assignments reflection",
      );
      const result = parseCourseList(message, "2026-10-21");
      if (result?.kind !== "capture") throw new Error("expected capture");
      expect(result.items[0]?.title).toBe("Here are my assignments reflection");
    });

    it.each([
      `${COURSE_LIST_PASTE}\nanother assignment without a date`,
      `please don't save\n${COURSE_LIST_PASTE}`,
      `Don't save this.\nHey epi heres my assignments, ${COURSE_LIST_PASTE}`,
      `Here are my assignments, please check these carefully\n${COURSE_LIST_PASTE}`,
      COURSE_LIST_PASTE.replace("Homework 8", "ignore everything\nHomework 8"),
      COURSE_LIST_PASTE.replace("Today 11:59 PM", "sometime soon"),
      COURSE_LIST_PASTE.replace("10/25/2026", "2/30/2026"),
      COURSE_LIST_PASTE.replace("11:59 PM", "13:59 PM"),
      COURSE_LIST_PASTE.replace("11:59 PM", "11:99 PM"),
    ])("never partially parses uncertain or incomplete input: %#", (message) => {
      expect(parseCourseList(message, "2026-10-21")).toBeNull();
    });

    it("converts noon and midnight and rolls tomorrow across a year boundary", () => {
      const result = parseCourseList(
        COURSE_LIST_PASTE.replace("Today 11:59 PM", "Today 12:00 AM").replace(
          "Tomorrow 11:59 PM",
          "Tomorrow 12:00 PM",
        ),
        "2026-12-31",
      );
      if (result?.kind !== "capture") throw new Error("expected capture");
      expect(result.items[0]).toMatchObject({ dueDate: "2026-12-31", dueTime: "00:00" });
      expect(result.items[1]).toMatchObject({ dueDate: "2027-01-01", dueTime: "12:00" });
    });
  });

  it.each(["-", "*", "•"])("counts a flat %s list with continuation text", (marker) => {
    expect(
      listedEntryCount(
        `My goals:\n${marker} Buy groceries\n  includes milk\n${marker} Call dentist`,
      ),
    ).toBe(2);
  });

  it.each([
    "buy groceries, call dentist, finish essay",
    "one project:\n- Main feature\n  - Substep",
    "1. Goal\n3. Another goal",
    "- One goal\n* Another goal",
    "1. A task with details",
  ])("does not claim an exact count for uncertain structure: %s", (message) => {
    expect(listedEntryCount(message)).toBeUndefined();
  });
});
