import { describe, expect, it } from "vitest";
import { localWallToUtc, parseTimeOfDay, type PlanningPreferences } from "@epiphany/core/planning";
import type { ScheduleData } from "./schedule";
import type { DashboardTask } from "./model";
import { preparationHints, scheduleAvailability } from "./planning-model";

const TZ = "America/Chicago";
const DAY = "2026-10-22";
const at = (time: string) => localWallToUtc(DAY, parseTimeOfDay(time, { allow24: true }), TZ);
const preferences: PlanningPreferences = {
  timezone: TZ,
  preferredHours: { thu: [{ start: "09:00", end: "17:00" }] },
  meals: [{ start: "12:00", end: "13:00" }],
  bufferMinutes: 15,
  minBlockMinutes: 30,
};
const schedule: ScheduleData = {
  weekStart: "2026-10-19",
  truncated: false,
  blocks: [],
  planningPreferences: preferences,
  events: [
    {
      id: "lecture",
      title: "Lecture",
      location: null,
      startsAt: at("10:00").toISOString(),
      endsAt: at("11:00").toISOString(),
      allDay: false,
      timezone: TZ,
    },
  ],
};
const task: DashboardTask = {
  id: "task",
  title: "Homework",
  categoryId: "inbox",
  details: null,
  sourceText: null,
  reviewNote: null,
  status: "open",
  dueAt: at("17:00").toISOString(),
  dueDateOnly: false,
  estimatedMinutes: 60,
  completedAt: null,
  archivedAt: null,
  createdAt: at("08:00").toISOString(),
  version: 1,
};
const hints = (tasks: DashboardTask[] = [task], data = schedule, now = at("09:00")) =>
  preparationHints(tasks, data, scheduleAvailability(data, DAY, DAY, now)!, TZ, DAY, DAY, now);

describe("dashboard planning", () => {
  it("subtracts appointments, buffers and meals and never offers past time", () => {
    const windows = scheduleAvailability(schedule, DAY, DAY, at("11:30"))!;
    expect(windows.map((w) => [w.start.toISOString(), w.end.toISOString()])).toEqual([
      [at("11:30").toISOString(), at("12:00").toISOString()],
      [at("13:00").toISOString(), at("17:00").toISOString()],
    ]);
  });
  it("withholds free-time claims when calendar data is incomplete or preferences absent", () => {
    expect(
      scheduleAvailability({ ...schedule, truncated: true }, DAY, DAY, at("09:00")),
    ).toBeNull();
    expect(
      scheduleAvailability({ ...schedule, planningPreferences: undefined }, DAY, DAY, at("09:00")),
    ).toBeNull();
  });
  it("gives a latest preparation start before the exact timed deadline without mutation", () => {
    const before = JSON.stringify(schedule);
    expect(hints()[0]).toMatchObject({
      state: "prepare",
      remainingMinutes: 60,
      startBy: at("16:00"),
    });
    expect(hints([{ ...task, dueAt: at("14:00").toISOString() }])[0]?.startBy).toEqual(at("13:00"));
    expect(JSON.stringify(schedule)).toBe(before);
  });
  it("uses end of the local day for date-only deadlines", () => {
    expect(
      hints([{ ...task, dueAt: at("00:00").toISOString(), dueDateOnly: true }])[0]?.state,
    ).toBe("prepare");
  });
  it("does not count work blocks after the deadline or elapsed work as upcoming effort", () => {
    const data = {
      ...schedule,
      blocks: [
        {
          id: "past",
          title: "Study",
          taskId: task.id,
          startsAt: at("07:00").toISOString(),
          endsAt: at("08:00").toISOString(),
        },
        {
          id: "late",
          title: "Study",
          taskId: task.id,
          startsAt: at("18:00").toISOString(),
          endsAt: at("19:00").toISOString(),
        },
      ],
    };
    expect(hints([task], data)[0]?.remainingMinutes).toBe(60);
  });
  it("counts only the part of a block still ahead of now and before the deadline", () => {
    const data = {
      ...schedule,
      planningPreferences: {
        ...preferences,
        preferredHours: { thu: [{ start: "09:00", end: "18:00" }] },
      },
      blocks: [
        {
          id: "work",
          title: "Study",
          taskId: task.id,
          startsAt: at("16:30").toISOString(),
          endsAt: at("17:30").toISOString(),
        },
      ],
    };
    expect(hints([task], data)[0]).toMatchObject({ remainingMinutes: 30, startBy: at("16:00") });
  });
  it("requires conflicting work blocks to be reviewed rather than claiming effort is covered", () => {
    const data = {
      ...schedule,
      blocks: [
        {
          id: "one",
          title: "Study",
          taskId: task.id,
          startsAt: at("13:00").toISOString(),
          endsAt: at("14:00").toISOString(),
        },
        {
          id: "two",
          title: "Study",
          taskId: task.id,
          startsAt: at("13:00").toISOString(),
          endsAt: at("14:00").toISOString(),
        },
      ],
    };
    expect(hints([{ ...task, estimatedMinutes: 90 }], data)[0]).toMatchObject({
      state: "conflict",
    });
  });
  it("uses a half-hour default while distinguishing overdue, covered and insufficient preparation", () => {
    expect(hints([{ ...task, dueAt: at("08:00").toISOString() }])[0]?.state).toBe("overdue");
    expect(hints([{ ...task, estimatedMinutes: null }])[0]).toMatchObject({
      state: "prepare",
      remainingMinutes: 30,
      assumedDuration: true,
      startBy: at("16:30"),
    });
    expect(hints()[0]).toMatchObject({ remainingMinutes: 60, assumedDuration: false });
    expect(hints([{ ...task, estimatedMinutes: 600 }])[0]?.state).toBe("insufficient");
    const covered = {
      ...schedule,
      blocks: [
        {
          id: "work",
          title: "Study",
          taskId: task.id,
          startsAt: at("13:00").toISOString(),
          endsAt: at("14:00").toISOString(),
        },
      ],
    };
    expect(hints([task], covered)[0]?.state).toBe("covered");
  });
  it("ignores completed, archived, undated and out-of-range tasks and caps hints", () => {
    expect(
      hints([
        { ...task, status: "completed" },
        { ...task, archivedAt: at("09:00").toISOString() },
        { ...task, dueAt: null },
        { ...task, dueAt: "2026-11-01T15:00:00Z" },
      ]),
    ).toEqual([]);
    expect(
      hints(Array.from({ length: 12 }, (_, i) => ({ ...task, id: `task-${i}` }))),
    ).toHaveLength(10);
  });
});
