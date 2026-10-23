import { describe, expect, it } from "vitest";
import {
  computeAvailability,
  findConflicts,
  type FixedEvent,
  type PlannedBlock,
  type PlanningPreferences,
} from "./availability";
import { localParts, localWallToUtc, parseTimeOfDay } from "./time";

const CHICAGO = "America/Chicago";

const at = (date: string, time: string, timezone = CHICAGO) =>
  localWallToUtc(date, parseTimeOfDay(time, { allow24: true }), timezone);

function clock(instant: Date, timezone = CHICAGO): string {
  const p = localParts(instant, timezone);
  return `${String(p.hour).padStart(2, "0")}:${String(p.minute).padStart(2, "0")}`;
}

const workday = [{ start: "09:00", end: "17:00" }];

const preferences: PlanningPreferences = {
  timezone: CHICAGO,
  preferredHours: { mon: workday, tue: workday, wed: workday, thu: workday, fri: workday },
  sleep: { start: "23:00", end: "07:00" },
  meals: [{ start: "12:00", end: "13:00" }],
  bufferMinutes: 15,
  minBlockMinutes: 30,
};

// Wednesday 2026-10-14.
const DAY = "2026-10-14";

const classEvent: FixedEvent = {
  id: "chem",
  title: "Chemistry lecture",
  startsAt: at(DAY, "10:00"),
  endsAt: at(DAY, "11:30"),
  allDay: false,
  timezone: CHICAGO,
  status: "scheduled",
};

function windowsFor(
  overrides: Partial<Parameters<typeof computeAvailability>[0]> = {},
  prefs: PlanningPreferences = preferences,
  range = { from: DAY, to: DAY },
) {
  const result = computeAvailability({
    range,
    events: [],
    workBlocks: [],
    preferences: prefs,
    ...overrides,
  });
  return result.windows.map(
    (w) => `${w.date} ${clock(w.start, prefs.timezone)}-${clock(w.end, prefs.timezone)}`,
  );
}

