import { beforeEach, describe, expect, it, vi } from "vitest";
import { VersionConflictError } from "@epiphany/core/services";
import { saveBriefingSetting, saveSplitReminderSetting } from "./actions";

const mocks = vi.hoisted(() => ({ context: vi.fn(), set: vi.fn(), revalidate: vi.fn() }));
vi.mock("../server-data", () => ({ dashboardContext: mocks.context }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
const principal = { authenticated: "fixture-owner" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({ principal, services: { preferences: { set: mocks.set } } });
  mocks.set.mockResolvedValue({ version: 3 });
});

describe("optional split reminder setting action", () => {
  it("saves a configurable owner-scoped count without altering original reminder preferences", async () => {
    expect(await saveSplitReminderSetting({ enabled: true, count: 5 }, 2)).toEqual({
      ok: true,
      version: 3,
    });
    expect(mocks.set).toHaveBeenCalledExactlyOnceWith(principal, {
      key: "reminders.split",
      value: { enabled: true, count: 5 },
      status: "confirmed",
      expectedVersion: 2,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith("/dashboard/planning");
  });

  it("disables splitting while keeping the selected count", async () => {
    await saveSplitReminderSetting({ enabled: false, count: 5 }, 3);
    expect(mocks.set).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ value: { enabled: false, count: 5 } }),
    );
  });

  it.each([
    null,
    { enabled: true, count: 0 },
    { enabled: true, count: 1.5 },
    { enabled: true, count: 101 },
    { enabled: "yes", count: 5 },
  ])("rejects invalid settings %j before writing", async (value) => {
    expect(await saveSplitReminderSetting(value, 2)).toMatchObject({ ok: false });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("requires authentication and reports stale versions", async () => {
    mocks.set.mockRejectedValue(new VersionConflictError("Preference", 4));
    expect(await saveSplitReminderSetting({ enabled: true, count: 2 }, 3)).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed elsewhere"),
    });
    mocks.context.mockRejectedValue(new Error("not authenticated"));
    await expect(saveSplitReminderSetting({ enabled: true, count: 2 }, 3)).rejects.toThrow(
      "not authenticated",
    );
    expect(mocks.set).toHaveBeenCalledTimes(1);
  });
});

describe("morning briefing setting action", () => {
  it("saves a confirmed, owner-scoped local time using the current preference version", async () => {
    expect(await saveBriefingSetting("07:30", 2)).toEqual({ ok: true, version: 3 });
    expect(mocks.set).toHaveBeenCalledWith(principal, {
      key: "reminders.briefing_time",
      value: "07:30",
      status: "confirmed",
      expectedVersion: 2,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith("/dashboard");
    expect(mocks.revalidate).toHaveBeenCalledWith("/dashboard/planning");
  });

  it("stores the existing false preference representation when briefing delivery is disabled", async () => {
    expect(await saveBriefingSetting(null, undefined)).toEqual({ ok: true, version: 3 });
    expect(mocks.set).toHaveBeenCalledWith(principal, {
      key: "reminders.briefing_time",
      value: false,
      status: "confirmed",
      expectedVersion: undefined,
    });
  });

  it("does not write when the dashboard owner check fails", async () => {
    mocks.context.mockRejectedValue(new Error("not authenticated"));
    await expect(saveBriefingSetting("07:30", 2)).rejects.toThrow("not authenticated");
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it.each(["8:00", "24:00", "08:60", false, 800])("rejects invalid time %j", async (value) => {
    expect(await saveBriefingSetting(value, 2)).toMatchObject({ ok: false });
    expect(mocks.set).not.toHaveBeenCalled();
  });

  it("reports a concurrent preference change without revalidating", async () => {
    mocks.set.mockRejectedValue(new VersionConflictError("Preference", 4));
    expect(await saveBriefingSetting("07:30", 2)).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed elsewhere"),
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
});
