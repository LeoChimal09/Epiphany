import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseHandle } from "../db/client";
import { createOwner } from "../db/domain";
import { runMigrations } from "../db/migrate";
import { notes, tasks } from "../db/schema";
import { createTestDatabase, dbTestsEnabled, type TestDatabase } from "../db/test-support";
import {
  AccessDeniedError,
  CONFIRMATION_TTL_MS,
  createServices,
  issueOwnerPrincipal,
  type Principal,
  type Services,
} from "../services";
import { createAssistant, emptyConversation, type Assistant } from "./assistant";
import { createBudget, createMemoryUsageStore, type UsageStore } from "./budget";
import type { Intent } from "./intent";
import {
  createScriptedProvider,
  ProviderUnavailableError,
  type InterpretRequest,
} from "./provider";

const migrationsFolder = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));
const TZ = "America/Chicago";

describe.skipIf(!dbTestsEnabled)("assistant against MySQL", () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;
  let services: Services;
  let now: Date;
  let ownerId: string;
  let strangerId: string;
  let assistantPrincipal: Principal;

  const principalFor = (id: string, audience: "private" | "shared" = "private") =>
    issueOwnerPrincipal(handle.db, id, { source: "discord", audience, initiator: "assistant" });

  const usageHolder: { store: UsageStore } = { store: createMemoryUsageStore() };
  const budget = () =>
    createBudget(
      { monthlyLimitUsd: 10, warnPercent: 80, timezone: TZ },
      usageHolder.store,
      () => now,
    );

  function build(
    handler: (request: InterpretRequest) => Intent,
    overrides: Partial<Services> = {},
  ) {
    const provider = createScriptedProvider(handler);
    const assistant: Assistant = createAssistant({
      services: { ...services, ...overrides } as Services,
      provider,
      budget: budget(),
      timezone: TZ,
      clock: () => now,
    });
    return { assistant, provider };
  }

  const say = (
    assistant: Assistant,
    text: string,
    state = emptyConversation(),
    p = assistantPrincipal,
  ) => assistant.handle(p, text, state);

  const taskRows = async () => handle.db.select().from(tasks);
  const statusOf = async (title: string) =>
    (await taskRows()).find((t) => t.title === title)?.status;

  beforeEach(async () => {
    database = await createTestDatabase();
    handle = connectDatabase(database.url);
    await runMigrations(handle.pool, migrationsFolder);
    now = new Date("2026-10-14T15:00:00.000Z");
    usageHolder.store = createMemoryUsageStore();
    services = createServices(handle.db, { clock: () => now });
    ownerId = (
      await createOwner(handle.db, { displayName: "Owner", discordUserId: "100000000000000001" })
    ).id;
    strangerId = (
      await createOwner(handle.db, { displayName: "Stranger", discordUserId: "200000000000000002" })
    ).id;
    assistantPrincipal = await principalFor(ownerId);
  });

  afterEach(async () => {
    await handle.close();
    await database.drop();
    expect(await database.exists()).toBe(false);
  });

  async function seed() {
    const owner = await issueOwnerPrincipal(handle.db, ownerId, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    await services.tasks.create(owner, {
      title: "Chemistry lab report",
      dueAt: "2026-10-16T22:00:00.000Z",
    });
    await services.tasks.create(owner, {
      title: "History essay draft",
      dueAt: "2026-10-15T04:59:00.000Z",
    });
    await services.tasks.create(owner, { title: "Biology quiz prep" });
    await services.tasks.create(owner, { title: "Biology reading" });
    return owner;
  }

  describe("reading", () => {
    it("lists tasks from the records, in the owner's timezone, without changing anything", async () => {
      await seed();
      const { assistant } = build(() => ({ kind: "list_tasks", status: "open" }));
      const { reply, state } = await say(assistant, "what do I have going on?");
      expect(reply.outcome).toBe("listed");
      expect(reply.changed).toBe(false);
      expect(reply.text).toContain("Open tasks (4):");
      expect(reply.text).toContain("Chemistry lab report (due Fri, Oct 16, 5:00 PM)");
      expect(reply.text).toContain("History essay draft (due Wed, Oct 14, 11:59 PM)");
      expect(state.listed).toHaveLength(4);
      expect((await taskRows()).every((t) => t.status === "open")).toBe(true);
    });

    it("filters by local due date and search text", async () => {
      await seed();
      const { assistant } = build((request) =>
        request.message.includes("chem")
          ? { kind: "list_tasks", status: "open", search: "chemistry" }
          : { kind: "list_tasks", status: "open", dueFrom: "2026-10-16", dueThrough: "2026-10-16" },
      );
      expect((await say(assistant, "anything chem?")).reply.text).toBe(
        "Open tasks (1):\n1. Chemistry lab report (due Fri, Oct 16, 5:00 PM)",
      );
      const dated = await say(assistant, "what's due Friday");
      expect(dated.reply.text).toContain("Chemistry lab report");
      expect(dated.reply.text).not.toContain("History");
    });

    it("says plainly when nothing matches", async () => {
      const { assistant } = build(() => ({ kind: "list_tasks", status: "completed" }));
      expect((await say(assistant, "what did I finish?")).reply.text).toBe(
        "No completed tasks match that.",
      );
    });

    it("never shows another owner's records to the model or the reply", async () => {
      await seed();
      const stranger = await issueOwnerPrincipal(handle.db, strangerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
      await services.tasks.create(stranger, { title: "Stranger secret plan" });
      await services.notes.create(stranger, { body: "stranger diary" });
      const { assistant, provider } = build(() => ({ kind: "list_tasks", status: "all" }));
      const { reply } = await say(assistant, "show everything");
      expect(reply.text).not.toContain("Stranger");
      const sent = JSON.stringify(provider.calls[0]);
      expect(sent).not.toContain("Stranger");
      expect(sent).not.toContain("diary");
    });
  });

  describe("creating", () => {
    it("creates a timed task in the owner's timezone and reports what was saved", async () => {
      const { assistant } = build(() => ({
        kind: "create_task",
        title: "Read chapter 4",
        dueDate: "2026-10-16",
        dueTime: "17:00",
        estimatedMinutes: 45,
      }));
      const { reply } = await say(assistant, "remind me to read ch 4 by friday 5pm, 45 min");
      expect(reply).toMatchObject({ outcome: "created", changed: true });
      expect(reply.text).toBe('Added "Read chapter 4" (due Fri, Oct 16, 5:00 PM, about 45 min).');
      const [row] = await taskRows();
      expect(row?.dueAt?.toISOString()).toBe("2026-10-16T22:00:00.000Z");
      expect(row?.dueDateOnly).toBe(false);
      expect(row?.estimatedMinutes).toBe(45);
    });

    it("creates a date-only deadline without inventing a time", async () => {
      const { assistant } = build(() => ({
        kind: "create_task",
        title: "Lab report",
        dueDate: "2026-10-20",
      }));
      const { reply } = await say(assistant, "lab report due the 20th");
      expect(reply.text).toBe('Added "Lab report" (due Tue, Oct 20).');
      const [row] = await taskRows();
      expect(row?.dueDateOnly).toBe(true);
      expect(row?.dueAt?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    });

    it("reports a rejected change as not done", async () => {
      const { assistant } = build(() => ({ kind: "create_task", title: "x".repeat(301) }));
      const { reply } = await say(assistant, "add a very long task");
      expect(reply).toMatchObject({ outcome: "failed", changed: false });
      expect(reply.text).toContain("Nothing was changed");
      expect(await taskRows()).toHaveLength(0);
    });
  });

  describe("completing", () => {
    it("completes the task the owner described, however they word it", async () => {
      await seed();
      const { assistant } = build(() => ({ kind: "complete_task", reference: "the chem lab" }));
      const { reply } = await say(assistant, "finished the chem lab");
      expect(reply).toMatchObject({ outcome: "completed", changed: true });
      expect(reply.text).toBe('Marked "Chemistry lab report" as done.');
      expect(await statusOf("Chemistry lab report")).toBe("completed");
      expect(await statusOf("History essay draft")).toBe("open");
    });

    it("asks which one when the reference is ambiguous, then resolves 'the second one'", async () => {
      await seed();
      const { assistant } = build((request) =>
        request.message === "done with biology"
          ? { kind: "complete_task", reference: "biology" }
          : { kind: "complete_task", reference: "the second one" },
      );
      const first = await say(assistant, "done with biology");
      expect(first.reply.outcome).toBe("clarification");
      expect(first.reply.changed).toBe(false);
      expect(first.reply.text).toContain("Which one do you mean?");
      expect((await taskRows()).every((t) => t.status === "open")).toBe(true);

      const second = await say(assistant, "the second one", first.state);
      expect(second.reply.outcome).toBe("completed");
      const picked = first.state.listed[1]!.title;
      expect(await statusOf(picked)).toBe("completed");
      const completed = (await taskRows()).filter((t) => t.status === "completed");
      expect(completed).toHaveLength(1);
    });

    it("says so when nothing matches and changes nothing", async () => {
      await seed();
      const { assistant } = build(() => ({
        kind: "complete_task",
        reference: "calculus homework",
      }));
      const { reply } = await say(assistant, "finished calculus homework");
      expect(reply).toMatchObject({ outcome: "not_found", changed: false });
      expect((await taskRows()).every((t) => t.status === "open")).toBe(true);
    });

    it("ignores a model-supplied id that is not one of the owner's open tasks", async () => {
      await seed();
      const stranger = await issueOwnerPrincipal(handle.db, strangerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
      const theirs = await services.tasks.create(stranger, { title: "Stranger task" });
      const { assistant } = build(() => ({
        kind: "complete_task",
        reference: "calculus",
        targetId: theirs.id,
      }));
      const { reply } = await say(assistant, "finish calculus");
      expect(reply.outcome).toBe("not_found");
      expect((await handle.db.select().from(tasks).where(eq(tasks.id, theirs.id)))[0]?.status).toBe(
        "open",
      );
    });

    it("does not report success when the change fails", async () => {
      await seed();
      const { assistant } = build(() => ({ kind: "complete_task", reference: "history essay" }), {
        tasks: {
          ...services.tasks,
          complete: async () => {
            throw new Error("database exploded");
          },
        },
      });
      const { reply } = await say(assistant, "finished the history essay");
      expect(reply).toMatchObject({ outcome: "failed", changed: false });
      expect(reply.text).not.toMatch(/marked|done\./i);
      expect(reply.text).not.toContain("exploded");
      expect(await statusOf("History essay draft")).toBe("open");
    });
  });

  describe("advice never mutates", () => {
    it("answers questions about planning without touching records", async () => {
      await seed();
      const before = JSON.stringify(await taskRows());
      const { assistant } = build(() => ({
        kind: "respond",
        text: "Start with the history essay: it is due first.",
      }));
      const { reply } = await say(
        assistant,
        "what should I work on first? maybe finish the chem lab?",
      );
      expect(reply).toMatchObject({ outcome: "answered", changed: false });
      expect(JSON.stringify(await taskRows())).toBe(before);
    });
  });

  describe("confirmation for deletions", () => {
    async function noteFixture() {
      const owner = await issueOwnerPrincipal(handle.db, ownerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
      return services.notes.create(owner, {
        title: "Old brainstorm",
        body: "ideas I no longer need",
      });
    }
    const script = (request: InterpretRequest): Intent => {
      if (request.message.startsWith("delete"))
        return { kind: "delete_note", reference: "old brainstorm" };
      if (request.message === "yes") return { kind: "confirm" };
      if (request.message === "no") return { kind: "decline" };
      return { kind: "respond", text: "ok" };
    };
    const noteCount = async () => (await handle.db.select().from(notes)).length;

    it("asks first, deletes nothing until the owner says yes, then reports it", async () => {
      await noteFixture();
      const { assistant } = build(script);
      const asked = await say(assistant, "delete my old brainstorm note");
      expect(asked.reply).toMatchObject({ outcome: "confirmation_needed", changed: false });
      expect(asked.reply.text).toContain('Reply "yes"');
      expect(await noteCount()).toBe(1);

      const done = await say(assistant, "yes", asked.state);
      expect(done.reply).toMatchObject({ outcome: "deleted", changed: true });
      expect(await noteCount()).toBe(0);
      expect(done.state.pending).toBeNull();
    });

    it("does not delete when the owner declines", async () => {
      await noteFixture();
      const { assistant } = build(script);
      const asked = await say(assistant, "delete the old brainstorm");
      const declined = await say(assistant, "no", asked.state);
      expect(declined.reply).toMatchObject({ outcome: "declined", changed: false });
      expect(await noteCount()).toBe(1);
      // A later yes has nothing to confirm.
      const late = await say(assistant, "yes", declined.state);
      expect(late.reply.text).toBe("There's nothing waiting for your confirmation.");
      expect(await noteCount()).toBe(1);
    });

    it("refuses an expired confirmation and says nothing was deleted", async () => {
      await noteFixture();
      const { assistant } = build(script);
      const asked = await say(assistant, "delete the old brainstorm");
      now = new Date(now.getTime() + CONFIRMATION_TTL_MS + 1000);
      const late = await say(assistant, "yes", asked.state);
      expect(late.reply).toMatchObject({ outcome: "failed", changed: false });
      expect(late.reply.text).toContain("expired");
      expect(late.reply.text).toContain("nothing was deleted");
      expect(await noteCount()).toBe(1);
    });

    it("does not let a confirmation survive an unrelated message", async () => {
      await noteFixture();
      const { assistant } = build(script);
      const asked = await say(assistant, "delete the old brainstorm");
      const chatter = await say(assistant, "what's the weather like", asked.state);
      expect(chatter.state.pending).toBeNull();
      const late = await say(assistant, "yes", chatter.state);
      expect(late.reply.text).toBe("There's nothing waiting for your confirmation.");
      expect(await noteCount()).toBe(1);
    });

    it("voids the confirmation if the note changed after it was proposed", async () => {
      const note = await noteFixture();
      const owner = await issueOwnerPrincipal(handle.db, ownerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
      const { assistant } = build(script);
      const asked = await say(assistant, "delete the old brainstorm");
      await services.notes.update(owner, note.id, { body: "I rewrote this after all" });
      const late = await say(assistant, "yes", asked.state);
      expect(late.reply).toMatchObject({ outcome: "failed", changed: false });
      expect(await noteCount()).toBe(1);
    });
  });

  describe("limits and failures", () => {
    it("stops calling the model at the monthly limit and explains why", async () => {
      await usageHolder.store.add("2026-10", 10);
      const { assistant, provider } = build(() => ({
        kind: "create_task",
        title: "Should not happen",
      }));
      const { reply } = await say(assistant, "add a task");
      expect(reply).toMatchObject({ outcome: "unavailable", changed: false });
      expect(reply.text).toContain("resets on the 1st");
      expect(provider.calls).toHaveLength(0);
      expect(await taskRows()).toHaveLength(0);
    });

    it("records each call's cost against the month", async () => {
      const provider = createScriptedProvider(() => ({ kind: "respond", text: "hi" }), 0.25);
      const assistant = createAssistant({
        services,
        provider,
        budget: budget(),
        timezone: TZ,
        clock: () => now,
      });
      await assistant.handle(assistantPrincipal, "hello");
      await assistant.handle(assistantPrincipal, "hello again");
      expect(await usageHolder.store.spent("2026-10")).toBeCloseTo(0.5, 10);
    });

    it("falls back honestly when the provider is down", async () => {
      await seed();
      const provider = createScriptedProvider(() => {
        throw new ProviderUnavailableError("down");
      });
      const assistant = createAssistant({
        services,
        provider,
        budget: budget(),
        timezone: TZ,
        clock: () => now,
      });
      const { reply } = await assistant.handle(assistantPrincipal, "finished the chem lab");
      expect(reply).toMatchObject({ outcome: "unavailable", changed: false });
      expect(reply.text).toContain("didn't do anything");
      expect((await taskRows()).every((t) => t.status === "open")).toBe(true);
    });

    it("rejects empty and oversized messages without calling the model", async () => {
      const { assistant, provider } = build(() => ({ kind: "respond", text: "hi" }));
      expect((await say(assistant, "   ")).reply.outcome).toBe("answered");
      const long = await say(assistant, "x".repeat(2001));
      expect(long.reply).toMatchObject({ outcome: "failed", changed: false });
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe("who may talk to it", () => {
    it("refuses shared channels without calling the model or reading records", async () => {
      await seed();
      const shared = await principalFor(ownerId, "shared");
      const { assistant, provider } = build(() => ({ kind: "list_tasks", status: "all" }));
      const { reply } = await say(assistant, "list my tasks", emptyConversation(), shared);
      expect(reply).toMatchObject({ outcome: "denied", changed: false });
      expect(reply.text).not.toContain("Chemistry");
      expect(provider.calls).toHaveLength(0);
    });

    it("rejects a forged principal", async () => {
      const { assistant } = build(() => ({ kind: "respond", text: "hi" }));
      const forged = { ownerId, source: "discord", audience: "private", initiator: "assistant" };
      await expect(assistant.handle(forged, "hello")).rejects.toBeInstanceOf(AccessDeniedError);
    });
  });

  describe("context sent to the model", () => {
    it("includes today in the owner's timezone, bounded task lists, and recent turns only", async () => {
      const owner = await issueOwnerPrincipal(handle.db, ownerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
      for (let i = 0; i < 45; i += 1) await services.tasks.create(owner, { title: `Task ${i}` });
      const { assistant, provider } = build(() => ({ kind: "respond", text: "ok" }));
      let state = emptyConversation();
      for (let i = 0; i < 6; i += 1) state = (await say(assistant, `message ${i}`, state)).state;
      const last = provider.calls.at(-1)!;
      expect(last.today).toBe("2026-10-14");
      expect(last.weekday).toBe("Wednesday");
      expect(last.timezone).toBe(TZ);
      expect(last.openTasks).toHaveLength(40);
      expect(last.history.length).toBeLessThanOrEqual(8);
      expect(state.turns.length).toBeLessThanOrEqual(8);
    });
  });
});
