import { describe, expect, it } from "vitest";
import {
  expandSeries,
  moveOccurrence,
  occurrenceDates,
  skipOccurrence,
  splitSeriesFrom,
  validateSeries,
  type EventSeries,
} from "./recurrence";
import { localWallToUtc } from "./time";

const CHICAGO = "America/Chicago";

const monWedFri: EventSeries = {
  id: "algebra",
  title: "Algebra class",
  timezone: CHICAGO,
  startDate: "2026-10-12",
  startTime: "09:00",
  durationMinutes: 50,
  frequency: "weekly",
  interval: 1,
  weekdays: ["mon", "wed", "fri"],
  exceptions: [],
};

const range = (from: string, to: string) =>
  [localWallToUtc(from, 0, CHICAGO), localWallToUtc(to, 0, CHICAGO)] as const;

describe("series expansion", () => {
  it("expands weekly weekdays with stable ids and durations", () => {
    const events = expandSeries(monWedFri, ...range("2026-10-12", "2026-10-20"));
    expect(events.map((event) => event.id)).toEqual([
      "algebra@2026-10-12",
      "algebra@2026-10-14",
      "algebra@2026-10-16",
      "algebra@2026-10-19",
    ]);
    expect(events[0]?.startsAt.toISOString()).toBe("2026-10-12T14:00:00.000Z");
    const [first] = events;
    expect(first!.endsAt.getTime() - first!.startsAt.getTime()).toBe(50 * 60_000);
  });

  it("keeps the local wall time across a daylight-saving change", () => {
    const daily: EventSeries = {
      ...monWedFri,
      frequency: "daily",
      weekdays: undefined,
      startDate: "2026-10-30",
    };
    const events = expandSeries(daily, ...range("2026-10-30", "2026-11-03"));
    expect(events.map((event) => event.startsAt.toISOString())).toEqual([
      "2026-10-30T14:00:00.000Z",
      "2026-10-31T14:00:00.000Z",
      "2026-11-01T15:00:00.000Z",
      "2026-11-02T15:00:00.000Z",
    ]);
  });

  it("honors interval, until, and count", () => {
    const biweekly: EventSeries = { ...monWedFri, interval: 2, weekdays: ["mon"] };
    expect(occurrenceDates(biweekly, "2026-10-01", "2026-11-15")).toEqual([
      "2026-10-12",
      "2026-10-26",
      "2026-11-09",
    ]);
    expect(
      occurrenceDates({ ...monWedFri, until: "2026-10-14" }, "2026-10-01", "2026-12-31"),
    ).toEqual(["2026-10-12", "2026-10-14"]);
    const limited: EventSeries = { ...monWedFri, frequency: "daily", count: 3 };
    expect(occurrenceDates(limited, "2026-10-01", "2026-12-31")).toEqual([
      "2026-10-12",
      "2026-10-13",
      "2026-10-14",
    ]);
  });

  it("defaults a weekly series to the start date's weekday", () => {
    const single: EventSeries = { ...monWedFri, weekdays: undefined };
    expect(occurrenceDates(single, "2026-10-12", "2026-10-30")).toEqual([
      "2026-10-12",
      "2026-10-19",
      "2026-10-26",
    ]);
  });

  it("rejects malformed rules", () => {
    expect(() => validateSeries({ ...monWedFri, interval: 0 })).toThrow(RangeError);
    expect(() => validateSeries({ ...monWedFri, durationMinutes: 0 })).toThrow(RangeError);
    expect(() => validateSeries({ ...monWedFri, startTime: "9am" })).toThrow(RangeError);
    expect(() => validateSeries({ ...monWedFri, until: "2026-10-01" })).toThrow(RangeError);
  });
});

