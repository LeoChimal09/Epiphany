import { describe, expect, it } from "vitest";
import type {
  ActionHistoryEntry,
  CalendarEvent,
  Note,
  Reminder,
  Task,
  WorkBlock,
} from "../db/schema";
import { marker, plain, renderBriefing, renderOverview, type OverviewData } from "./render";

const TZ = "America/Chicago";
// Wed Oct 14 2026, 10:00 in Chicago.
const NOW = new Date("2026-10-14T15:00:00.000Z");
const at = (iso: string) => new Date(iso);

const task = (over: Partial<Task>): Task => ({
  id: "t1",
  ownerId: "o",
  categoryId: "inbox",
  title: "Task",
  details: null,
  sourceText: null,
  sourceRef: null,
  reviewNote: null,
  dueAt: null,
  dueDateOnly: false,
  estimatedMinutes: null,
  remainingMinutes: null,
  status: "open",
  completedAt: null,
  archivedAt: null,
  version: 1,
  createdAt: at("2026-10-01T00:00:00.000Z"),
  updatedAt: at("2026-10-01T00:00:00.000Z"),
  ...over,
});
const event = (over: Partial<CalendarEvent>): CalendarEvent => ({
  id: "e1",
  ownerId: "o",
  title: "Event",
  location: null,
  startsAt: at("2026-10-14T20:00:00.000Z"),
  endsAt: at("2026-10-14T21:30:00.000Z"),
  allDay: false,
  timezone: TZ,
  status: "scheduled",
  canceledAt: null,
  version: 1,
  createdAt: NOW,
  updatedAt: NOW,
  ...over,
});
const block = (over: Partial<WorkBlock>): WorkBlock =>
  ({
    id: "b1",
    ownerId: "o",
    taskId: null,
    title: "Study",
    startsAt: at("2026-10-14T22:00:00.000Z"),
    endsAt: at("2026-10-14T23:00:00.000Z"),
    status: "planned",
    ...over,
  }) as WorkBlock;
const note = (over: Partial<Note>): Note => ({
  id: "n1",
  ownerId: "o",
  categoryId: "inbox",
  kind: "note",
  title: "A note",
  body: "body",
  sourceRef: null,
  archivedAt: null,
  version: 1,
  createdAt: at("2026-10-10T00:00:00.000Z"),
  updatedAt: NOW,
  ...over,
});
const entry = (over: Partial<ActionHistoryEntry>): ActionHistoryEntry => ({
  id: "h1",
  ownerId: "o",
  source: "dashboard",
  action: "task.complete",
  entityType: "task",
  entityId: "t1",
  before: null,
  after: null,
  undoOfId: null,
  createdAt: at("2026-10-14T14:05:00.000Z"),
  ...over,
});

const data = (over: Partial<OverviewData> = {}): OverviewData => ({
  now: NOW,
  timezone: TZ,
  openTasks: [],
  knownTasks: [],
  notes: [],
  events: [],
  blocks: [],
  history: [],
  reminders: [],
  categoryNames: new Map([["inbox", "Inbox"]]),
  ...over,
});

