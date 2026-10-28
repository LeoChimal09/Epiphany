import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseHandle } from "../db/client";
import { createOwner } from "../db/domain";
import { runMigrations } from "../db/migrate";
import { actionHistory, confirmations, notes, tasks, workBlocks } from "../db/schema";
import { createTestDatabase, dbTestsEnabled, type TestDatabase } from "../db/test-support";
import {
  computeAvailability,
  parsePlanningPreferences,
  validatePlanningSetting,
} from "../planning";
import {
  AccessDeniedError,
  ConfirmationError,
  CONFIRMATION_TTL_MS,
  createServices,
  issueOwnerPrincipal,
  resolveDiscordPrincipal,
  ValidationError,
  type Principal,
  type Services,
} from "./index";

const migrationsFolder = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));
const OWNER_DISCORD = "100000000000000001";

describe.skipIf(!dbTestsEnabled)("secured services against MySQL", () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;
  let services: Services;
  let now: Date;
  let owner: Principal;
  let strangerOwner: Principal;
  let ownerId: string;

  const principalFor = (
    id: string,
    over: Partial<Parameters<typeof issueOwnerPrincipal>[2]> = {},
  ) =>
    issueOwnerPrincipal(handle.db, id, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
      ...over,
    });

  beforeEach(async () => {
    database = await createTestDatabase();
    handle = connectDatabase(database.url);
    await runMigrations(handle.pool, migrationsFolder);
    now = new Date("2026-10-13T15:00:00.000Z");
    services = createServices(handle.db, { clock: () => now });
    const a = await createOwner(handle.db, { displayName: "Owner", discordUserId: OWNER_DISCORD });
    const b = await createOwner(handle.db, {
      displayName: "Stranger",
      discordUserId: "200000000000000002",
    });
    ownerId = a.id;
    owner = await principalFor(a.id);
    strangerOwner = await principalFor(b.id);
  });

  afterEach(async () => {
    await handle.close();
    await database.drop();
    expect(await database.exists()).toBe(false);
  });

  const count = async (
    table: typeof tasks | typeof notes | typeof workBlocks | typeof actionHistory,
  ) => (await handle.db.select().from(table)).length;

  describe("authentication and ownership", () => {
    it("lets the owner read and write fixture records", async () => {
      const task = await services.tasks.create(owner, {
        title: "Essay",
        dueAt: "2026-10-16T04:59:59.000Z",
      });
      expect((await services.tasks.list(owner)).map((t) => t.id)).toEqual([task.id]);
      expect((await services.tasks.get(owner, task.id)).title).toBe("Essay");
    });

    it("persists todos without task-only fields and keeps them out of deadline scheduling", async () => {
      const todo = await services.tasks.create(owner, {
        title: "Buy a snack",
        taskType: "todo",
        priority: "major",
        dueAt: "2026-10-16T04:59:59.000Z",
        estimatedMinutes: 30,
      });
      expect(todo).toMatchObject({
        taskType: "todo",
        priority: "minor",
        dueAt: null,
        dueDateOnly: false,
        estimatedMinutes: null,
        remainingMinutes: null,
      });

      await services.tasks.update(owner, todo.id, {
        dueAt: "2026-10-17T04:59:59.000Z",
        dueDateOnly: true,
        estimatedMinutes: 45,
        priority: "major",
      });
      expect(await services.tasks.get(owner, todo.id)).toMatchObject({
        taskType: "todo",
        priority: "minor",
        dueAt: null,
        dueDateOnly: false,
        estimatedMinutes: null,
      });
    });

    it("lists only the current owner's newly created tasks and events for announcements", async () => {
      const task = await services.tasks.create(owner, { title: "Study for finals" });
      const event = await services.events.create(owner, {
        title: "Office hours",
        startsAt: "2026-10-14T20:00:00.000Z",
        endsAt: "2026-10-14T21:00:00.000Z",
        timezone: "America/Chicago",
      });
      await services.notes.create(owner, { body: "Private note" });
      await services.tasks.create(strangerOwner, { title: "Someone else's task" });

      const additions = await services.history.additions(owner);

      expect(additions.map((entry) => entry.entityId).toSorted()).toEqual(
        [task.id, event.id].toSorted(),
      );
      await expect(services.history.additions({ ownerId })).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
    });

    it("reads owner-scoped planner changes after a persisted checkpoint, including edits and completions", async () => {
      const task = await services.tasks.create(owner, { title: "Repair drone" });
      await services.tasks.update(owner, task.id, { title: "Repair camera" });
      await services.tasks.complete(owner, task.id);
      await services.tasks.create(strangerOwner, { title: "Private other task" });
      const since = "2026-01-01T00:00:00.000Z";
      const changes = await services.history.changes(owner, since);
      expect(changes.map((entry) => entry.action).toSorted()).toEqual(
        ["task.create", "task.update", "task.complete"].toSorted(),
      );
      expect(changes.every((entry) => entry.entityId === task.id)).toBe(true);
      expect(
        await services.history.changes(
          owner,
          since,
          changes.map((entry) => entry.id),
        ),
      ).toEqual([]);
      await expect(services.history.changes({ ownerId }, since)).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(
        services.history.changes(await principalFor(ownerId, { audience: "shared" }), since),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    });

    it("rejects a forged principal on every method and changes nothing", async () => {
      const task = await services.tasks.create(owner, { title: "Real task" });
      const forged = { ownerId, source: "dashboard", audience: "private", initiator: "owner" };
      const calls: Array<() => Promise<unknown>> = [
        () => services.tasks.list(forged),
        () => services.tasks.get(forged, task.id),
        () => services.tasks.create(forged, { title: "x" }),
        () => services.tasks.complete(forged, task.id),
        () => services.notes.create(forged, { body: "x" }),
        () => services.notes.list(forged),
        () => services.history.list(forged),
        () => services.owner.profile(forged),
        () =>
          services.workBlocks.create(forged, {
            startsAt: now,
            endsAt: new Date(now.getTime() + 3600000),
          }),
        () => services.confirmations.propose(forged, { action: "note.delete", payload: {} }),
        () => services.tasks.list(undefined),
        () => services.tasks.list(null),
      ];
      for (const call of calls) await expect(call()).rejects.toBeInstanceOf(AccessDeniedError);
      expect((await services.tasks.get(owner, task.id)).status).toBe("open");
      expect(await count(tasks)).toBe(1);
    });

    it("identifies the owner by linked Discord account and gives nobody else a principal", async () => {
      const ok = await resolveDiscordPrincipal(handle.db, OWNER_DISCORD, {
        audience: "private",
        initiator: "assistant",
      });
      expect(ok?.ownerId).toBe(ownerId);
      expect(ok?.source).toBe("discord");
      expect(
        await resolveDiscordPrincipal(handle.db, "999999999999999999", {
          audience: "private",
          initiator: "assistant",
        }),
      ).toBeNull();
      await expect(
        issueOwnerPrincipal(handle.db, "00000000-0000-4000-8000-000000000000", {
          source: "dashboard",
          audience: "private",
          initiator: "owner",
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    });

    it("never lets one owner see or change another owner's records", async () => {
      const task = await services.tasks.create(owner, { title: "Private essay" });
      await services.notes.create(owner, { body: "private note" });

      expect(await services.tasks.list(strangerOwner)).toEqual([]);
      expect(await services.notes.list(strangerOwner)).toEqual([]);
      await expect(services.tasks.get(strangerOwner, task.id)).rejects.toThrow(/not found/);
      await expect(services.tasks.complete(strangerOwner, task.id)).rejects.toThrow(/not found/);
      expect((await services.tasks.get(owner, task.id)).status).toBe("open");
      expect(await services.history.list(strangerOwner)).toHaveLength(1); // only their own owner.create
    });

    it("serves nothing personal to a shared audience and does not leak details in the error", async () => {
      const task = await services.tasks.create(owner, { title: "Secret thesis topic" });
      const inShared = await principalFor(ownerId, {
        source: "discord",
        audience: "shared",
        initiator: "assistant",
      });

      for (const call of [
        () => services.tasks.list(inShared),
        () => services.tasks.get(inShared, task.id),
        () => services.tasks.complete(inShared, task.id),
        () => services.notes.list(inShared),
        () => services.history.list(inShared),
      ]) {
        const error = await call().catch((e: unknown) => e);
        expect(error).toBeInstanceOf(AccessDeniedError);
        expect(String((error as Error).message)).not.toContain("Secret thesis topic");
      }
      expect((await services.tasks.get(owner, task.id)).status).toBe("open");
    });
  });

  describe("owner profile", () => {
    it("returns the signed-in owner's name and a Discord avatar URL", async () => {
      expect(await services.owner.profile(owner)).toEqual({
        displayName: "Owner",
        avatarUrl: null,
      });
      await handle.pool.query("UPDATE owners SET display_name = ?, avatar_hash = ? WHERE id = ?", [
        "Leo",
        "c".repeat(32),
        ownerId,
      ]);
      expect(await services.owner.profile(owner)).toEqual({
        displayName: "Leo",
        avatarUrl: `https://cdn.discordapp.com/avatars/${OWNER_DISCORD}/${"c".repeat(32)}.png?size=128`,
      });
    });

    it("never builds a URL from a malformed stored hash, and only reads the caller's own row", async () => {
      await handle.pool.query("UPDATE owners SET avatar_hash = ? WHERE id = ?", [
        "../../evil",
        ownerId,
      ]);
      expect((await services.owner.profile(owner)).avatarUrl).toBeNull();
      expect((await services.owner.profile(strangerOwner)).displayName).toBe("Stranger");
    });

    it("is not available to a shared audience", async () => {
      const shared = await principalFor(ownerId, { audience: "shared" });
      await expect(services.owner.profile(shared)).rejects.toBeInstanceOf(AccessDeniedError);
    });
  });

  describe("overview bindings", () => {
    const GUILD = "300000000000000001";
    const binding = (over: Record<string, string> = {}) => ({
      guildId: GUILD,
      viewKey: "today",
      channelId: "400000000000000001",
      messageId: "500000000000000001",
      contentHash: "a".repeat(64),
      ...over,
    });

    it("remembers which message shows a view, and replaces it instead of adding a second row", async () => {
      expect(await services.overviews.get(owner, GUILD, "today")).toBeNull();
      await services.overviews.save(owner, binding());
      await services.overviews.save(
        owner,
        binding({ messageId: "500000000000000002", contentHash: "b".repeat(64) }),
      );
      expect(await services.overviews.get(owner, GUILD, "today")).toEqual(
        binding({ messageId: "500000000000000002", contentHash: "b".repeat(64) }),
      );
      const rows = (await handle.pool.query("SELECT 1 FROM discord_overviews"))[0] as unknown[];
      expect(rows).toHaveLength(1);
    });

    it("keeps views and servers apart, and one owner's bindings from another", async () => {
      await services.overviews.save(owner, binding());
      await services.overviews.save(owner, binding({ viewKey: "schedule" }));
      expect(await services.overviews.get(owner, GUILD, "schedule")).toMatchObject({
        viewKey: "schedule",
      });
      expect(await services.overviews.get(owner, "300000000000000009", "today")).toBeNull();
      expect(await services.overviews.get(strangerOwner, GUILD, "today")).toBeNull();
    });

    it("rejects malformed values before writing, and is denied to shared audiences and forged principals", async () => {
      for (const bad of [
        binding({ contentHash: "xyz" }),
        binding({ guildId: "not-an-id" }),
        binding({ viewKey: "Bad View!" }),
        { ...binding(), extra: "x" },
      ]) {
        await expect(services.overviews.save(owner, bad)).rejects.toBeInstanceOf(ValidationError);
      }
      const shared = await principalFor(ownerId, { audience: "shared" });
      await expect(services.overviews.save(shared, binding())).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(services.overviews.get(shared, GUILD, "today")).rejects.toBeInstanceOf(
        AccessDeniedError,
      );
      await expect(
        services.overviews.save({ ownerId, audience: "private" }, binding()),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect((await handle.pool.query("SELECT 1 FROM discord_overviews"))[0]).toEqual([]);
    });
  });

  describe("preferences", () => {
    it("retains planning constraints across fresh reads and isolates another owner", async () => {
      const settings = [
        { key: "planning.preferred_hours", value: { wed: [{ start: "09:00", end: "17:00" }] } },
        { key: "planning.sleep", value: { start: "23:00", end: "07:00" } },
        { key: "planning.meals", value: [{ start: "12:00", end: "13:00" }] },
        {
          key: "planning.protected_time",
          value: [
            { label: "Commute", weekdays: ["wed"], window: { start: "15:00", end: "16:00" } },
          ],
        },
        { key: "planning.buffer_minutes", value: 15 },
        { key: "planning.min_block_minutes", value: 30 },
        { key: "planning.travel_before_minutes", value: 20 },
      ];
      for (const setting of settings) {
        await services.preferences.set(owner, {
          key: setting.key,
          value: validatePlanningSetting(setting.key, setting.value),
          status: "confirmed",
        });
      }
      const fresh = createServices(handle.db, { clock: () => now });
      const rows = await fresh.preferences.list(owner);
      expect(rows).toHaveLength(settings.length);
      const preferences = parsePlanningPreferences(rows, "America/Chicago");
      expect(preferences.travelBeforeMinutes).toBe(20);
      const result = computeAvailability({
        range: { from: "2026-10-14", to: "2026-10-14" },
        events: [],
        workBlocks: [],
        preferences,
      });
      expect(result.windows.map((window) => window.minutes)).toEqual([180, 120, 60]);
      expect(await fresh.preferences.list(strangerOwner)).toEqual([]);
      const saved = rows.find((row) => row.key === "planning.buffer_minutes")!;
      await fresh.preferences.set(owner, {
        key: saved.key,
        value: 20,
        status: "confirmed",
        expectedVersion: saved.version,
      });
      expect((await services.preferences.get(owner, saved.key))?.value).toBe(20);
    });
    it("persists versioned preferences and requires confirmation to forget them", async () => {
      const saved = await services.preferences.set(owner, {
        key: "planning.bufferMinutes",
        value: { minutes: 15 },
        status: "confirmed",
      });
      expect(saved.version).toBe(1);
      expect((await services.preferences.get(owner, "planning.bufferMinutes"))?.value).toEqual({
        minutes: 15,
      });

      await expect(
        services.preferences.set(owner, {
          key: "planning.bufferMinutes",
          value: { minutes: 30 },
          expectedVersion: 99,
        }),
      ).rejects.toThrow(/changed since you loaded/);

      const proposal = await services.preferences.proposeForget(owner, "planning.bufferMinutes");
      expect(proposal.preview.summary).toContain("planning.bufferMinutes");
      expect(await services.preferences.get(owner, "planning.bufferMinutes")).not.toBeNull();
      await services.confirmations.confirm(owner, {
        confirmationId: proposal.confirmationId,
        payloadHash: proposal.payloadHash,
      });
      expect(await services.preferences.get(owner, "planning.bufferMinutes")).toBeNull();
    });
  });

  describe("validation", () => {
    it("rejects bad input before touching the database", async () => {
      const before = await count(tasks);
      const bad: unknown[] = [
        { title: "" },
        { title: "   " },
        { title: "x".repeat(301) },
        { title: "ok", dueAt: "next friday" },
        { title: "ok", estimatedMinutes: -5 },
        { title: "ok", estimatedMinutes: 1.5 },
        { title: "ok", categoryId: "not-a-uuid" },
        { title: "ok", ownerId: "someone-else" },
        { title: "ok", status: "completed" },
        "just a string",
      ];
      for (const input of bad) {
        await expect(services.tasks.create(owner, input)).rejects.toBeInstanceOf(ValidationError);
      }
      expect(await count(tasks)).toBe(before);
      await expect(
        services.events.create(owner, {
          title: "e",
          startsAt: "2026-10-14T10:00:00Z",
          endsAt: "2026-10-14T09:00:00Z",
          timezone: "America/Chicago",
        }),
      ).rejects.toThrow(/endsAt/);
      await expect(
        services.events.create(owner, {
          title: "e",
          startsAt: "2026-10-14T10:00:00Z",
          endsAt: "2026-10-14T11:00:00Z",
          timezone: "Mars/Base",
        }),
      ).rejects.toThrow(/timezone/);
      await expect(services.tasks.get(owner, "not-a-uuid")).rejects.toBeInstanceOf(ValidationError);
    });

    it("accepts ISO strings and Dates for times", async () => {
      const a = await services.tasks.create(owner, {
        title: "a",
        dueAt: "2026-10-16T04:59:59.123Z",
      });
      const b = await services.tasks.create(owner, {
        title: "b",
        dueAt: new Date("2026-10-17T05:00:00.000Z"),
      });
      expect(a.dueAt?.toISOString()).toBe("2026-10-16T04:59:59.123Z");
      expect(b.dueAt?.toISOString()).toBe("2026-10-17T05:00:00.000Z");
    });
  });

  describe("persisted results, not optimistic success", () => {
    it("returns what MySQL stored, including database defaults", async () => {
      const created = await services.tasks.create(owner, { title: "Stored", estimatedMinutes: 30 });
      const [row] = await handle.db.select().from(tasks).where(eq(tasks.id, created.id));
      expect(created).toEqual(row);
      expect(created).toMatchObject({ version: 1, status: "open", remainingMinutes: 30 });
      expect(created.createdAt).toBeInstanceOf(Date);
    });

    it("returns the completed state as persisted", async () => {
      const task = await services.tasks.create(owner, { title: "Finish me" });
      const { task: done, changed } = await services.tasks.complete(owner, task.id);
      const [row] = await handle.db.select().from(tasks).where(eq(tasks.id, task.id));
      expect(changed).toBe(true);
      expect(done).toEqual(row);
      expect(row?.status).toBe("completed");
    });

    it("leaves no partial records when an operation fails", async () => {
      const otherCategory = await services.categories.create(strangerOwner, "Theirs");
      const before = { tasks: await count(tasks), history: await count(actionHistory) };
      await expect(
        services.tasks.create(owner, { title: "Sneaky", categoryId: otherCategory.id }),
      ).rejects.toThrow(/not found/);
      expect(await count(tasks)).toBe(before.tasks);
      expect(await count(actionHistory)).toBe(before.history);
    });

    it("records who did it, from where, in the same change", async () => {
      const viaDiscord = await principalFor(ownerId, { source: "discord", initiator: "assistant" });
      const task = await services.tasks.create(viaDiscord, { title: "From chat" });
      const history = await services.history.list(owner);
      expect(history.find((h) => h.entityId === task.id)).toMatchObject({
        action: "task.create",
        source: "discord",
      });
    });
  });

  describe("scheduling needs explicit intent", () => {
    const hour = (n: number) => new Date(now.getTime() + n * 3600000);

    it("does not change the schedule on advice, but does on an explicit request", async () => {
      const assistant = await principalFor(ownerId, { source: "discord", initiator: "assistant" });
      const input = { startsAt: hour(24), endsAt: hour(25) };
      await expect(services.workBlocks.create(assistant, input)).rejects.toThrow(/not consent/);
      await expect(
        services.workBlocks.create(assistant, input, { intent: "advice" }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect(await count(workBlocks)).toBe(0);

      const block = await services.workBlocks.create(assistant, input, { intent: "explicit" });
      expect(block.status).toBe("planned");
      expect(await count(workBlocks)).toBe(1);
    });
  });

  describe("listing events and work blocks by range", () => {
    const hour = (n: number) => new Date(now.getTime() + n * 3600000);
    const eventInput = (title: string, from: number, to: number) => ({
      title,
      startsAt: hour(from),
      endsAt: hour(to),
      timezone: "America/Chicago",
    });

    it("returns only overlapping, scheduled events for the owner, earliest first", async () => {
      const late = await services.events.create(owner, eventInput("Late", 30, 31));
      const early = await services.events.create(owner, eventInput("Early", 2, 3));
      await services.events.create(owner, eventInput("Before", -5, -4));
      await services.events.create(owner, eventInput("After", 100, 101));
      const canceled = await services.events.create(owner, eventInput("Canceled", 4, 5));
      await services.events.cancel(owner, canceled.id);
      await services.events.create(strangerOwner, eventInput("Theirs", 2, 3));

      const listed = await services.events.list(owner, { from: hour(0), to: hour(48) });
      expect(listed.map((event) => event.id)).toEqual([early.id, late.id]);

      const all = await services.events.list(owner, {
        from: hour(0),
        to: hour(48),
        includeInactive: true,
      });
      expect(all.map((event) => event.title)).toEqual(["Early", "Canceled", "Late"]);
    });

    it("includes an event that starts before the range but overlaps it", async () => {
      const spanning = await services.events.create(owner, eventInput("Spanning", -2, 2));
      const listed = await services.events.list(owner, { from: hour(0), to: hour(1) });
      expect(listed.map((event) => event.id)).toEqual([spanning.id]);
    });

    it("returns only planned work blocks unless inactive ones are requested", async () => {
      const keep = await services.workBlocks.create(owner, { startsAt: hour(5), endsAt: hour(6) });
      const gone = await services.workBlocks.create(owner, { startsAt: hour(7), endsAt: hour(8) });
      await services.workBlocks.remove(owner, gone.id);
      await services.workBlocks.create(strangerOwner, { startsAt: hour(5), endsAt: hour(6) });

      const planned = await services.workBlocks.list(owner, { from: hour(0), to: hour(24) });
      expect(planned.map((block) => block.id)).toEqual([keep.id]);
      const everything = await services.workBlocks.list(owner, {
        from: hour(0),
        to: hour(24),
        includeInactive: true,
      });
      expect(everything).toHaveLength(2);
    });

    it("rejects unbounded, reversed, or malformed ranges and unauthenticated callers", async () => {
      await expect(
        services.events.list(owner, { from: hour(0), to: hour(24 * 90) }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        services.events.list(owner, { from: hour(5), to: hour(5) }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        services.workBlocks.list(owner, { from: "soon", to: "later" }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        services.events.list({ ownerId }, { from: hour(0), to: hour(1) }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    });
  });

  describe("confirmation for consequential actions", () => {
    async function noteAndProposal() {
      const note = await services.notes.create(owner, {
        title: "Old idea",
        body: "to be removed",
        kind: "idea",
      });
      const proposal = await services.confirmations.propose(owner, {
        action: "note.delete",
        payload: { noteId: note.id },
      });
      return { note, proposal };
    }
    const confirmWith = (
      p: { confirmationId: string; payloadHash: string },
      who: unknown = owner,
    ) =>
      services.confirmations.confirm(who, {
        confirmationId: p.confirmationId,
        payloadHash: p.payloadHash,
      });
    const noteExists = async (id: string) =>
      (await handle.db.select().from(notes).where(eq(notes.id, id))).length === 1;
    const statusOf = async (id: string) =>
      (await handle.db.select().from(confirmations).where(eq(confirmations.id, id)))[0]?.status;

    it("will not run a destructive or consent action directly", async () => {
      const { note } = await noteAndProposal();
      expect(typeof (services as unknown as { notes: Record<string, unknown> }).notes.delete).toBe(
        "undefined",
      );
      expect(() => services.confirmations as never).not.toThrow();
      await expect(
        services.confirmations.propose(owner, { action: "task.create", payload: {} }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        services.confirmations.propose(owner, { action: "tracking.enable", payload: {} }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        services.confirmations.propose(owner, { action: "task.delete", payload: {} }),
      ).rejects.toThrow(/no confirmable handler/);
      expect(await noteExists(note.id)).toBe(true);
    });

    it("proposing changes nothing; confirming executes exactly once and logs it", async () => {
      const { note, proposal } = await noteAndProposal();
      expect(await noteExists(note.id)).toBe(true);
      expect(await statusOf(proposal.confirmationId)).toBe("pending");
      expect(proposal.preview).toMatchObject({ summary: expect.stringContaining("Old idea") });
      expect(proposal.expiresAt.getTime()).toBe(now.getTime() + CONFIRMATION_TTL_MS);

      const outcome = await confirmWith(proposal);
      expect(outcome.result).toEqual({ deleted: "note", id: note.id });
      expect(await noteExists(note.id)).toBe(false);
      expect(await statusOf(proposal.confirmationId)).toBe("executed");

      const history = (await handle.db.select().from(actionHistory)).filter(
        (h) => h.entityId === note.id,
      );
      expect(history.map((h) => h.action).sort()).toEqual(["note.create", "note.delete"]);
      const [stored] = await handle.db
        .select()
        .from(confirmations)
        .where(eq(confirmations.id, proposal.confirmationId));
      expect(JSON.stringify(stored?.preview)).not.toContain("Old idea");
      expect(JSON.stringify(history)).not.toContain("to be removed");

      await expect(confirmWith(proposal)).rejects.toMatchObject({ failure: "already_resolved" });
    });

    it("is valid until exactly ten minutes after it was proposed, then expires and executes nothing", async () => {
      const first = await noteAndProposal();
      const second = await noteAndProposal();

      now = new Date(first.proposal.expiresAt.getTime() - 1);
      await expect(confirmWith(first.proposal)).resolves.toBeDefined();
      expect(await noteExists(first.note.id)).toBe(false);

      now = new Date(second.proposal.expiresAt.getTime());
      await expect(confirmWith(second.proposal)).rejects.toMatchObject({ failure: "expired" });
      expect(await noteExists(second.note.id)).toBe(true);
      expect(await statusOf(second.proposal.confirmationId)).toBe("expired");
      await expect(confirmWith(second.proposal)).rejects.toMatchObject({
        failure: "already_resolved",
      });
    });

    it("is void when the record changed after it was proposed", async () => {
      const { note, proposal } = await noteAndProposal();
      await handle.pool.query(
        "UPDATE notes SET body = 'edited', version = version + 1 WHERE id = ?",
        [note.id],
      );
      const error = await confirmWith(proposal).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(ConfirmationError);
      expect(error).toMatchObject({ failure: "stale" });
      expect(await noteExists(note.id)).toBe(true);
      expect(await statusOf(proposal.confirmationId)).toBe("superseded");
      await expect(confirmWith(proposal)).rejects.toMatchObject({ failure: "already_resolved" });
    });

    it("is void when the record is already gone", async () => {
      const { note, proposal } = await noteAndProposal();
      await handle.pool.query("DELETE FROM notes WHERE id = ?", [note.id]);
      await expect(confirmWith(proposal)).rejects.toMatchObject({ failure: "stale" });
    });

    it("rejects a confirmation that does not match what was previewed", async () => {
      const { note, proposal } = await noteAndProposal();
      await expect(confirmWith({ ...proposal, payloadHash: "0".repeat(64) })).rejects.toMatchObject(
        { failure: "mismatch" },
      );
      expect(await noteExists(note.id)).toBe(true);
      expect(await statusOf(proposal.confirmationId)).toBe("pending");
    });

    it("does not let a stale 'yes' approve a newer or different proposal", async () => {
      const { note, proposal: first } = await noteAndProposal();
      const second = await services.confirmations.propose(owner, {
        action: "note.delete",
        payload: { noteId: note.id },
      });
      expect(second.confirmationId).not.toBe(first.confirmationId);
      expect(await statusOf(first.confirmationId)).toBe("superseded");
      await expect(confirmWith(first)).rejects.toMatchObject({ failure: "already_resolved" });
      expect(await noteExists(note.id)).toBe(true);

      const other = await services.notes.create(owner, { body: "unrelated note" });
      await expect(
        confirmWith({ confirmationId: second.confirmationId, payloadHash: first.payloadHash }),
      ).resolves.toBeDefined();
      expect(await noteExists(other.id)).toBe(true);
    });

    it("cannot be confirmed or proposed by another owner", async () => {
      const { note, proposal } = await noteAndProposal();
      await expect(confirmWith(proposal, strangerOwner)).rejects.toMatchObject({
        failure: "not_found",
      });
      await expect(
        services.confirmations.propose(strangerOwner, {
          action: "note.delete",
          payload: { noteId: note.id },
        }),
      ).rejects.toThrow(/not found/);
      expect(await noteExists(note.id)).toBe(true);
      expect(await statusOf(proposal.confirmationId)).toBe("pending");
    });

    it("cannot be proposed, confirmed, or canceled from a shared channel, even with the right id and hash", async () => {
      const { note, proposal } = await noteAndProposal();
      const inShared = await principalFor(ownerId, {
        source: "discord",
        audience: "shared",
        initiator: "assistant",
      });
      await expect(
        services.confirmations.propose(inShared, {
          action: "note.delete",
          payload: { noteId: note.id },
        }),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(confirmWith(proposal, inShared)).rejects.toBeInstanceOf(AccessDeniedError);
      await expect(
        services.confirmations.cancel(inShared, proposal.confirmationId),
      ).rejects.toBeInstanceOf(AccessDeniedError);
      expect(await noteExists(note.id)).toBe(true);
      expect(await statusOf(proposal.confirmationId)).toBe("pending");
    });

    it("can be canceled, after which it cannot run", async () => {
      const { note, proposal } = await noteAndProposal();
      await services.confirmations.cancel(owner, proposal.confirmationId);
      expect(await statusOf(proposal.confirmationId)).toBe("canceled");
      await expect(confirmWith(proposal)).rejects.toMatchObject({ failure: "already_resolved" });
      expect(await noteExists(note.id)).toBe(true);
    });

    it("rejects malformed payloads", async () => {
      await expect(
        services.confirmations.propose(owner, {
          action: "note.delete",
          payload: { noteId: "nope" },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
      await expect(
        services.confirmations.propose(owner, {
          action: "note.delete",
          payload: { noteId: "x", extra: 1 },
        }),
      ).rejects.toBeInstanceOf(ValidationError);
    });
  });
});
