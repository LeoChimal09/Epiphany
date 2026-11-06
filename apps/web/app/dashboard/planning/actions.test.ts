import { beforeEach, describe, expect, it, vi } from "vitest";
import { VersionConflictError } from "@epiphany/core/services";
import { saveLearningAllowance, saveLearningSetting, savePlanningSetting } from "./actions";

const mocks = vi.hoisted(() => ({ context: vi.fn(), set: vi.fn(), revalidate: vi.fn() }));
vi.mock("../server-data", () => ({ dashboardContext: mocks.context }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidate }));
const principal = { authenticated: "fixture-owner" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({ principal, services: { preferences: { set: mocks.set } } });
  mocks.set.mockResolvedValue({ version: 3 });
});

describe("planning settings action", () => {
  it("requires separate explicit consent for proactive messages", async () => {
    expect(await saveLearningSetting("tracking.check_ins", true, 2, false)).toMatchObject({
      ok: false,
    });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(await saveLearningSetting("tracking.check_ins", true, 2, true)).toMatchObject({
      ok: true,
    });
    expect(mocks.set).toHaveBeenCalledWith(principal, {
      key: "tracking.check_ins",
      value: true,
      expectedVersion: 2,
      status: "confirmed",
    });
  });
  it("applies a single allow choice and clears a legacy pause with both expected versions", async () => {
    expect(await saveLearningAllowance(true, 2, 4, true)).toEqual({
      ok: true,
      version: 3,
      pausedVersion: 3,
    });
    expect(mocks.set.mock.calls).toEqual([
      [
        principal,
        { key: "tracking.enabled", value: true, expectedVersion: 2, status: "confirmed" },
      ],
      [
        principal,
        { key: "tracking.paused", value: false, expectedVersion: 4, status: "confirmed" },
      ],
    ]);
  });
  it("turns learning off without enabling it or changing stored reports", async () => {
    expect(await saveLearningAllowance(false, 2, 4, false)).toMatchObject({ ok: true });
    expect(mocks.set).toHaveBeenCalledTimes(1);
    expect(mocks.set).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ key: "tracking.enabled", value: false }),
    );
  });
  it("does not bypass consent or silently report a partially applied allowance as success", async () => {
    expect(await saveLearningAllowance(true, 2, 4, false)).toMatchObject({ ok: false });
    expect(mocks.set).not.toHaveBeenCalled();
    mocks.set
      .mockResolvedValueOnce({ version: 3 })
      .mockRejectedValueOnce(new VersionConflictError("Preference", 5));
    expect(await saveLearningAllowance(true, 2, 4, true)).toMatchObject({
      ok: false,
      error: expect.stringContaining("Reload"),
    });
  });
  it("persists routines-only mode without writing SQL NULL", async () => {
    expect(await savePlanningSetting("planning.preferred_hours", null, 2)).toMatchObject({
      ok: true,
    });
    expect(mocks.set).toHaveBeenCalledWith(principal, expect.objectContaining({ value: false }));
  });
  it("requires explicit consent before enabling learning and saves the owner's version-bound choice", async () => {
    expect(await saveLearningSetting("tracking.enabled", true, 2, false)).toMatchObject({
      ok: false,
    });
    expect(mocks.set).not.toHaveBeenCalled();
    expect(await saveLearningSetting("tracking.enabled", true, 2, true)).toMatchObject({
      ok: true,
    });
    expect(mocks.set).toHaveBeenCalledWith(principal, {
      key: "tracking.enabled",
      value: true,
      expectedVersion: 2,
      status: "confirmed",
    });
  });
  it("saves one validated confirmed setting through owner-scoped services", async () => {
    expect(await savePlanningSetting("planning.buffer_minutes", 20, 2)).toEqual({
      ok: true,
      version: 3,
    });
    expect(mocks.set).toHaveBeenCalledWith(principal, {
      key: "planning.buffer_minutes",
      value: 20,
      status: "confirmed",
      expectedVersion: 2,
    });
    expect(mocks.revalidate).toHaveBeenCalledWith("/dashboard");
  });
  it("does not write for unauthenticated calls", async () => {
    mocks.context.mockRejectedValue(new Error("not authenticated"));
    await expect(savePlanningSetting("planning.buffer_minutes", 20, 2)).rejects.toThrow(
      "not authenticated",
    );
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it.each([
    ["planning.preferred_hours", { mon: [{ start: "22:00", end: "07:00" }] }],
    ["planning.buffer_minutes", -1],
    ["tracking.enabled", true],
  ])("rejects invalid or unrelated changes for %s", async (key, value) => {
    expect(await savePlanningSetting(key, value, undefined)).toMatchObject({ ok: false });
    expect(mocks.set).not.toHaveBeenCalled();
  });
  it("reports conflicts without claiming a save", async () => {
    mocks.set.mockRejectedValue(new VersionConflictError("Preference", 4));
    expect(await savePlanningSetting("planning.buffer_minutes", 20, 2)).toMatchObject({
      ok: false,
      error: expect.stringContaining("changed elsewhere"),
    });
    expect(mocks.revalidate).not.toHaveBeenCalled();
  });
  it("logs service failures safely and surfaces them", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.set.mockRejectedValue(new Error("private database details"));
      expect(await savePlanningSetting("planning.buffer_minutes", 20, 2)).toMatchObject({
        ok: false,
      });
      expect(log).toHaveBeenCalledWith(expect.stringContaining("planning_preferences_save_failed"));
      expect(log.mock.calls.flat().join(" ")).not.toContain("private");
    } finally {
      log.mockRestore();
    }
  });
});
