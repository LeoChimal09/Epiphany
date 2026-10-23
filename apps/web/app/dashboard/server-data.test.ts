import { beforeEach, describe, expect, it, vi } from "vitest";
import { localWallToUtc } from "@epiphany/core/planning";
import { dashboardContext, loadSchedule } from "./server-data";

const mocks = vi.hoisted(() => ({
  events: vi.fn(),
  blocks: vi.fn(),
  preferences: vi.fn(),
  overview: vi.fn(),
  verify: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("../../lib/auth/dal", () => ({ verifySession: mocks.verify }));
vi.mock("../../lib/auth/deps", () => ({
  getAuthDeps: () => ({ db: {}, config: { timezone: "America/Chicago", devBypass: true } }),
}));
vi.mock("@epiphany/core/services", () => ({
  createServices: () => ({
    events: { list: mocks.events },
    workBlocks: { list: mocks.blocks },
    preferences: { list: mocks.preferences },
    calendar: { overview: mocks.overview },
  }),
}));

beforeEach(() => {
  vi.resetAllMocks();
  mocks.verify.mockResolvedValue({ ownerId: "fixture-owner" });
  mocks.events.mockResolvedValue([]);
  mocks.blocks.mockResolvedValue([]);
  mocks.preferences.mockResolvedValue([
    { key: "planning.buffer_minutes", value: 25, status: "confirmed" },
  ]);
  mocks.overview.mockResolvedValue({ account: null, calendars: [] });
});

describe("schedule planning snapshot", () => {
  it("loads owner preferences and padded events to include travel/buffers crossing week boundaries", async () => {
    const context = await dashboardContext();
    const schedule = await loadSchedule(context, "2026-10-19");
    expect(schedule.planningPreferences?.bufferMinutes).toBe(25);
    expect(schedule.syncWarning).toBeNull();
    expect(mocks.events).toHaveBeenCalledWith(context.principal, {
      from: localWallToUtc("2026-10-18", 0, "America/Chicago"),
      to: localWallToUtc("2026-10-27", 0, "America/Chicago"),
      limit: 200,
    });
    expect(mocks.preferences).toHaveBeenCalledWith(context.principal);
    expect(mocks.overview).toHaveBeenCalledWith(context.principal);
  });
  it("does not turn a failed source into an apparently complete availability snapshot", async () => {
    mocks.preferences.mockRejectedValue(new Error("unavailable"));
    await expect(loadSchedule(await dashboardContext(), "2026-10-19")).rejects.toThrow(
      "unavailable",
    );
  });
});