describe("overview rendering", () => {
  it("shows overdue, due-today, events and planned work for today, in the owner's timezone", () => {
    const text = renderOverview(
      "today",
      data({
        openTasks: [
          task({ id: "a", title: "Late essay", dueAt: at("2026-10-12T04:59:00.000Z") }),
          task({ id: "b", title: "Chem lab", dueAt: at("2026-10-15T04:59:00.000Z") }),
          task({
            id: "c",
            title: "Quiz prep",
            dueAt: at("2026-10-14T00:00:00.000Z"),
            dueDateOnly: true,
            reviewNote: "check",
          }),
          task({ id: "d", title: "Next week", dueAt: at("2026-10-21T04:59:00.000Z") }),
        ],
        events: [event({ title: "Lab" })],
        blocks: [block({ title: "Chem lab" })],
      }),
    );
    expect(text).toContain("**Today · Wed, Oct 14**");
    expect(text).toContain("__Overdue__\n• Late essay (due Sun, Oct 11, 11:59 PM)");
    expect(text).toContain("__Due today__");
    expect(text).toContain("• Chem lab (11:59 PM)");
    expect(text).toContain("• Quiz prep (all day) ⚠ needs review");
    expect(text).not.toContain("Next week");
    expect(text).toContain("• Lab (3:00 PM to 4:30 PM)");
    expect(text).toContain("• Chem lab (5:00 PM to 6:00 PM)");
    expect(text.endsWith(marker("today"))).toBe(true);
  });

  it("ignores canceled events and removed work blocks, and says so when the day is empty", () => {
    const text = renderOverview(
      "today",
      data({
        events: [event({ status: "canceled" })],
        blocks: [block({ status: "removed" })],
      }),
    );
    expect(text).toContain("Nothing due or scheduled today.");
    expect(text).not.toContain("Event");
  });

  it("groups the next seven days by date and leaves out days outside the window", () => {
    const text = renderOverview(
      "schedule",
      data({
        openTasks: [
          task({ id: "a", title: "Chem lab", dueAt: at("2026-10-16T22:00:00.000Z") }),
          task({ id: "z", title: "Far away", dueAt: at("2026-11-30T22:00:00.000Z") }),
        ],
        events: [
          event({
            title: "Lab",
            startsAt: at("2026-10-16T15:00:00.000Z"),
            endsAt: at("2026-10-16T16:00:00.000Z"),
          }),
        ],
        blocks: [
          block({
            title: "Study",
            startsAt: at("2026-10-15T20:00:00.000Z"),
            endsAt: at("2026-10-15T21:00:00.000Z"),
          }),
        ],
      }),
    );
    expect(text.indexOf("__Thu, Oct 15__")).toBeLessThan(text.indexOf("__Fri, Oct 16__"));
    expect(text).toContain("3:00 PM: work on Study");
    expect(text).toContain("10:00 AM: Lab");
    expect(text).toContain("Due: Chem lab (5:00 PM)");
    expect(text).not.toContain("Far away");
    expect(renderOverview("schedule", data())).toContain("Nothing scheduled in the next 7 days.");
  });

  it("ranks priorities by deadline with countdowns, undated last, capped at ten", () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      task({
        id: `x${i}`,
        title: `Task ${i}`,
        dueAt: at(`2026-10-${String(20 + (i % 5)).padStart(2, "0")}T12:00:00.000Z`),
      }),
    );
    const text = renderOverview(
      "priorities",
      data({
        openTasks: [
          task({ id: "u", title: "Whenever" }),
          task({ id: "o", title: "Overdue one", dueAt: at("2026-10-12T04:59:00.000Z") }),
          task({ id: "t", title: "Today one", dueAt: at("2026-10-15T04:59:00.000Z") }),
          ...many,
        ],
        categoryNames: new Map([
          ["inbox", "Inbox"],
          ["school", "School"],
        ]),
      }),
    );
    expect(text).toContain("Priorities · 15 open");
    expect(text).toContain("1. Overdue one (due Sun, Oct 11, 11:59 PM, 3d overdue)");
    expect(text).toContain("2. Today one (due Wed, Oct 14, 11:59 PM, today)");
    expect(text).not.toContain("Whenever");
    expect(text).toContain("…and 5 more open tasks");
  });

  it("lists recent notes and ideas, newest first", () => {
    const text = renderOverview(
      "notes-and-ideas",
      data({
        notes: [
          note({ id: "1", title: "Old", createdAt: at("2026-10-01T00:00:00.000Z") }),
          note({
            id: "2",
            title: null,
            body: "Habit tracker app idea",
            kind: "idea",
            createdAt: at("2026-10-12T00:00:00.000Z"),
          }),
        ],
      }),
    );
    expect(text.indexOf("Habit tracker")).toBeLessThan(text.indexOf("Old"));
    expect(text).toContain("(idea)");
    expect(renderOverview("notes-and-ideas", data())).toContain("No notes or ideas saved yet.");
  });

  it("describes activity with names and sources, skipping internal entries", () => {
    const text = renderOverview(
      "activity-log",
      data({
        knownTasks: [task({ id: "t1", title: "Chem lab" })],
        history: [
          entry({ action: "task.complete", source: "discord" }),
          entry({ id: "h2", action: "task.update", after: { fields: ["categoryId"] } }),
          entry({ id: "h3", action: "owner.create", entityType: "owner" }),
          entry({ id: "h4", action: "auth.dev_bypass_sign_in", entityType: "owner" }),
        ],
      }),
    );
    expect(text).toContain('Completed "Chem lab" (discord)');
    expect(text).toContain('Moved "Chem lab" (dashboard)');
    expect(text).not.toContain("owner");
    expect(text).toContain("Wed, Oct 14 9:05 AM");
  });

  it("shows upcoming reminders, and any that did not reach the owner", () => {
    const reminder = (over: Partial<Reminder>): Reminder =>
      ({
        id: "r1",
        kind: "task_deadline",
        message: 'Heads up: "Chem lab" is due tomorrow.',
        dueAt: at("2026-10-15T22:00:00.000Z"),
        status: "scheduled",
        detail: null,
        ...over,
      }) as Reminder;
    const text = renderOverview(
      "check-ins",
      data({
        reminders: [
          reminder({}),
          reminder({
            id: "r2",
            status: "failed",
            dueAt: at("2026-10-13T22:00:00.000Z"),
            detail: "could not deliver: Discord DMs are closed or blocked",
          }),
          reminder({ id: "r3", status: "sent", message: "Already sent" }),
          reminder({
            id: "r4",
            status: "failed",
            dueAt: at("2026-09-01T22:00:00.000Z"),
            message: "Ancient",
          }),
        ],
      }),
    );
    expect(text).toContain("__Coming up__\n• Thu, Oct 15 5:00 PM: Heads up");
    expect(text).toContain("__Didn't reach you__");
    expect(text).toContain("DMs are closed or blocked");
    expect(text).not.toContain("Already sent");
    expect(text).not.toContain("Ancient");
    expect(renderOverview("check-ins", data())).toContain("No reminders scheduled.");
  });

  it("writes a morning briefing from today's records, without channel markers", () => {
    const text = renderBriefing(
      data({
        openTasks: [
          task({ id: "a", title: "Late essay", dueAt: at("2026-10-12T04:59:00.000Z") }),
          task({ id: "b", title: "Chem lab", dueAt: at("2026-10-15T04:59:00.000Z") }),
          task({ id: "c", title: "Next week", dueAt: at("2026-10-21T04:59:00.000Z") }),
        ],
        events: [event({ title: "Lab" })],
        blocks: [block({ title: "Study" })],
      }),
    );
    expect(text).toContain("Good morning! Here's Wed, Oct 14.");
    expect(text).toContain("• 3:00 PM: Lab");
    expect(text).toContain("• 5:00 PM to 6:00 PM: Study");
    expect(text).toContain("• Overdue: Late essay");
    expect(text).toContain("• Due today: Chem lab (11:59 PM)");
    expect(text).toContain("Coming up:\n• Next week");
    expect(text).not.toContain("epi:");
    expect(renderBriefing(data())).toContain("Nothing is due or scheduled today.");
  });

  it("defuses mentions and markdown in titles, so a task can never ping anyone", () => {
    expect(plain("@everyone **read** <#123> `x`")).toBe(
      "@\u200beveryone \\*\\*read\\*\\* <\\#123\\> \\`x\\`",
    );
    const text = renderOverview(
      "priorities",
      data({ openTasks: [task({ title: "@everyone and @here\nsecond line" })] }),
    );
    expect(text).not.toMatch(/@(everyone|here)/);
  });

  it("stays under Discord's limit and says how much it left out", () => {
    const openTasks = Array.from({ length: 100 }, (_, i) =>
      task({
        id: `t${i}`,
        title: `A fairly long task title number ${i} ${"x".repeat(60)}`,
        dueAt: at("2026-10-14T20:00:00.000Z"),
      }),
    );
    const text = renderOverview("today", data({ openTasks }));
    expect(text.length).toBeLessThanOrEqual(2000);
    expect(text).toContain("more lines (see the dashboard)");
    expect(text.endsWith(marker("today"))).toBe(true);
  });

  it("is deterministic: the same records always give the same message", () => {
    const input = data({
      openTasks: [task({ title: "Same", dueAt: at("2026-10-15T04:59:00.000Z") })],
    });
    expect(renderOverview("priorities", input)).toBe(renderOverview("priorities", input));
    expect(renderOverview("today", input)).toBe(
      renderOverview("today", { ...input, now: new Date(NOW.getTime() + 60_000) }),
    );
  });
});