describe("occurrence scope", () => {
  it("skips one occurrence and leaves the rule and other days alone", () => {
    const skipped = skipOccurrence(monWedFri, "2026-10-14");
    const events = expandSeries(skipped, ...range("2026-10-12", "2026-10-17"));
    expect(events.map((event) => event.id)).toEqual(["algebra@2026-10-12", "algebra@2026-10-16"]);
    expect(monWedFri.exceptions).toEqual([]);
    expect(skipped.frequency).toBe("weekly");
  });

  it("moves one occurrence to a new time", () => {
    const start = localWallToUtc("2026-10-14", 15 * 60, CHICAGO);
    const moved = moveOccurrence(
      monWedFri,
      "2026-10-14",
      start,
      new Date(start.getTime() + 3_600_000),
    );
    const events = expandSeries(moved, ...range("2026-10-14", "2026-10-15"));
    expect(events).toHaveLength(1);
    expect(events[0]?.startsAt.toISOString()).toBe("2026-10-14T20:00:00.000Z");
  });

  it("keeps an occurrence moved out of its original day", () => {
    const start = localWallToUtc("2026-10-20", 9 * 60, CHICAGO);
    const moved = moveOccurrence(
      monWedFri,
      "2026-10-14",
      start,
      new Date(start.getTime() + 3_600_000),
    );
    expect(expandSeries(moved, ...range("2026-10-20", "2026-10-21")).map((e) => e.id)).toEqual([
      "algebra@2026-10-14",
    ]);
    expect(expandSeries(moved, ...range("2026-10-14", "2026-10-15"))).toEqual([]);
  });

  it("refuses to change a date that is not an occurrence", () => {
    expect(() => skipOccurrence(monWedFri, "2026-10-13")).toThrow(RangeError);
    expect(() => moveOccurrence(monWedFri, "2026-10-13", new Date(0), new Date(1))).toThrow(
      RangeError,
    );
  });
});

describe("this-and-following scope", () => {
  it("ends the old series and starts a changed one", () => {
    const { earlier, following } = splitSeriesFrom(monWedFri, "2026-10-14", "algebra-2", {
      startTime: "10:00",
    });
    expect(earlier?.until).toBe("2026-10-13");
    expect(occurrenceDates(earlier!, "2026-10-01", "2026-11-30")).toEqual(["2026-10-12"]);
    expect(following.id).toBe("algebra-2");
    expect(following.startDate).toBe("2026-10-14");
    const events = expandSeries(following, ...range("2026-10-14", "2026-10-17"));
    expect(events.map((event) => event.startsAt.toISOString())).toEqual([
      "2026-10-14T15:00:00.000Z",
      "2026-10-16T15:00:00.000Z",
    ]);
  });

  it("splits a counted series without losing or repeating occurrences", () => {
    const counted: EventSeries = {
      ...monWedFri,
      frequency: "daily",
      weekdays: undefined,
      count: 5,
    };
    const { earlier, following } = splitSeriesFrom(counted, "2026-10-14", "later", {});
    expect(occurrenceDates(earlier!, "2026-10-01", "2026-12-01")).toEqual([
      "2026-10-12",
      "2026-10-13",
    ]);
    expect(occurrenceDates(following, "2026-10-01", "2026-12-01")).toEqual([
      "2026-10-14",
      "2026-10-15",
      "2026-10-16",
    ]);
  });

  it("returns no earlier series when the split is at the start", () => {
    const { earlier, following } = splitSeriesFrom(monWedFri, "2026-10-12", "all", {
      durationMinutes: 75,
    });
    expect(earlier).toBeNull();
    expect(following.durationMinutes).toBe(75);
  });

  it("keeps the phase of an every-other-week series and carries later exceptions", () => {
    const biweekly: EventSeries = {
      ...monWedFri,
      interval: 2,
      weekdays: ["mon"],
      exceptions: [
        { date: "2026-10-12", kind: "skipped" },
        { date: "2026-11-09", kind: "skipped" },
      ],
    };
    const { earlier, following } = splitSeriesFrom(biweekly, "2026-10-20", "later", {
      startTime: "11:00",
    });
    expect(following.startDate).toBe("2026-10-26");
    expect(occurrenceDates(following, "2026-10-20", "2026-11-30")).toEqual([
      "2026-10-26",
      "2026-11-09",
      "2026-11-23",
    ]);
    expect(following.exceptions).toEqual([{ date: "2026-11-09", kind: "skipped" }]);
    expect(earlier?.exceptions).toEqual([{ date: "2026-10-12", kind: "skipped" }]);
  });
});
