import { ChannelType, PermissionFlagsBits, type Client, type Guild } from "discord.js";
import type { Database, Reminder } from "@epiphany/core/db";
import { runReminderCycle, syncReminders } from "@epiphany/core/reminders";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createReminderRunner, serverChannelDelivery } from "./reminders-discord";

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
  const client = {
    user: { id: "fixture-bot" },
    guilds: { cache: { values: () => [] } },
  } as unknown as Client;

  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("No external calls allowed"));
    mocks.principal.mockResolvedValue({ ownerId: "fixture-owner" });
    mocks.preferences.mockResolvedValue([]);
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
        settings: expect.objectContaining({
          deadlineLeadHours: [1],
          majorDeadlineLeadHours: [24, 2, 1],
        }),
      }),
    );
    const cycle = vi.mocked(runReminderCycle).mock.calls[0]![0];
    expect(cycle.onDelivered).toBe(onDelivered);
    expect(cycle.now).toBe(now);
    expect(await cycle.compose?.({ kind: "task_deadline" } as Reminder)).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
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

  it("delivers to the private Epiphany check-ins channel and returns its id for reply context", async () => {
    const everyone = { id: "everyone" };
    const bot = { id: "fixture-bot" };
    const send = vi.fn().mockResolvedValue({ channelId: "private-check-ins" });
    const channel = {
      id: "private-check-ins",
      name: "check-ins",
      type: ChannelType.GuildText,
      parent: { name: "epiphany" },
      permissionsFor: vi.fn((subject: unknown) => ({
        has: (permission: bigint) =>
          subject === everyone
            ? false
            : subject === bot && permission === PermissionFlagsBits.SendMessages,
      })),
      send,
    };
    const owner = {
      permissionsIn: vi.fn(() => ({
        has: (permission: bigint) => permission === PermissionFlagsBits.ViewChannel,
      })),
    };
    const guild = {
      channels: { fetch: vi.fn().mockResolvedValue([channel]) },
      members: { fetch: vi.fn().mockResolvedValue(owner) },
      roles: { everyone },
    } as unknown as Guild;
    const serverClient = {
      user: bot,
      guilds: { cache: { values: () => [guild] } },
    } as unknown as Client;

    expect(
      await serverChannelDelivery(serverClient, "fixture-owner-discord").send("Reminder"),
    ).toEqual({
      ok: true,
      channelId: "private-check-ins",
    });
    expect(guild.members.fetch).toHaveBeenCalledExactlyOnceWith("fixture-owner-discord");
    expect(send).toHaveBeenCalledExactlyOnceWith({
      content: "<@fixture-owner-discord> Reminder",
      allowedMentions: { parse: [], users: ["fixture-owner-discord"] },
    });
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it("does not send reminders to a public or look-alike channel", async () => {
    const send = vi.fn();
    const publicChannel = {
      name: "check-ins",
      type: ChannelType.GuildText,
      parent: { name: "epiphany" },
      permissionsFor: () => ({ has: () => true }),
      send,
    };
    const guild = {
      channels: { fetch: vi.fn().mockResolvedValue([publicChannel]) },
      members: { fetch: vi.fn().mockResolvedValue({ permissionsIn: () => ({ has: () => true }) }) },
      roles: { everyone: {} },
    } as unknown as Guild;
    const serverClient = {
      user: { id: "fixture-bot" },
      guilds: { cache: { values: () => [guild] } },
    } as unknown as Client;

    expect(
      await serverChannelDelivery(serverClient, "fixture-owner-discord").send("Private"),
    ).toEqual({ ok: false, reason: "blocked" });
    expect(send).not.toHaveBeenCalled();
  });
});
