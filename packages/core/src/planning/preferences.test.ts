import { describe, expect, it } from "vitest";
import type { Preference } from "../db/schema";
import { defaultPlanningPreferences, parsePlanningPreferences } from "./preferences";

const pref = (key: string, value: unknown, status: "proposed" | "confirmed" = "confirmed") =>
  ({ key, value, status }) as unknown as Preference;
const TZ = "America/Chicago";

describe("planning preferences", () => {
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
