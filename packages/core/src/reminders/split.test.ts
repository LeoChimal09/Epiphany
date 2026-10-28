import { describe, expect, it } from "vitest";
import { DEFAULT_REMINDER_SETTINGS, parseReminderSettings } from "./policy";
import { localWallToUtc } from "../planning/time";
import { splitReminderTimes, splitReminderWindow } from "./split";
import type { Preference } from "../db/schema";

const TZ = "America/Chicago";
const local = (day: string, hour: number, minute = 0) =>
  localWallToUtc(day, hour * 60 + minute, TZ);
const day = "2026-10-28";
const settings = {
  ...DEFAULT_REMINDER_SETTINGS,
  routines: { ...DEFAULT_REMINDER_SETTINGS.routines, bedtime: "21:00" },
};

describe("split-day reminder windows", () => {
  it("places two extra alerts halfway and three-quarters before bedtime, not the midnight deadline", () => {
    const window = splitReminderWindow(local(day, 23, 59), local(day, 7), TZ, settings)!;
    expect(window).toEqual({ start: local(day, 8), end: local(day, 21) });
    expect(splitReminderTimes(window.start, window.end, 2)).toEqual([
      local(day, 14, 30),
      local(day, 17, 45),
    ]);
  });

  it("supports five reminders instead of a fixed two-or-three choice", () => {
    const times = splitReminderTimes(local(day, 8), local(day, 22), 5);
    expect(times).toEqual([12, 14, 16, 18, 20].map((hour) => local(day, hour)));
  });

  it("uses an earlier deadline and starts late-created tasks at creation without moving on each sync", () => {
    const window = splitReminderWindow(local(day, 18), local(day, 12), TZ, settings)!;
    expect(splitReminderTimes(window.start, window.end, 2)).toEqual([
      local(day, 15),
      local(day, 16, 30),
    ]);
  });

  it("uses the preceding awake day for early-morning deadlines", () => {
    const window = splitReminderWindow(local(day, 6), local("2026-10-27", 7), TZ, settings)!;
    expect(window).toEqual({ start: local("2026-10-27", 8), end: local("2026-10-27", 21) });
    expect(splitReminderWindow(local(day, 6), local(day, 1), TZ, settings)).toBeNull();
  });

  it("honors sleep and quiet hours, even when the briefing is inside them", () => {
    const changed = {
      ...DEFAULT_REMINDER_SETTINGS,
      sleepHours: { start: "20:00", end: "09:00" },
    };
    expect(splitReminderWindow(local(day, 23, 59), local(day, 6), TZ, changed)).toEqual({
      start: local(day, 9),
      end: local(day, 20),
    });
  });

  it("uses 8 AM when briefing delivery is off and deduplicates minute-sized slots", () => {
    const window = splitReminderWindow(local(day, 8, 2), local(day, 7), TZ, {
      ...settings,
      briefingTime: null,
    })!;
    expect(splitReminderTimes(window.start, window.end, 100)).toEqual([local(day, 8, 1)]);
  });

  it("accepts protected sleep ending at midnight", () => {
    expect(
      splitReminderWindow(local(day, 23, 59), local(day, 7), TZ, {
        ...DEFAULT_REMINDER_SETTINGS,
        sleepHours: { start: "20:00", end: "24:00" },
      }),
    ).toEqual({ start: local(day, 8), end: local(day, 20) });
  });

  it("uses owner-local times across the fall DST transition", () => {
    const date = "2026-11-01";
    const window = splitReminderWindow(local(date, 23, 59), local(date, 1), TZ, settings)!;
    expect(splitReminderTimes(window.start, window.end, 2)).toEqual([
      local(date, 14, 30),
      local(date, 17, 45),
    ]);
  });

  it("keeps splitting opt-in, defaults to two, and ignores invalid or unconfirmed counts", () => {
    const pref = (value: unknown, status = "confirmed") =>
      ({ key: "reminders.split", value, status }) as Preference;
    expect(parseReminderSettings([]).splitReminders).toEqual({ enabled: false, count: 2 });
    expect(parseReminderSettings([pref({ enabled: true, count: 5 })]).splitReminders).toEqual({
      enabled: true,
      count: 5,
    });
    for (const value of [
      { enabled: true, count: 0 },
      { enabled: true, count: 2.5 },
      { enabled: true, count: 101 },
    ]) {
      expect(parseReminderSettings([pref(value)]).splitReminders.enabled).toBe(false);
    }
    expect(
      parseReminderSettings([pref({ enabled: true, count: 5 }, "proposed")]).splitReminders.enabled,
    ).toBe(false);
  });
});
