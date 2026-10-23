import { describe, expect, it } from "vitest";
import type { Preference } from "../db/schema";
import {
  defaultPlanningPreferences,
  parsePlanningPreferences,
  validatePlanningSetting,
} from "./preferences";

const pref = (key: string, value: unknown, status: "proposed" | "confirmed" = "confirmed") =>
  ({ key, value, status }) as unknown as Preference;
const TZ = "America/Chicago";

describe("planning preferences", () => {
  it("reads confirmed protected time, optional sleep and travel defaults", () => {
    const protection = [
      { label: "Travel home", weekdays: ["wed"], window: { start: "22:00", end: "08:00" } },
    ];
    const prefs = parsePlanningPreferences(
      [
        pref("planning.protected_time", protection),
        pref("planning.sleep", null),
        pref("planning.travel_before_minutes", 20),
        pref("planning.travel_after_minutes", 10),
      ],
      TZ,
    );
    expect(prefs.protectedTime).toEqual(protection);
    expect(prefs.sleep).toBeUndefined();
    expect(prefs.travelBeforeMinutes).toBe(20);
    expect(prefs.travelAfterMinutes).toBe(10);
  });

  it.each([
    ["planning.preferred_hours", { mon: [{ start: "18:00", end: "09:00" }] }],
    ["planning.preferred_hours", { mon: [{ start: "bad", end: "09:00" }] }],
    ["planning.preferred_hours", { unknown: [] }],
    ["planning.sleep", { start: "23:00", end: "23:00" }],
    [
      "planning.protected_time",
      [{ label: "Gym", weekdays: [], window: { start: "10:00", end: "11:00" } }],
    ],
    [
      "planning.protected_time",
      [{ label: "", weekdays: ["mon"], window: { start: "10:00", end: "11:00" } }],
    ],
    ["planning.buffer_minutes", 121],
    ["planning.min_block_minutes", 0],
    ["planning.travel_before_minutes", -1],
    ["planning.travel_after_minutes", Infinity],
    ["tracking.enabled", true],
    ["__proto__", {}],
  ])("rejects invalid planning input for %s", (key, value) => {
    expect(() => validatePlanningSetting(key, value)).toThrow();
  });

  it("accepts multiple preferred windows, end-of-day midnight and intentional unavailable days", () => {
    const hours = {
      mon: [
        { start: "09:00", end: "12:00" },
        { start: "13:00", end: "24:00" },
      ],
      tue: [],
    };
    expect(validatePlanningSetting("planning.preferred_hours", hours)).toEqual(hours);
    expect(validatePlanningSetting("planning.sleep", null)).toBeNull();
    expect(validatePlanningSetting("planning.meals", [])).toEqual([]);
  });
  it("does not pass malformed legacy preferred hours into the availability engine", () => {
    const parsed = parsePlanningPreferences(
      [pref("planning.preferred_hours", { mon: [{ start: "21:00", end: "09:00" }] })],
      TZ,
    );
    expect(parsed.preferredHours.mon).toEqual([]);
  });
  it("never offers overnight or meal time by default, and leaves school hours alone on weekdays", () => {
    const prefs = defaultPlanningPreferences(TZ);
    expect(prefs.preferredHours.mon).toEqual([{ start: "15:00", end: "21:00" }]);
    expect(prefs.sleep).toEqual({ start: "23:00", end: "07:00" });
    expect(prefs.meals).toHaveLength(2);
  });

  it("uses the owner's confirmed values and ignores proposed or malformed ones", () => {
    const prefs = parsePlanningPreferences(
      [
        pref("planning.preferred_hours", {
          mon: [
            { start: "09:00", end: "12:00" },
            { start: "x", end: "y" },
          ],
        }),
        pref("planning.sleep", { start: "22:00", end: "06:30" }),
        pref("planning.buffer_minutes", 15),
        pref("planning.min_block_minutes", 1),
        pref("planning.meals", [{ start: "12:00", end: "12:00" }], "proposed"),
      ],
      TZ,
    );
    expect(prefs.preferredHours.mon).toEqual([{ start: "09:00", end: "12:00" }]);
    // Days the owner did not list are unusable, not silently filled in.
    expect(prefs.preferredHours.tue).toBeUndefined();
    expect(prefs.sleep).toEqual({ start: "22:00", end: "06:30" });
    expect(prefs.bufferMinutes).toBe(15);
    expect(prefs.minBlockMinutes).toBe(30);
    expect(prefs.meals).toHaveLength(2);
  });
});