describe("free windows", () => {
  it("offers only preferred hours minus meals on an empty calendar day", () => {
    expect(windowsFor()).toEqual([`${DAY} 09:00-12:00`, `${DAY} 13:00-17:00`]);
  });

  it("does not treat empty time outside preferred hours as usable", () => {
    // Saturday 2026-10-17 and Sunday have no preferred hours.
    expect(windowsFor({}, preferences, { from: "2026-10-17", to: "2026-10-18" })).toEqual([]);
    expect(windowsFor({}, { ...preferences, preferredHours: {} })).toEqual([]);
  });

  it("subtracts events with buffers and drops windows below the minimum", () => {
    // Event 10:00-11:30 blocks 09:45-11:45; the 11:45-12:00 leftover is under 30 minutes.
    expect(windowsFor({ events: [classEvent] })).toEqual([
      `${DAY} 09:00-09:45`,
      `${DAY} 13:00-17:00`,
    ]);
  });

  it("subtracts travel before and after, then the buffer", () => {
    const event = { ...classEvent, travelBeforeMinutes: 30, travelAfterMinutes: 30 };
    // Blocked 09:15-12:15 (30 travel + 15 buffer each side); the 09:00-09:15 leftover is too short.
    expect(windowsFor({ events: [event] })).toEqual([`${DAY} 13:00-17:00`]);
  });

  it("applies saved default travel but preserves explicit per-event overrides", () => {
    const prefs = { ...preferences, travelBeforeMinutes: 30, travelAfterMinutes: 30 };
    expect(windowsFor({ events: [classEvent] }, prefs)).toEqual([`${DAY} 13:00-17:00`]);
    expect(
      windowsFor(
        {
          events: [{ ...classEvent, travelBeforeMinutes: 0, travelAfterMinutes: 0 }],
        },
        prefs,
      ),
    ).toEqual([`${DAY} 09:00-09:45`, `${DAY} 13:00-17:00`]);
  });

  it("ignores canceled events and removed or completed work blocks", () => {
    const block = (status: PlannedBlock["status"]): PlannedBlock => ({
      id: status,
      startsAt: at(DAY, "14:00"),
      endsAt: at(DAY, "15:00"),
      status,
    });
    expect(
      windowsFor({
        events: [{ ...classEvent, status: "canceled" }],
        workBlocks: [block("removed"), block("completed")],
      }),
    ).toEqual([`${DAY} 09:00-12:00`, `${DAY} 13:00-17:00`]);
  });

  it("subtracts planned work blocks without a buffer", () => {
    const planned: PlannedBlock = {
      id: "wb",
      startsAt: at(DAY, "14:00"),
      endsAt: at(DAY, "15:00"),
      status: "planned",
    };
    expect(windowsFor({ workBlocks: [planned] })).toEqual([
      `${DAY} 09:00-12:00`,
      `${DAY} 13:00-14:00`,
      `${DAY} 15:00-17:00`,
    ]);
  });

  it("subtracts recurring and one-off protected time", () => {
    const gym = {
      label: "Gym",
      weekdays: ["wed" as const],
      window: { start: "15:00", end: "16:00" },
    };
    const call = { label: "Call home", startsAt: at(DAY, "09:00"), endsAt: at(DAY, "10:00") };
    expect(windowsFor({}, { ...preferences, protectedTime: [gym, call] })).toEqual([
      `${DAY} 10:00-12:00`,
      `${DAY} 13:00-15:00`,
      `${DAY} 16:00-17:00`,
    ]);
    // Thursday has no gym.
    expect(
      windowsFor(
        {},
        { ...preferences, protectedTime: [gym] },
        { from: "2026-10-15", to: "2026-10-15" },
      ),
    ).toEqual(["2026-10-15 09:00-12:00", "2026-10-15 13:00-17:00"]);
  });

  it("clips windows to notBefore", () => {
    expect(windowsFor({ notBefore: at(DAY, "10:30") })).toEqual([
      `${DAY} 10:30-12:00`,
      `${DAY} 13:00-17:00`,
    ]);
    expect(windowsFor({ notBefore: at(DAY, "16:50") })).toEqual([]);
  });

  it("treats all-day events as informational unless they block", () => {
    const allDay: FixedEvent = {
      id: "birthday",
      startsAt: at(DAY, "00:00"),
      endsAt: at("2026-10-15", "00:00"),
      allDay: true,
      timezone: CHICAGO,
      status: "scheduled",
    };
    expect(windowsFor({ events: [allDay] })).toEqual([`${DAY} 09:00-12:00`, `${DAY} 13:00-17:00`]);
    expect(windowsFor({ events: [{ ...allDay, blocking: true }] })).toEqual([]);
  });
});

describe("daylight saving and day boundaries", () => {
  const allDayHours = { sun: [{ start: "00:00", end: "24:00" }] };
  const open: PlanningPreferences = {
    timezone: CHICAGO,
    preferredHours: allDayHours,
    bufferMinutes: 0,
    minBlockMinutes: 1,
  };

  it("measures free time across spring-forward and fall-back days", () => {
    const minutes = (date: string) =>
      computeAvailability({
        range: { from: date, to: date },
        events: [],
        workBlocks: [],
        preferences: open,
      }).windows.reduce((total, w) => total + w.minutes, 0);
    expect(minutes("2026-03-08")).toBe(23 * 60);
    expect(minutes("2026-11-01")).toBe(25 * 60);
    expect(minutes("2026-10-18")).toBe(24 * 60);
  });

  it("applies a sleep window that crosses midnight to both sides of the boundary", () => {
    const prefs: PlanningPreferences = {
      timezone: CHICAGO,
      preferredHours: {
        tue: [{ start: "00:00", end: "24:00" }],
        wed: [{ start: "00:00", end: "24:00" }],
      },
      sleep: { start: "23:00", end: "07:00" },
      bufferMinutes: 0,
      minBlockMinutes: 1,
    };
    expect(windowsFor({}, prefs, { from: "2026-10-13", to: "2026-10-14" })).toEqual([
      "2026-10-13 07:00-23:00",
      "2026-10-14 07:00-23:00",
    ]);
  });

  it("keeps an event that runs past midnight from leaking into the next day's start", () => {
    const prefs: PlanningPreferences = {
      timezone: CHICAGO,
      preferredHours: {
        tue: [{ start: "00:00", end: "24:00" }],
        wed: [{ start: "00:00", end: "24:00" }],
      },
      bufferMinutes: 0,
      minBlockMinutes: 1,
    };
    const late: FixedEvent = {
      ...classEvent,
      startsAt: at("2026-10-13", "23:00"),
      endsAt: at(DAY, "01:00"),
    };
    expect(windowsFor({ events: [late] }, prefs, { from: "2026-10-13", to: "2026-10-14" })).toEqual(
      ["2026-10-13 00:00-23:00", "2026-10-14 01:00-00:00"],
    );
  });
});

