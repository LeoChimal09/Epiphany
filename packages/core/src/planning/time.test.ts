import { describe, expect, it } from "vitest";
import {
  addDays,
  dateKeyOf,
  daysBetween,
  localParts,
  localWallToUtc,
  parseDateKey,
  parseTimeOfDay,
  weekdayOf,
  zoneOffsetMs,
} from "./time";

const CHICAGO = "America/Chicago";
const HOUR = 3_600_000;

describe("zone-aware wall time", () => {
  it("converts local times using the offset in force on that date", () => {
    expect(localWallToUtc("2026-10-14", 9 * 60, CHICAGO).toISOString()).toBe(
      "2026-10-14T14:00:00.000Z",
    );
    expect(localWallToUtc("2026-01-15", 9 * 60, CHICAGO).toISOString()).toBe(
      "2026-01-15T15:00:00.000Z",
    );
  });

  it("moves a time skipped by spring-forward ahead by the gap", () => {
    // 02:30 on 2026-03-08 does not exist in Chicago.
    expect(localWallToUtc("2026-03-08", 2 * 60 + 30, CHICAGO).toISOString()).toBe(
      "2026-03-08T08:30:00.000Z",
    );
  });

  it("uses the first occurrence of a repeated fall-back time", () => {
    // 01:30 on 2026-11-01 happens twice in Chicago; the first is still daylight time.
    expect(localWallToUtc("2026-11-01", 60 + 30, CHICAGO).toISOString()).toBe(
      "2026-11-01T06:30:00.000Z",
    );
  });

  it("measures daylight-saving days as 23 and 25 hours", () => {
    const length = (date: string) =>
      localWallToUtc(addDays(date, 1), 0, CHICAGO).getTime() -
      localWallToUtc(date, 0, CHICAGO).getTime();
    expect(length("2026-03-08")).toBe(23 * HOUR);
    expect(length("2026-11-01")).toBe(25 * HOUR);
    expect(length("2026-10-14")).toBe(24 * HOUR);
  });

  it("reads local parts and date keys at day boundaries", () => {
    const instant = new Date("2026-10-15T04:59:00Z");
    expect(dateKeyOf(instant, CHICAGO)).toBe("2026-10-14");
    expect(dateKeyOf(new Date("2026-10-15T05:00:00Z"), CHICAGO)).toBe("2026-10-15");
    expect(localParts(new Date("2026-10-15T05:00:00Z"), CHICAGO).hour).toBe(0);
    expect(zoneOffsetMs(instant.getTime(), CHICAGO)).toBe(-5 * HOUR);
  });
});

describe("calendar dates", () => {
  it("does date arithmetic without timezone effects", () => {
    expect(addDays("2026-02-27", 2)).toBe("2026-03-01");
    expect(addDays("2026-01-01", -1)).toBe("2025-12-31");
    expect(daysBetween("2026-03-07", "2026-03-09")).toBe(2);
    expect(weekdayOf("2026-10-14")).toBe("wed");
  });

  it("rejects invalid dates and times", () => {
    expect(() => parseDateKey("2026-02-30")).toThrow(RangeError);
    expect(() => parseDateKey("10/14/2026")).toThrow(RangeError);
    expect(() => parseTimeOfDay("25:00")).toThrow(RangeError);
    expect(() => parseTimeOfDay("24:00")).toThrow(RangeError);
    expect(parseTimeOfDay("24:00", { allow24: true })).toBe(1440);
  });
});
