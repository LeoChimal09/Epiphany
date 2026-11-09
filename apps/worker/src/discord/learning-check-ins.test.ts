import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Principal, Services } from "@epiphany/core/services";
import { createServices, issueOwnerPrincipal } from "@epiphany/core/services";
import { connectDatabase, createOwner, type DatabaseHandle } from "@epiphany/core/db";
import { runMigrations } from "../../../../packages/core/src/db/migrate";
import {
  createTestDatabase,
  dbTestsEnabled,
  type TestDatabase,
} from "../../../../packages/core/src/db/test-support";
import {
  createAssistant,
  createBudget,
  createMemoryUsageStore,
  createScriptedProvider,
  emptyConversation,
} from "@epiphany/core/assistant";
import { DEFAULT_REMINDER_SETTINGS, runReminderCycle } from "@epiphany/core/reminders";
import { withDeliveredReminders } from "./reminder-context";
import { availableForLearningCheckIn, scheduleLearningCheckIn } from "./learning-check-ins";

const principal = { ownerId: "fixture" } as Principal;
const now = new Date("2026-11-04T20:00:00Z"); // 2 PM Chicago.
function fixture(extra: { key: string; value: unknown; status?: string }[] = []) {
  const rows = [
    { key: "tracking.enabled", value: true, status: "confirmed" },
    { key: "tracking.check_ins", value: true, status: "confirmed" },
    ...extra.map((row) => ({ status: "confirmed", ...row })),
  ];
  const mocks = {
    list: vi.fn(async () => rows),
    get: vi.fn(async () => null as { version: number; value: unknown } | null),
    set: vi.fn<(principal: unknown, input: { value: unknown }) => Promise<unknown>>(
      async () => ({}),
    ),
    events: vi.fn(async () => [] as unknown[]),
    blocks: vi.fn(async () => [] as unknown[]),
    recent: vi.fn(async () => [] as unknown[]),
    create: vi.fn(async () => true),
  };
  const services = {
    preferences: { list: mocks.list, get: mocks.get, set: mocks.set },
    events: { list: mocks.events },
    workBlocks: { list: mocks.blocks },
    reminders: { recent: mocks.recent, create: mocks.create },
  } as unknown as Services;
  return { services, mocks, rows };
}
describe("private proactive learning questions", () => {
  it("reserves a new topic then queues a normal durable reminder, and does not repeat after restart", async () => {
    const { services, mocks } = fixture();
    await scheduleLearningCheckIn(services, principal, now, "America/Chicago");
    expect(mocks.set).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        key: "learning.last_question",
        value: {
          day: "2026-11-04",
          at: now.toISOString(),
          asked: ["focus-time"],
          recent: ["When do you usually feel most ready for focused work?"],
        },
      }),
    );
    expect(mocks.create).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        kind: "check_in",
        at: now,
        message: expect.stringContaining("Optional Epi check-in:"),
      }),
    );
    expect(mocks.set.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.create.mock.invocationCallOrder[0]!,
    );
    mocks.get.mockResolvedValue({ version: 1, value: mocks.set.mock.calls[0]![1].value });
    await scheduleLearningCheckIn(
      services,
      principal,
      new Date("2026-11-05T20:00:00Z"),
      "America/Chicago",
    );
    expect(mocks.create).toHaveBeenCalledTimes(1);
  });

  describe.skipIf(!dbTestsEnabled)("proactive questions against disposable SQLite", () => {
    let database: TestDatabase;
    let handle: DatabaseHandle;
    beforeEach(async () => {
      database = await createTestDatabase();
      handle = connectDatabase(database.url);
      await runMigrations(
        handle.pool,
        path.resolve(
          fileURLToPath(new URL("../../../../packages/core/drizzle-sqlite", import.meta.url)),
        ),
      );
    });
    afterEach(async () => {
      await handle.close();
      await database.drop();
      expect(await database.exists()).toBe(false);
    });
    it("persists one delivery across restart and requires approval before a reply influences future conversation", async () => {
      const owner = await createOwner(handle.db, { displayName: "Fixture" });
      const principal = await issueOwnerPrincipal(handle.db, owner.id, {
        source: "discord",
        audience: "private",
        initiator: "assistant",
      });
      const services = createServices(handle.db, { clock: () => now });
      for (const key of ["tracking.enabled", "tracking.check_ins"]) {
        await services.preferences.set(principal, { key, value: true, status: "confirmed" });
      }
      await scheduleLearningCheckIn(services, principal, now, "America/Chicago");
      const sent = vi.fn(async () => ({ ok: true as const, channelId: "private-check-ins" }));
      const run = () =>
        runReminderCycle({
          db: handle.db,
          ownerId: owner.id,
          now,
          timezone: "America/Chicago",
          settings: DEFAULT_REMINDER_SETTINGS,
          delivery: { send: sent },
          eligible: () => availableForLearningCheckIn(services, principal, now, "America/Chicago"),
        });
      expect(await run()).toMatchObject({ sent: 1 });
      const persisted = await services.reminders.recent(principal, 100);
      expect(persisted).toHaveLength(1);
      expect(persisted[0]?.status).toBe("sent");
      await scheduleLearningCheckIn(
        createServices(handle.db, { clock: () => now }),
        principal,
        now,
        "America/Chicago",
      );
      expect(await run()).toMatchObject({ sent: 0 });
      expect(sent).toHaveBeenCalledTimes(1);
      const provider = createScriptedProvider((request) =>
        request.message === "yes"
          ? { kind: "confirm" }
          : request.message === "I like short casual replies"
            ? { kind: "remember", text: "I prefer short, casual replies", explicit: true }
            : { kind: "respond", text: "Hello" },
      );
      const assistant = createAssistant({
        services,
        provider,
        timezone: "America/Chicago",
        clock: () => now,
        budget: createBudget(
          { monthlyLimitUsd: 10, warnPercent: 80, timezone: "America/Chicago" },
          createMemoryUsageStore(),
          () => now,
        ),
      });
      const state = withDeliveredReminders(emptyConversation(), persisted, now);
      const answer = await assistant.handle(principal, "I like short casual replies", state);
      expect(answer.reply.outcome).toBe("confirmation_needed");
      const before = await assistant.handle(
        principal,
        "How should I approach this afternoon?",
        emptyConversation(),
      );
      expect(before.reply.changed).toBe(false);
      expect(provider.calls.at(-1)?.memories).toEqual([]);
      const confirmed = await assistant.handle(principal, "yes", answer.state);
      expect(confirmed.reply).toMatchObject({ changed: true });
      expect(
        (await services.preferences.list(principal)).filter((row) => row.key.startsWith("memory.")),
      ).toEqual([expect.objectContaining({ status: "confirmed" })]);
      const after = await assistant.handle(
        principal,
        "How should I approach this afternoon?",
        emptyConversation(),
      );
      expect(after.reply.outcome).toBe("answered");
      expect(provider.calls.at(-1)?.memories).toContain("I prefer short, casual replies");
    });
  });
  it.each(["tracking.enabled", "tracking.check_ins"])(
    "requires separately confirmed consent for %s",
    async (key) => {
      const { services, mocks, rows } = fixture();
      rows.find((row) => row.key === key)!.value = false;
      await scheduleLearningCheckIn(services, principal, now, "America/Chicago");
      expect(mocks.create).not.toHaveBeenCalled();
      expect(mocks.set).not.toHaveBeenCalled();
      expect(mocks.events).not.toHaveBeenCalled();
    },
  );
  it.each([
    ["tracking.paused", true],
    ["reminders.paused", true],
    ["reminders.paused_until", "2026-11-05T00:00:00Z"],
    ["reminders.quiet_hours", { start: "13:00", end: "16:00" }],
    [
      "planning.protected_time",
      [{ label: "Break", weekdays: ["wed"], window: { start: "13:00", end: "16:00" } }],
    ],
    ["planning.sleep", { start: "13:00", end: "16:00" }],
  ])("does not interrupt %s", async (key, value) => {
    const { services, mocks } = fixture([{ key, value }]);
    await scheduleLearningCheckIn(services, principal, now, "America/Chicago");
    expect(mocks.create).not.toHaveBeenCalled();
  });
  it("withholds questions near events, work blocks, or a recent notification, and on truncated calendars", async () => {
    const { services, mocks } = fixture();
    mocks.events.mockResolvedValue([
      {
        id: "busy",
        startsAt: now,
        endsAt: new Date("2026-11-04T21:00:00Z"),
        status: "scheduled",
        allDay: false,
        timezone: "America/Chicago",
      },
    ]);
    expect(await availableForLearningCheckIn(services, principal, now, "America/Chicago")).toBe(
      false,
    );
    mocks.events.mockResolvedValue([]);
    mocks.blocks.mockResolvedValue([
      { id: "block", startsAt: now, endsAt: new Date("2026-11-04T21:00:00Z"), status: "planned" },
    ]);
    expect(await availableForLearningCheckIn(services, principal, now, "America/Chicago")).toBe(
      false,
    );
    mocks.blocks.mockResolvedValue([]);
    mocks.recent.mockResolvedValue([{ sentAt: new Date("2026-11-04T19:30:00Z") }]);
    expect(await availableForLearningCheckIn(services, principal, now, "America/Chicago")).toBe(
      false,
    );
    mocks.recent.mockResolvedValue([]);
    mocks.events.mockResolvedValue(Array(500).fill({}));
    expect(await availableForLearningCheckIn(services, principal, now, "America/Chicago")).toBe(
      false,
    );
  });
  it("reports why a question was not queued", async () => {
    const tz = "America/Chicago";
    expect(await scheduleLearningCheckIn(fixture().services, principal, now, tz)).toBe("queued");
    const notAllowed = fixture();
    notAllowed.rows.splice(1, 1);
    expect(await scheduleLearningCheckIn(notAllowed.services, principal, now, tz)).toBe(
      "not_allowed",
    );
    const recent = fixture();
    recent.mocks.recent.mockResolvedValue([{ sentAt: new Date("2026-11-04T19:30:00Z") }]);
    expect(await scheduleLearningCheckIn(recent.services, principal, now, tz)).toBe(
      "recent_reminder",
    );
    const asked = fixture();
    asked.mocks.get.mockResolvedValue({
      version: 1,
      value: { day: "2026-11-03", at: "2026-11-03T20:00:00Z", asked: [] },
    });
    expect(await scheduleLearningCheckIn(asked.services, principal, now, tz)).toBe(
      "asked_recently",
    );
  });
  it("asks a question written from the owner's records, falling back to a fixed topic", async () => {
    const tz = "America/Chicago";
    const written = fixture();
    written.mocks.get.mockResolvedValue({
      version: 2,
      value: { asked: ["focus-time"], recent: ["Earlier question?"] },
    });
    const compose = vi.fn(async () => "With the Black Friday list growing, want help budgeting?");
    expect(await scheduleLearningCheckIn(written.services, principal, now, tz, compose)).toBe(
      "queued",
    );
    expect(compose).toHaveBeenCalledWith(["Earlier question?"]);
    expect(written.mocks.set.mock.calls[0]![1].value).toMatchObject({
      asked: ["focus-time"],
      recent: ["Earlier question?", "With the Black Friday list growing, want help budgeting?"],
    });
    expect(written.mocks.create).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({
        message: expect.stringContaining("With the Black Friday list growing"),
      }),
    );
    const fallback = fixture();
    await scheduleLearningCheckIn(fallback.services, principal, now, tz, async () => {
      throw new Error("AI down");
    });
    expect(fallback.mocks.create).toHaveBeenCalledWith(
      principal,
      expect.objectContaining({ message: expect.stringContaining("focused work") }),
    );
    const busy = fixture();
    busy.mocks.recent.mockResolvedValue([{ sentAt: new Date("2026-11-04T19:30:00Z") }]);
    const unused = vi.fn(async () => "Unused?");
    await scheduleLearningCheckIn(busy.services, principal, now, tz, unused);
    expect(unused).not.toHaveBeenCalled();
  });
  it("does not enqueue anything if reserving the topic conflicts", async () => {
    const { services, mocks } = fixture();
    mocks.set.mockRejectedValue(new Error("conflict"));
    await expect(
      scheduleLearningCheckIn(services, principal, now, "America/Chicago"),
    ).rejects.toThrow("conflict");
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