describe("overnight protected time", () => {
  const prefs: PlanningPreferences = {
    timezone: CHICAGO,
    preferredHours: {
      wed: [{ start: "00:00", end: "24:00" }],
      thu: [{ start: "00:00", end: "24:00" }],
    },
    protectedTime: [
      { label: "Recovery", weekdays: ["wed"], window: { start: "22:00", end: "08:00" } },
    ],
    bufferMinutes: 0,
    minBlockMinutes: 1,
  };

  it("protects the starting evening and following morning, not the starting morning", () => {
    expect(windowsFor({}, prefs, { from: DAY, to: "2026-10-15" })).toEqual([
      `${DAY} 00:00-22:00`,
      "2026-10-15 08:00-00:00",
    ]);
  });

  it("includes protection that started before the requested range", () => {
    expect(windowsFor({}, prefs, { from: "2026-10-15", to: "2026-10-15" })).toEqual([
      "2026-10-15 08:00-00:00",
    ]);
    expect(
      findConflicts(
        { startsAt: at("2026-10-15", "07:00"), endsAt: at("2026-10-15", "08:00") },
        { events: [], workBlocks: [], preferences: prefs },
      ),
    ).toContainEqual({ kind: "protected", label: "Recovery", refId: undefined });
    expect(
      findConflicts(
        { startsAt: at(DAY, "07:00"), endsAt: at(DAY, "08:00") },
        { events: [], workBlocks: [], preferences: prefs },
      ),
    ).toEqual([]);
  });

  it.each([
    ["2026-03-07", "2026-03-08", 9],
    ["2026-10-31", "2026-11-01", 11],
  ])("keeps overnight protection at local wall times across DST on %s", (start, end, hours) => {
    const { blockers } = computeAvailability({
      range: { from: end, to: end },
      events: [],
      workBlocks: [],
      preferences: {
        ...prefs,
        preferredHours: { sun: [{ start: "00:00", end: "24:00" }] },
        protectedTime: [
          { label: "Recovery", weekdays: ["sat"], window: { start: "22:00", end: "08:00" } },
        ],
      },
    });
    const blocker = blockers.find((item) => item.kind === "protected")!;
    expect(new Date(blocker.start)).toEqual(at(start, "22:00"));
    expect(new Date(blocker.end)).toEqual(at(end, "08:00"));
    expect((blocker.end - blocker.start) / 3_600_000).toBe(hours);
  });
});

