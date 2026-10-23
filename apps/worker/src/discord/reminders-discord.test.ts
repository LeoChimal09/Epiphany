import type { Client } from "discord.js";
import type { Database, Reminder } from "@epiphany/core/db";
import { runReminderCycle, syncReminders } from "@epiphany/core/reminders";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReminderRunner, dmDelivery } from "./reminders-discord";

const mocks = vi.hoisted(() => ({
  principal: vi.fn(),
  preferences: vi.fn(),
}));
vi.mock("@epiphany/core/services", () => ({
  resolveDiscordPrincipal: mocks.principal,
  createServices: () => ({ preferences: { list: mocks.preferences } }),
}));
vi.mock("@epiphany/core/reminders", async (original) => ({
  ...(await original<typeof import("@epiphany/core/reminders")>()),
  syncReminders: vi.fn(),
  runReminderCycle: vi.fn(),
}));

describe("Discord reminder worker wiring (offline)", () => {
  const now = new Date("2026-01-01T14:00:00Z");
  const db = {} as Database;
  const send = vi.fn();
  const fetchOwner = vi.fn();
  const client = {
    user: { id: "fixture-bot" },
    users: { fetch: fetchOwner },
  } as unknown as Client;

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external calls allowed"));
    mocks.principal.mockResolvedValue({ ownerId: "fixture-owner" });
    mocks.preferences.mockResolvedValue([]);
    fetchOwner.mockResolvedValue({ send });
    send.mockResolvedValue({ channelId: "fixture-dm" });
    vi.mocked(syncReminders).mockResolvedValue({ created: 0, canceled: 0 });
    vi.mocked(runReminderCycle).mockResolvedValue({
      sent: 0,
      skipped: 0,
      deferred: 0,
      retrying: 0,
      failed: 0,
      unknown: 0,
      summarized: 0,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  it("uses the persisted engine with one-hour defaults, the fixed clock and reply context without AI", async () => {
    const onDelivered = vi.fn();
    const runner = createReminderRunner({
      client,
      db,
      ownerUserId: "fixture-owner-discord",
      timezone: "America/Chicago",
      clock: () => now,
      onDelivered,
    });
    await runner.run();
    expect(mocks.principal).toHaveBeenCalledExactlyOnceWith(db, "fixture-owner-discord", {
      audience: "private",
      initiator: "assistant",
    });
    expect(syncReminders).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({
        db,
        ownerId: "fixture-owner",
        now,
        timezone: "America/Chicago",
        settings: expect.objectContaining({ deadlineLeadHours: [24, 2, 1] }),
      }),
    );
    const cycle = vi.mocked(runReminderCycle).mock.calls[0]![0];
    expect(cycle.onDelivered).toBe(onDelivered);
    expect(cycle.now).toBe(now);
    expect(await cycle.compose?.({ kind: "task_deadline" } as Reminder)).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(fetchOwner).not.toHaveBeenCalled();
    runner.stop();
  });

  it("uses that same clock to honor a confirmed timed pause rather than the machine clock", async () => {
    mocks.preferences.mockResolvedValue([
      {
        key: "reminders.paused_until",
        value: "2026-01-01T15:00:00Z",
        status: "confirmed",
      },
    ]);
    const runner = createReminderRunner({
      client,
      db,
      ownerUserId: "fixture-owner-discord",
      timezone: "America/Chicago",
      clock: () => now,
    });
    await runner.run();
    expect(vi.mocked(runReminderCycle).mock.calls[0]![0].settings.paused).toBe(true);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    runner.stop();
  });

  it("delivers by the existing DM adapter and returns the channel for explicit contextual replies", async () => {
    expect(
      await dmDelivery(client, "fixture-owner-discord").send("One hour until the deadline"),
    ).toEqual({
      ok: true,
      channelId: "fixture-dm",
    });
    expect(fetchOwner).toHaveBeenCalledExactlyOnceWith("fixture-owner-discord");
    expect(send).toHaveBeenCalledExactlyOnceWith({
      content: "One hour until the deadline",
      allowedMentions: { parse: [] },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
