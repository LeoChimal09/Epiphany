import { describe, expect, it } from "vitest";
import { recommendWorkBlocks } from "./recommendations";

const windows = [
  {
    start: new Date("2026-10-15T19:00:00.000Z"),
    end: new Date("2026-10-15T21:00:00.000Z"),
    minutes: 120,
    date: "2026-10-15" as const,
  },
  {
    start: new Date("2026-10-16T19:00:00.000Z"),
    end: new Date("2026-10-16T20:00:00.000Z"),
    minutes: 60,
    date: "2026-10-16" as const,
  },
];

describe("recommendWorkBlocks", () => {
  it("prioritizes dated work and fits effort inside available windows", () => {
    const result = recommendWorkBlocks(
      [
        { id: "later", title: "Reading", estimatedMinutes: 30 },
        { id: "due", title: "Essay", due: "2026-10-16", estimatedMinutes: 90 },
      ],
      windows,
    );
    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ taskId: "due", minutes: 90, reason: "deadline" });
    expect(result[0]?.endsAt.toISOString()).toBe("2026-10-15T20:30:00.000Z");
  });

  it("uses a default half-hour estimate and respects the result limit", () => {
    const result = recommendWorkBlocks(
      [
        { id: "a", title: "A" },
        { id: "b", title: "B" },
      ],
      windows,
      1,
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ taskId: "a", minutes: 30, reason: "available-time" });
  });
});