describe("timezone changes", () => {
  it("keeps a fixed external appointment at the same instant when the owner's timezone changes", () => {
    const chicagoBlockers = computeAvailability({
      range: { from: DAY, to: DAY },
      events: [classEvent],
      workBlocks: [],
      preferences,
    }).blockers.filter((b) => b.kind === "event");
    const losAngeles: PlanningPreferences = { ...preferences, timezone: "America/Los_Angeles" };
    const laBlockers = computeAvailability({
      range: { from: DAY, to: DAY },
      events: [classEvent],
      workBlocks: [],
      preferences: losAngeles,
    }).blockers.filter((b) => b.kind === "event");
    expect(laBlockers).toEqual(chicagoBlockers);
    // 10:00 Chicago is 08:00 in Los Angeles; with the buffer the owner's first free time is 09:45.
    expect(windowsFor({ events: [classEvent] }, losAngeles)[0]).toBe(`${DAY} 09:45-12:00`);
  });

  it("keeps an all-day event on its own timezone's calendar day", () => {
    const tokyoDay: FixedEvent = {
      id: "conference",
      startsAt: at("2026-10-15", "00:00", "Asia/Tokyo"),
      endsAt: at("2026-10-16", "00:00", "Asia/Tokyo"),
      allDay: true,
      timezone: "Asia/Tokyo",
      status: "scheduled",
      blocking: true,
    };
    const { blockers } = computeAvailability({
      range: { from: "2026-10-14", to: "2026-10-15" },
      events: [tokyoDay],
      workBlocks: [],
      preferences,
    });
    const event = blockers.find((b) => b.kind === "event");
    expect(new Date(event!.start).toISOString()).toBe("2026-10-14T15:00:00.000Z");
    expect(new Date(event!.end).toISOString()).toBe("2026-10-15T15:00:00.000Z");
  });
});

describe("conflict detection", () => {
  const input = { events: [classEvent], workBlocks: [] as PlannedBlock[], preferences };
  const proposal = (from: string, to: string, date = DAY) => ({
    startsAt: at(date, from),
    endsAt: at(date, to),
  });

  it("accepts a block that fits inside preferred hours", () => {
    expect(findConflicts(proposal("13:00", "15:00"), input)).toEqual([]);
  });

  it("reports overlap with an event, its buffer, and meals", () => {
    expect(findConflicts(proposal("10:30", "11:00"), input).map((c) => c.kind)).toEqual(["event"]);
    expect(findConflicts(proposal("09:00", "09:50"), input).map((c) => c.kind)).toEqual(["buffer"]);
    expect(findConflicts(proposal("11:50", "12:30"), input).map((c) => c.kind)).toEqual(["meal"]);
  });

  it("reports time outside preferred hours and inside sleep", () => {
    expect(findConflicts(proposal("18:00", "19:00"), input).map((c) => c.kind)).toEqual([
      "outside_preferred_hours",
    ]);
    const kinds = findConflicts(proposal("06:00", "08:00"), input).map((c) => c.kind);
    expect(kinds).toContain("sleep");
    expect(kinds).toContain("outside_preferred_hours");
  });

  it("reports another planned block but ignores the one being rescheduled", () => {
    const planned: PlannedBlock = {
      id: "wb",
      startsAt: at(DAY, "14:00"),
      endsAt: at(DAY, "15:00"),
      status: "planned",
    };
    const withBlock = { ...input, workBlocks: [planned] };
    expect(findConflicts(proposal("14:30", "15:30"), withBlock)).toEqual([
      { kind: "work_block", label: undefined, refId: "wb" },
    ]);
    expect(
      findConflicts(proposal("14:30", "15:30"), { ...withBlock, ignoreBlockId: "wb" }),
    ).toEqual([]);
  });

  it("rejects an invalid proposal and invalid preferences", () => {
    expect(() => findConflicts(proposal("15:00", "15:00"), input)).toThrow(RangeError);
    expect(() =>
      computeAvailability({
        range: { from: DAY, to: DAY },
        events: [],
        workBlocks: [],
        preferences: { ...preferences, bufferMinutes: -1 },
      }),
    ).toThrow(RangeError);
    expect(() =>
      computeAvailability({
        range: { from: DAY, to: DAY },
        events: [],
        workBlocks: [],
        preferences: {
          ...preferences,
          preferredHours: { wed: [{ start: "17:00", end: "09:00" }] },
        },
      }),
    ).toThrow(RangeError);
  });
});
