import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { connectDatabase, type DatabaseHandle } from "../db/client";
import { createOwner } from "../db/domain";
import { runMigrations } from "../db/migrate";
import { notes, tasks, workBlocks } from "../db/schema";
import { createTestDatabase, dbTestsEnabled, type TestDatabase } from "../db/test-support";
import {
  AccessDeniedError,
  CONFIRMATION_TTL_MS,
  VersionConflictError,
  createServices,
  issueOwnerPrincipal,
  type Principal,
  type Services,
} from "../services";
import { createAssistant, emptyConversation, type Assistant } from "./assistant";
import { parseConversationState } from "./state";
import { COURSE_LIST_PASTE } from "./course-list.fixture";
import { dateKeyOf } from "../planning/time";
import { parseReminderSettings, runReminderCycle, syncReminders } from "../reminders";
import { createBudget, createMemoryUsageStore, type UsageStore } from "./budget";
import type { Intent } from "./intent";
import type { WorkspaceSetupResult } from "./workspace";
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

  describe("developing saved ideas", () => {
    it("resumes a saved idea after a fresh conversation and sends its body on the next turn", async () => {
      const idea = await services.notes.create(assistantPrincipal, {
        title: "Neighborhood tool library",
        kind: "idea",
        body: "- Concern: Track returns reliably",
      });
      const { assistant, provider } = build((request) =>
        request.message === "return to the library idea"
          ? { kind: "resume_idea", reference: "Neighborhood tool library" }
          : { kind: "respond", text: "We can explore the return-tracking concern." },
      );
      const resumed = await say(assistant, "return to the library idea", emptyConversation());
      expect(resumed.reply.changed).toBe(false);
      expect(resumed.reply.text).toContain("Track returns reliably");
      expect(resumed.state.activeIdea).toEqual({ ownerId, noteId: idea.id });
      await say(assistant, "what about tracking returns?", resumed.state);
      expect(provider.calls.at(-1)?.activeIdea?.body).toBe(idea.body);
      const stored = await services.notes.get(assistantPrincipal, idea.id);
      expect(stored.body).toBe(idea.body);
      expect(stored.version).toBe(idea.version);
    });

    it("does not select an ambiguous or another owner's idea when resuming", async () => {
      for (const title of ["Tool library school", "Tool library neighbors"])
        await services.notes.create(assistantPrincipal, { title, body: "Original", kind: "idea" });
      const ambiguous = build(() => ({ kind: "resume_idea", reference: "tool library" }));
      expect((await say(ambiguous.assistant, "return to tool library")).reply.outcome).toBe(
        "clarification",
      );
      const stranger = await principalFor(strangerId);
      const privateIdea = await services.notes.create(stranger, {
        title: "Private idea",
        body: "Private details",
        kind: "idea",
      });
      const denied = build(() => ({
        kind: "resume_idea",
        reference: "Private idea",
        targetId: privateIdea.id,
      }));
      const result = await say(denied.assistant, "return to private idea");
      expect(result.reply.changed).toBe(false);
      expect(result.reply.text).not.toContain("Private details");
      expect(result.state.activeIdea).toBeNull();
    });

    const original = "A neighborhood library where people can borrow tools.";
    const feedback = "Start with a small trusted group. How would you track returns?";
    function brainstorm() {
      return build((request) =>
        request.message === "save a tool library idea"
          ? {
              kind: "create_note",
              title: "Tool library",
              body: original,
              noteKind: "idea",
              feedback,
            }
          : {
              kind: "develop_idea",
              reference: "this idea",
              points: ["Track return dates", "Suggestion: offer optional reminders"],
              feedback: "Return dates would help. Should borrowing need approval?",
            },
      );
    }

    it("clarifies a stale repeated idea save on an actionable follow-up without writing or inventing timing", async () => {
      const { assistant } = brainstorm();
      const created = await say(assistant, "save a tool library idea");
      const id = created.state.activeIdea!.noteId;
      const before = await services.notes.get(assistantPrincipal, id);
      const stale = build(() => ({
        kind: "create_note",
        title: "Tool library",
        body: original,
        noteKind: "idea",
        feedback: "Saved the reminder for tomorrow at 9!",
      }));
      const result = await say(
        stale.assistant,
        "also remind me about rotating keys",
        created.state,
      );
      expect(result.reply).toMatchObject({ outcome: "clarification", changed: false });
      expect(result.reply.text).toContain("may not match your latest request");
      expect(result.reply.text).toContain("when should I remind you?");
      expect(result.reply.text).not.toContain("tomorrow");
      expect(result.reply.text).not.toContain("Saved");
      expect(result.state.activeIdea).toEqual(created.state.activeIdea);
      expect(stale.provider.calls).toHaveLength(1);
      expect(stale.provider.calls[0]?.activeIdea?.body).toBe(original);
      expect(await services.notes.list(assistantPrincipal)).toHaveLength(1);
      expect(await services.notes.get(assistantPrincipal, id)).toEqual(before);
      expect(await taskRows()).toHaveLength(0);
    });

    it("finds the active idea even outside the recent-note pool and uses its latest saved body", async () => {
      const { assistant } = brainstorm();
      const created = await say(assistant, "save a tool library idea");
      const id = created.state.activeIdea!.noteId;
      const freshBody = "A smaller pilot with hand tools only.";
      await services.notes.update(assistantPrincipal, id, { body: freshBody });
      const stale = build(
        () => ({
          kind: "create_note",
          title: "Tool library",
          body: freshBody,
          noteKind: "idea",
        }),
        { notes: { ...services.notes, list: async () => [] } },
      );
      const result = await say(stale.assistant, "also remind me to renew access", created.state);
      expect(result.reply).toMatchObject({ outcome: "clarification", changed: false });
      expect(result.reply.text).toContain("proposed save repeats");
      expect(stale.provider.calls[0]?.activeIdea?.body).toBe(freshBody);
      expect(await services.notes.list(assistantPrincipal)).toHaveLength(1);
    });

    it("does not silently discard changed content under the same idea title, including after refresh", async () => {
      const { assistant } = brainstorm();
      const created = await say(assistant, "save a tool library idea");
      const revised = build(() => ({
        kind: "create_note",
        title: "Tool library",
        body: "Concern: Lost tools need a replacement policy",
        noteKind: "idea",
      }));
      const result = await say(
        revised.assistant,
        "add a concern about lost tools",
        emptyConversation(),
      );
      expect(result.reply).toMatchObject({ outcome: "clarification", changed: false });
      expect(result.reply.text).toContain("proposed content is different");
      expect(result.reply.text).toContain("new points");
      expect(result.reply.text).not.toContain("already in");
      expect(await services.notes.list(assistantPrincipal)).toHaveLength(1);
      expect(
        (await services.notes.get(assistantPrincipal, created.state.activeIdea!.noteId)).body,
      ).toBe(original);
    });

    it("still saves a genuinely distinct idea during a brainstorm", async () => {
      const { assistant } = brainstorm();
      const created = await say(assistant, "save a tool library idea");
      const distinct = build(() => ({
        kind: "create_note",
        title: "Community garden",
        body: "Share a garden plot",
        noteKind: "idea",
      }));
      const result = await say(distinct.assistant, "save a separate garden idea", created.state);
      expect(result.reply).toMatchObject({ outcome: "created", changed: true });
      expect(await services.notes.list(assistantPrincipal)).toHaveLength(2);
      expect(result.state.activeIdea?.noteId).not.toBe(created.state.activeIdea?.noteId);
    });

    it.each(["note", "idea"] as const)(
      "does not conflate an ordinary note with an idea when saving a %s",
      async (noteKind) => {
        await services.notes.create(assistantPrincipal, {
          title: "Tool library",
          body: original,
          kind: noteKind === "idea" ? "note" : "idea",
        });
        const { assistant } = build(() => ({
          kind: "create_note",
          title: "Tool library",
          body: original,
          noteKind,
        }));
        expect((await say(assistant, "save this separately")).reply.changed).toBe(true);
        expect(await services.notes.list(assistantPrincipal)).toHaveLength(2);
      },
    );

    it("deduplicates only the current owner's ideas and ignores another owner's active state", async () => {
      const stranger = await principalFor(strangerId);
      const privateIdea = await services.notes.create(stranger, {
        title: "Tool library",
        body: "Private contents",
        kind: "idea",
      });
      const { assistant, provider } = brainstorm();
      const result = await say(assistant, "save a tool library idea", {
        ...emptyConversation(),
        activeIdea: { ownerId: strangerId, noteId: privateIdea.id },
      });
      expect(result.reply).toMatchObject({ outcome: "created", changed: true });
      expect(provider.calls[0]?.activeIdea).toBeNull();
      expect(JSON.stringify(provider.calls)).not.toContain("Private contents");
      expect(await services.notes.list(assistantPrincipal)).toHaveLength(1);
      expect((await services.notes.get(stranger, privateIdea.id)).body).toBe("Private contents");
    });

    it("offers feedback and appends bullets to the same idea without duplicating it", async () => {
      const { assistant, provider } = brainstorm();
      const created = await say(assistant, "save a tool library idea");
      expect(created.reply.text).toContain(feedback);
      now = (await services.notes.get(assistantPrincipal, created.state.activeIdea!.noteId))
        .createdAt;
      const restored = parseConversationState(JSON.parse(JSON.stringify(created.state)))!;
      const updated = await say(assistant, "add return dates and reminders", restored);
      const rows = await handle.db.select().from(notes);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        id: created.state.activeIdea?.noteId,
        kind: "idea",
        body: `## ${dateKeyOf(now, TZ)}\n\n${original}\n\n- Note: Track return dates\n- Suggestion: offer optional reminders`,
      });
      expect(provider.calls).toHaveLength(2);
      expect(provider.calls[1]?.activeIdea).toMatchObject({
        id: rows[0]!.id,
        body: original,
        truncated: false,
      });
      expect(updated.reply.text).toContain("Should borrowing need approval?");
      const repeated = await say(assistant, "add those points again", updated.state);
      expect(repeated.reply.changed).toBe(false);
      expect(repeated.reply.text).toContain("didn't add duplicates");
      expect((await services.notes.get(assistantPrincipal, rows[0]!.id)).body).toBe(rows[0]!.body);
    });

    it("uses the latest idea body rather than an old conversational summary", async () => {
      const { assistant, provider } = brainstorm();
      const created = await say(assistant, "save a tool library idea");
      const id = created.state.activeIdea!.noteId;
      now = (await services.notes.get(assistantPrincipal, id)).createdAt;
      await services.notes.update(assistantPrincipal, id, {
        body: `${original}\n\n- Start with hand tools only`,
      });
      await say(assistant, "add a way to track returns", created.state);
      expect(provider.calls.at(-1)?.activeIdea?.body).toContain("Start with hand tools only");
      expect((await services.notes.get(assistantPrincipal, id)).body).toContain(
        "- Start with hand tools only\n\n- Note: Track return dates",
      );
    });

    it("persists concerns and custom labels once per local day, then starts a new day", async () => {
      const { assistant } = brainstorm();
      const created = await say(assistant, "save a tool library idea");
      const id = created.state.activeIdea!.noteId;
      await handle.db.update(notes).set({ createdAt: now }).where(eq(notes.id, id));
      const followup = build(() => ({
        kind: "develop_idea",
        reference: "this idea",
        points: ["Concern: Tools may go missing", "Goal: Explore manageable return tracking"],
      }));
      now = new Date("2026-10-15T03:30:00Z");
      const first = await say(
        followup.assistant,
        "I'm skeptical about handling missing tools",
        created.state,
      );
      const custom = build(() => ({
        kind: "develop_idea",
        reference: "this idea",
        points: ["Pilot scope: Start with a small neighborhood"],
      }));
      await say(custom.assistant, "start small", first.state);
      let saved = await services.notes.get(assistantPrincipal, id);
      expect(saved.body.match(/## 2026-10-14/g)).toHaveLength(1);
      expect(saved.body).not.toContain("## 2026-10-15");
      expect(saved.body).toContain("- Concern: Tools may go missing");
      expect(saved.body).toContain("- Pilot scope: Start with a small neighborhood");
      now = new Date("2026-10-15T16:00:00Z");
      const nextDay = build(() => ({
        kind: "develop_idea",
        reference: "this idea",
        points: ["Open question: Who repairs tools?"],
      }));
      await say(nextDay.assistant, "what about maintenance?", first.state);
      saved = await services.notes.get(assistantPrincipal, id);
      expect(saved.body).toContain("## 2026-10-15\n\n- Open question: Who repairs tools?");
      expect(await handle.db.select().from(notes)).toHaveLength(1);
    });

    it("does not persist opinions or no-save brainstorming", async () => {
      const { assistant } = brainstorm();
      const created = await say(assistant, "save a tool library idea");
      const result = await say(
        assistant,
        "don't save this, just chatting about reminders",
        created.state,
      );
      expect(result.reply.changed).toBe(false);
      const opinion = build(() => ({ kind: "respond", text: "A small pilot is a good start." }));
      expect(
        (await say(opinion.assistant, "what do you think?", created.state)).reply.changed,
      ).toBe(false);
      expect(
        (await services.notes.get(assistantPrincipal, created.state.activeIdea!.noteId)).body,
      ).toBe(original);
    });

    it("asks which idea when the reference is ambiguous or has no active target", async () => {
      for (const title of ["Tool library for neighbors", "Tool library for school"]) {
        await services.notes.create(assistantPrincipal, { title, body: "Original", kind: "idea" });
      }
      const { assistant } = build(() => ({
        kind: "develop_idea",
        reference: "tool library",
        points: ["Track returns"],
      }));
      expect((await say(assistant, "expand the tool library")).reply).toMatchObject({
        outcome: "clarification",
        changed: false,
      });
      const missing = build(() => ({
        kind: "develop_idea",
        reference: "this idea",
        points: ["Track returns"],
      }));
      expect((await say(missing.assistant, "expand this")).reply.outcome).toBe("clarification");
      expect(await handle.db.select().from(notes)).toHaveLength(2);
    });

    it("never exposes or modifies another owner's idea or answers shared audiences", async () => {
      const stranger = await principalFor(strangerId);
      const idea = await services.notes.create(stranger, {
        title: "Private stranger idea",
        body: "Private contents",
        kind: "idea",
      });
      await expect(services.notes.get(assistantPrincipal, idea.id)).rejects.toThrow();
      const { assistant, provider } = build(() => ({
        kind: "develop_idea",
        reference: "this idea",
        targetId: idea.id,
        points: ["Not allowed"],
      }));
      const state = { ...emptyConversation(), activeIdea: { ownerId, noteId: idea.id } };
      expect((await say(assistant, "expand this idea", state)).reply.changed).toBe(false);
      expect(provider.calls[0]?.activeIdea).toBeNull();
      expect(JSON.stringify(provider.calls)).not.toContain("Private contents");
      const shared = await say(
        assistant,
        "expand this idea",
        state,
        await principalFor(ownerId, "shared"),
      );
      expect(shared.reply.outcome).toBe("denied");
      expect(provider.calls).toHaveLength(1);
      expect((await services.notes.get(stranger, idea.id)).body).toBe("Private contents");
    });

    it("refuses to overwrite a concurrent edit", async () => {
      const { assistant } = brainstorm();
      const created = await say(assistant, "save a tool library idea");
      const update = vi
        .spyOn(services.notes, "update")
        .mockRejectedValueOnce(new VersionConflictError("Note", 2));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await say(assistant, "add return dates", created.state);
        expect(result.reply).toMatchObject({ outcome: "failed", changed: false });
        expect(result.reply.text).toContain("didn't overwrite");
        expect(
          (await services.notes.get(assistantPrincipal, created.state.activeIdea!.noteId)).body,
        ).toBe(original);
      } finally {
        update.mockRestore();
        log.mockRestore();
      }
    });
  });

  describe("reading", () => {
    it("lists tasks from the records, in the owner's timezone, without changing anything", async () => {
      await seed();
      const { assistant } = build(() => ({ kind: "list_tasks", status: "open" }));
      const { reply, state } = await say(assistant, "what do I have going on?");
      expect(reply.outcome).toBe("listed");
      expect(reply.changed).toBe(false);
      expect(reply.text).toContain("Open tasks (4):");
      expect(reply.text).toContain("Chemistry lab report (minor, due Fri, Oct 16, 5:00 PM)");
      expect(reply.text).toContain("History essay draft (minor, due Wed, Oct 14, 11:59 PM)");
      expect(reply.text).toContain("Biology reading (to-do)");
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
        "Open tasks (1):\n1. Chemistry lab report (minor, due Fri, Oct 16, 5:00 PM)\nWant me to check any of these off?",
      );
      const dated = await say(assistant, "what's due Friday");
      expect(dated.reply.text).toContain("Chemistry lab report");
      expect(dated.reply.text).not.toContain("History");
    });

    it("says plainly when nothing matches", async () => {
      const { assistant } = build(() => ({ kind: "list_tasks", status: "completed" }));
      expect((await say(assistant, "what did I finish?")).reply.text).toBe(
        "I don't see any completed tasks that match that. Want me to look at something else?",
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
      expect(reply.text).toBe(
        'Got it, I added "Read chapter 4" to your list (due Fri, Oct 16, 5:00 PM, about 45 min).',
      );
      const [row] = await taskRows();
      expect(row?.dueAt?.toISOString()).toBe("2026-10-16T22:00:00.000Z");
      expect(row?.dueDateOnly).toBe(false);
      expect(row?.estimatedMinutes).toBe(45);
    });

    it("creates an event interval from its explicit start and end times", async () => {
      const { assistant } = build(() => ({
        kind: "create_event",
        title: "Head home",
        date: "2026-10-16",
        startTime: "16:30",
        endTime: "17:00",
      }));
      const { reply } = await say(assistant, "add head home to my calendar from 4:30 to 5");
      expect(reply.text).toContain("Fri, Oct 16 from 4:30 PM to 5:00 PM");
      const events = await services.events.list(assistantPrincipal, {
        from: new Date("2026-10-16T00:00:00.000Z"),
        to: new Date("2026-10-17T00:00:00.000Z"),
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        title: "Head home",
        startsAt: new Date("2026-10-16T21:30:00.000Z"),
        endsAt: new Date("2026-10-16T22:00:00.000Z"),
      });
      expect(await taskRows()).toHaveLength(0);
    });

    it("creates a date-only deadline without inventing a time", async () => {
      const { assistant } = build(() => ({
        kind: "create_task",
        title: "Lab report",
        dueDate: "2026-10-20",
      }));
      const { reply } = await say(assistant, "lab report due the 20th");
      expect(reply.text).toBe(
        'Got it, I added "Lab report" to your list (due Tue, Oct 20). Do you know how long it might take? That\'s optional; you can leave it as-is or add an estimate later.',
      );
      const [row] = await taskRows();
      expect(row?.dueDateOnly).toBe(true);
      expect(row?.dueAt?.toISOString()).toBe("2026-10-20T00:00:00.000Z");
    });

    it("asks a fixed optional timing question when a task has no date or estimate", async () => {
      const { assistant } = build(() => ({ kind: "create_task", title: "Read a book" }));
      const { reply } = await say(assistant, "add read a book");

      expect(reply.text).toContain(
        "Do you know when it's due or how long it might take? That's optional",
      );
      expect(reply.text).toContain("you can leave it as-is");
      expect(await taskRows()).toHaveLength(1);
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
      expect(reply.text).toContain('Nice, I marked "Chemistry lab report" as done.');
      expect(reply.text).toContain("well ahead of the deadline");
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
    it("answers routine messages without model calls, record reads, or remaining AI budget", async () => {
      await usageHolder.store.add("2026-10", 10);
      const { assistant, provider } = build(() => {
        throw new Error("routine messages must not use the model");
      });
      const tasksRead = vi.spyOn(services.tasks, "list");
      const notesRead = vi.spyOn(services.notes, "list");
      const preferencesRead = vi.spyOn(services.preferences, "list");
      const categoriesRead = vi.spyOn(services.categories, "list");
      for (const text of ["hello", "thank you", "yes", "no"]) {
        const result = await say(assistant, text);
        expect(result.reply.changed).toBe(false);
        expect(result.reply.outcome).toBe("answered");
      }
      expect(provider.calls).toHaveLength(0);
      expect(tasksRead).not.toHaveBeenCalled();
      expect(notesRead).not.toHaveBeenCalled();
      expect(preferencesRead).not.toHaveBeenCalled();
      expect(categoriesRead).not.toHaveBeenCalled();
      expect(await usageHolder.store.spent("2026-10")).toBe(10);
    });

    it("does not mistake a greeting with an action for a routine message", async () => {
      const { assistant, provider } = build(() => ({
        kind: "create_task",
        title: "History essay",
      }));
      const result = await say(assistant, "hi, add my history essay");
      expect(result.reply.changed).toBe(true);
      expect(provider.calls).toHaveLength(1);
    });

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
      await assistant.handle(assistantPrincipal, "what should I work on first?");
      await assistant.handle(assistantPrincipal, "how should I approach my essay?");
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

    it("logs why the provider failed, without the message or any secret", async () => {
      const logged: string[] = [];
      const spy = vi.spyOn(console, "error").mockImplementation((line) => {
        logged.push(String(line));
      });
      try {
        const provider = createScriptedProvider(() => {
          throw new ProviderUnavailableError("The AI service returned HTTP 403.", false);
        });
        const assistant = createAssistant({
          services,
          provider,
          budget: budget(),
          timezone: TZ,
          clock: () => now,
        });
        await assistant.handle(assistantPrincipal, "my secret message text");
      } finally {
        spy.mockRestore();
      }
      expect(logged).toHaveLength(1);
      expect(JSON.parse(logged[0]!)).toEqual({
        service: "assistant",
        event: "interpret_failed",
        message: "The AI service returned HTTP 403.",
        retryable: false,
      });
      expect(logged[0]).not.toContain("secret message");
    });

    it("rejects empty and oversized messages without calling the model", async () => {
      const { assistant, provider } = build(() => ({ kind: "respond", text: "hi" }));
      expect((await say(assistant, "   ")).reply.outcome).toBe("answered");
      const long = await say(assistant, "x".repeat(8001));
      expect(long.reply).toMatchObject({ outcome: "failed", changed: false });
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe("homework intake and sorting", () => {
    it("previews and persists every assignment in the supplied course paste with zero model calls", async () => {
      now = new Date("2026-10-21T18:00:00.000Z");
      await usageHolder.store.add("2026-10", 10);
      const { assistant, provider } = build(() => {
        throw new Error("must not call AI");
      });
      const preview = await assistant.handle(
        assistantPrincipal,
        COURSE_LIST_PASTE,
        emptyConversation(),
        {
          sourceRef: "discord:test-channel/test-message",
        },
      );
      expect(preview.reply).toMatchObject({ outcome: "confirmation_needed", changed: false });
      expect(preview.state.pendingCapture?.items).toHaveLength(6);
      expect(await taskRows()).toHaveLength(0);
      const saved = await say(assistant, "yes", preview.state);
      expect(saved.reply.changed).toBe(true);
      const rows = await taskRows();
      expect(rows).toHaveLength(6);
      expect(rows.every((row) => row.sourceText === COURSE_LIST_PASTE)).toBe(true);
      expect(rows.every((row) => row.sourceRef === "discord:test-channel/test-message")).toBe(true);
      expect(rows.find((row) => row.title === "Homework 8")?.dueAt?.toISOString()).toBe(
        "2026-10-23T04:59:00.000Z",
      );
      expect(rows.find((row) => row.title === "Oct 26 Notes Check")?.dueAt?.toISOString()).toBe(
        "2026-10-26T16:00:00.000Z",
      );
      expect(provider.calls).toHaveLength(0);
    });

    it("previews and saves ten independent goals without reducing them to one task", async () => {
      const titles = [
        "Book dentist",
        "Finish essay",
        "Buy groceries",
        "Update resume",
        "Plan workout",
        "Fix bicycle",
        "Read chapter seven",
        "Clean kitchen",
        "Call mechanic",
        "Build portfolio",
      ];
      const paste = `Add these goals:\n${titles.map((title, i) => `${i + 1}. ${title}`).join("\n")}`;
      const { assistant, provider } = build(() => ({
        kind: "capture",
        items: titles.map((title) => ({ type: "task", title })),
      }));
      const preview = await say(assistant, paste);
      expect(preview.reply).toMatchObject({ outcome: "confirmation_needed", changed: false });
      expect(preview.reply.text).toContain("10. [task] Build portfolio");
      expect(provider.calls[0]?.listedEntryCount).toBe(10);
      expect(await taskRows()).toHaveLength(0);
      await say(assistant, "yes", preview.state);
      expect((await taskRows()).map((task) => task.title).sort()).toEqual([...titles].sort());
      expect(provider.calls).toHaveLength(1);
    });

    it.each(["create_task", "capture"] as const)(
      "blocks incomplete %s extraction of a ten-item list",
      async (kind) => {
        const paste = `Add these goals:\n${Array.from({ length: 10 }, (_, i) => `${i + 1}. Goal ${i + 1}`).join("\n")}`;
        const { assistant } = build(() =>
          kind === "create_task"
            ? { kind, title: "Goal 1" }
            : { kind, items: [{ type: "task", title: "Goal 1" }] },
        );
        const result = await say(assistant, paste);
        expect(result.reply).toMatchObject({ outcome: "clarification", changed: false });
        expect(result.reply.text).toContain("10 list entries");
        expect(result.reply.text).toContain("only extracted 1 item");
        expect(result.state.pendingCapture).toBeNull();
        expect(await taskRows()).toHaveLength(0);
      },
    );

    async function reviewAndApprove(assistant: Assistant, text: string) {
      const preview = await say(assistant, text);
      return preview.state.pendingCapture ? say(assistant, "yes", preview.state) : preview;
    }

    const ownerPrincipal = () =>
      issueOwnerPrincipal(handle.db, ownerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
    const noteRows = async () => handle.db.select().from(notes);
    const categoryName = async (categoryId: string) =>
      (await services.categories.list(await ownerPrincipal())).find((c) => c.id === categoryId)
        ?.name;
    const MIXED =
      "essay due friday, remind me to start tomorrow, and save this app idea: a habit tracker";

    it("approves a reviewed import with no second model call, even after the budget is exhausted", async () => {
      const { assistant, provider } = build(() => ({
        kind: "capture",
        items: [
          { type: "task", title: "Discussion 1", details: "MATH-225-001" },
          { type: "task", title: "Discussion 1", details: "HIST-101-001" },
        ],
      }));
      const preview = await say(assistant, "two courses, both have Discussion 1");
      expect(preview.reply.text).toContain("MATH-225-001");
      expect(preview.reply.text).toContain("HIST-101-001");
      expect(preview.reply.text).toContain("needs review: no due date given");
      expect(await taskRows()).toHaveLength(0);
      const restored = parseConversationState(JSON.parse(JSON.stringify(preview.state)));
      expect(restored).not.toBeNull();
      await usageHolder.store.add("2026-10", 10);
      const saved = await say(assistant, "save these", restored!);
      expect(saved.reply).toMatchObject({ outcome: "created", changed: true });
      expect(saved.state.pendingCapture).toBeNull();
      expect(provider.calls).toHaveLength(1);
      expect(await taskRows()).toHaveLength(2);
      expect((await taskRows()).every((row) => row.reviewNote === "no due date given")).toBe(true);
      const repeated = await say(assistant, "yes", saved.state);
      expect(repeated.reply.changed).toBe(false);
      expect(await taskRows()).toHaveLength(2);
      expect(provider.calls).toHaveLength(1);
    });

    it("discards declined, expired, cross-owner, and superseded import previews", async () => {
      const { assistant, provider } = build(() => ({
        kind: "capture",
        items: [
          { type: "task", title: "Math worksheet" },
          { type: "task", title: "Read chapter 7" },
        ],
      }));
      const preview = await say(assistant, "worksheet and reading");
      const declined = await say(assistant, "no", preview.state);
      expect(declined.state.pendingCapture).toBeNull();
      expect((await say(assistant, "yes", declined.state)).reply.changed).toBe(false);
      const unrelated = await say(assistant, "hi", preview.state);
      expect(unrelated.state.pendingCapture).toBeNull();
      expect((await say(assistant, "yes", unrelated.state)).reply.changed).toBe(false);
      const otherOwner = await say(assistant, "yes", preview.state, await principalFor(strangerId));
      expect(otherOwner.reply).toMatchObject({ outcome: "failed", changed: false });
      const shared = await say(
        assistant,
        "yes",
        preview.state,
        await principalFor(ownerId, "shared"),
      );
      expect(shared.reply.outcome).toBe("denied");
      now = new Date(now.getTime() + CONFIRMATION_TTL_MS);
      const expired = await say(assistant, "yes", preview.state);
      expect(expired.reply.text).toContain("expired");
      expect(expired.state.pendingCapture).toBeNull();
      expect(await taskRows()).toHaveLength(0);
      expect(provider.calls).toHaveLength(1);
    });

    it("rechecks duplicates against records created after the preview", async () => {
      const { assistant } = build(() => ({
        kind: "capture",
        items: [
          { type: "task", title: "Math worksheet" },
          { type: "task", title: "Read chapter 7" },
        ],
      }));
      const preview = await say(assistant, "worksheet and reading");
      await services.tasks.create(await ownerPrincipal(), { title: "Math worksheet" });
      const approved = await say(assistant, "yes", preview.state);
      expect(approved.reply.text).toContain('I skipped "Math worksheet"');
      expect(await taskRows()).toHaveLength(2);
    });

    it("reports partial import failures without hiding the successfully saved items", async () => {
      const actualCreate = services.tasks.create;
      const { assistant } = build(() => ({
        kind: "capture",
        items: [
          { type: "task", title: "First assignment" },
          { type: "task", title: "Second assignment" },
        ],
      }));
      const create = vi
        .spyOn(services.tasks, "create")
        .mockImplementationOnce(actualCreate)
        .mockRejectedValueOnce(new Error("database unavailable"));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const saved = await reviewAndApprove(assistant, "first and second assignment");
        expect(saved.reply).toMatchObject({ outcome: "uncertain", changed: true });
        expect(saved.reply.text).toContain("saved that");
        expect(saved.reply.text).toContain('couldn\'t verify whether "Second assignment"');
        expect(saved.reply.text).toContain("check your Inbox before retrying");
        expect((await taskRows()).map((row) => row.title)).toEqual(["First assignment"]);
        expect(log).toHaveBeenCalledWith(expect.stringContaining("capture_item_failed"));
        expect(saved.state.pendingCapture).toBeNull();
      } finally {
        create.mockRestore();
        log.mockRestore();
      }
    });

    it("does not claim nothing was saved after an unverified write", async () => {
      const { assistant } = build(() => ({
        kind: "capture",
        items: [
          { type: "task", title: "First assignment" },
          { type: "task", title: "Second assignment" },
        ],
      }));
      const create = vi
        .spyOn(services.tasks, "create")
        .mockRejectedValue(new Error("connection lost during save"));
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const result = await reviewAndApprove(assistant, "first and second assignment");
        expect(result.reply).toMatchObject({ outcome: "uncertain", changed: false });
        expect(result.reply.text).toContain("couldn't verify");
        expect(result.reply.text).not.toContain("nothing was stored");
        expect(result.reply.text).not.toContain("nothing was changed");
        expect(result.state.pendingCapture).toBeNull();
      } finally {
        create.mockRestore();
        log.mockRestore();
      }
    });

    it("turns one out-of-order message into separate assignment and idea records, linked to the message", async () => {
      const { assistant } = build(() => ({
        kind: "capture",
        items: [
          { type: "idea", title: "Habit tracker app", details: "An app that tracks habits" },
          { type: "task", title: "History essay", dueDate: "2026-10-16" },
        ],
      }));
      const preview = await assistant.handle(assistantPrincipal, MIXED, emptyConversation(), {
        sourceRef: "discord:chan-1/msg-9",
      });
      expect(preview.reply).toMatchObject({ outcome: "confirmation_needed", changed: false });
      expect(preview.reply.text).toContain("1. [idea] Habit tracker app");
      expect(preview.reply.text).toContain("2. [task] History essay");
      expect(await taskRows()).toHaveLength(0);
      expect(await noteRows()).toHaveLength(0);
      const { reply, state } = await say(assistant, "yes", preview.state);

      expect(reply).toMatchObject({ outcome: "created", changed: true });
      expect(reply.text).toContain("1. History essay (due Fri, Oct 16)");
      expect(reply.text).toContain('idea "Habit tracker app"');

      const [task] = await taskRows();
      expect(task).toMatchObject({
        title: "History essay",
        sourceText: MIXED,
        sourceRef: "discord:chan-1/msg-9",
        reviewNote: null,
      });
      expect(await categoryName(task!.categoryId)).toBe("Inbox");
      const [note] = await noteRows();
      expect(note).toMatchObject({
        kind: "idea",
        title: "Habit tracker app",
        sourceRef: "discord:chan-1/msg-9",
      });
      expect(await categoryName(note!.categoryId)).toBe("Inbox");
      expect(await taskRows()).toHaveLength(1);
      expect(await noteRows()).toHaveLength(1);
      expect(state.listed.map((item) => item.title)).toEqual(["History essay"]);
    });

    it("saves every item of a long pasted list and keeps the reply short", async () => {
      const items = Array.from({ length: 15 }, (_, index) => ({
        type: "task" as const,
        title: `Assignment ${index + 1}`,
        details: `MATH-225-001, ${index + 1} pts`,
        dueDate: "2026-10-22",
        dueTime: "23:59",
      }));
      const { assistant } = build(() => ({ kind: "capture", items }));
      const paste = `canvas paste: ${"Assignment | Go to course 5 pts 10/22/2026 11:59 PM ".repeat(60)}`;
      expect(paste.length).toBeGreaterThan(2000);
      const preview = await say(assistant, paste);
      expect(preview.reply.text).toContain("15. [task] Assignment 15");
      expect(await taskRows()).toHaveLength(0);
      const { reply, state } = await say(assistant, "yes", preview.state);
      expect(await taskRows()).toHaveLength(15);
      expect(reply.text).toContain("saved 15 things");
      expect(reply.text).toContain("...and 3 more, all saved");
      expect(reply.text).toContain("12. Assignment 12");
      expect(reply.text).not.toContain("13. Assignment 13");
      expect(state.listed).toHaveLength(12);
      const [first] = await taskRows();
      expect(first?.sourceText).toBe(paste.trim());
      expect(first?.dueAt?.toISOString()).toBe("2026-10-23T04:59:00.000Z");
    });

    it("tells the owner when a paste is more than it can handle, and saves nothing", async () => {
      const tooBig = createAssistant({
        services,
        provider: createScriptedProvider(() => {
          throw new ProviderUnavailableError("The AI service ran out of room.", false, true);
        }),
        budget: budget(),
        timezone: TZ,
        clock: () => now,
      });
      const { reply } = await say(tooBig, "a huge paste");
      expect(reply).toMatchObject({ outcome: "failed", changed: false });
      expect(reply.text).toContain("more than I can work through in one go");
      expect(reply.text).toContain("smaller pieces");
      expect(await taskRows()).toHaveLength(0);
    });

    it("says how many items it left out when a paste has more than it takes at once", async () => {
      const { assistant } = build(() => ({
        kind: "capture",
        items: [
          { type: "task", title: "One" },
          { type: "task", title: "Two" },
        ],
        omitted: 7,
      }));
      const preview = await say(assistant, "lots of homework");
      expect(preview.reply.text).toContain("7 more items were left out");
      const { reply } = await say(assistant, "yes", preview.state);
      expect(reply.text).toContain("first 2 items and left 7 more out");
      expect(reply.text).toContain("Send the rest");
      expect(reply.text).not.toContain("skim your Inbox");
    });

    it("reminds the owner to skim a longer paste, since messy text can be misread", async () => {
      const { assistant } = build(() => ({
        kind: "capture",
        items: ["A", "B", "C", "D"].map((title) => ({ type: "task" as const, title })),
      }));
      const { reply } = await reviewAndApprove(assistant, "four things");
      expect(reply.text).toContain("skim your Inbox");
    });

    it("flags a missing or unclear date for review and does not invent one", async () => {
      const { assistant } = build(() => ({
        kind: "capture",
        items: [
          { type: "task", title: "Read chapter 7", review: "no due date given" },
          { type: "task", title: "Lab write-up", review: "date unclear: said sometime next week" },
          { type: "task", title: "Quiz prep", dueDate: "2026-10-19" },
        ],
      }));
      const { reply } = await reviewAndApprove(assistant, "pasted homework block");
      const rows = await taskRows();
      expect(rows.find((t) => t.title === "Read chapter 7")).toMatchObject({
        dueAt: null,
        reviewNote: "no due date given",
      });
      expect(rows.find((t) => t.title === "Lab write-up")?.dueAt).toBeNull();
      expect(rows.find((t) => t.title === "Quiz prep")).toMatchObject({ reviewNote: null });
      expect(reply.text).toContain("need a look");
      expect(reply.text).toContain("no due date given");
    });

    it("clears the review flag once the owner supplies a date", async () => {
      const { assistant } = build(() => ({
        kind: "capture",
        items: [{ type: "task", title: "Read chapter 7", review: "no due date given" }],
      }));
      await say(assistant, "read chapter 7");
      const [task] = await taskRows();
      const owner = await ownerPrincipal();
      const { task: updated } = await services.tasks.update(owner, task!.id, {
        dueAt: "2026-10-20T05:00:00.000Z",
        expectedVersion: task!.version,
      });
      expect(updated.reviewNote).toBeNull();
    });

    it("sorts into an existing category, and falls back to the Inbox for an unknown one", async () => {
      const owner = await ownerPrincipal();
      const school = await services.categories.create(owner, "School");
      const { assistant } = build(() => ({
        kind: "capture",
        items: [
          { type: "task", title: "Chem lab", dueDate: "2026-10-16", category: "school" },
          { type: "task", title: "Gym session", category: "Fitness" },
        ],
      }));
      const { reply } = await reviewAndApprove(assistant, "chem lab due friday and gym later");
      const rows = await taskRows();
      expect(rows.find((t) => t.title === "Chem lab")?.categoryId).toBe(school.id);
      expect(await categoryName(rows.find((t) => t.title === "Gym session")!.categoryId)).toBe(
        "Inbox",
      );
      expect(reply.text).toContain('I don\'t have a "Fitness" category');
      expect((await services.categories.list(owner)).map((c) => c.name)).not.toContain("Fitness");
    });

    it("does not save a duplicate of an open task, in storage or within the same message", async () => {
      await seed();
      const { assistant } = build(() => ({
        kind: "capture",
        items: [
          { type: "task", title: "Chem lab report", dueDate: "2026-10-16" },
          { type: "task", title: "Math worksheet" },
          { type: "task", title: "math worksheet!" },
        ],
      }));
      const { reply } = await reviewAndApprove(assistant, "chem lab report friday, math worksheet");
      const titles = (await taskRows()).map((t) => t.title);
      expect(titles.filter((t) => /chem/i.test(t))).toEqual(["Chemistry lab report"]);
      expect(titles.filter((t) => /math/i.test(t))).toEqual(["Math worksheet"]);
      expect(reply.text).toContain(
        'I skipped "Chem lab report" because you already have "Chemistry lab report"',
      );
      expect(reply.text).toContain('I skipped "math worksheet!"');
    });

    it("keeps one bad item from blocking the others and says which failed", async () => {
      const { assistant } = build(() => ({
        kind: "capture",
        items: [
          { type: "task", title: "x".repeat(301) },
          { type: "task", title: "Good one" },
        ],
      }));
      const { reply } = await reviewAndApprove(assistant, "two things");
      expect((await taskRows()).map((t) => t.title)).toEqual(["Good one"]);
      expect(reply.text).toContain("couldn't save");
      expect(reply).toMatchObject({ outcome: "created", changed: true });
    });

    it("saves nothing from chatter, advice, or a message that says not to save", async () => {
      const chatty = build(() => ({ kind: "respond", text: "Sounds like a busy week!" }));
      await say(chatty.assistant, "ugh, so much homework this week");

      for (const message of [
        "just chatting: my essay is due friday lol",
        "don't save this, but I have a lab report due monday",
      ]) {
        const eager = build(() => ({
          kind: "capture",
          items: [{ type: "task", title: "Essay", dueDate: "2026-10-16" }],
        }));
        const { reply } = await say(eager.assistant, message);
        expect(reply).toMatchObject({ outcome: "answered", changed: false });
        expect(reply.text).toContain("won't save");
      }
      const single = build(() => ({ kind: "create_task", title: "Lab report" }));
      await say(single.assistant, "don't make that a task, just thinking out loud");
      const idea = build(() => ({ kind: "create_note", body: "x", noteKind: "idea" }));
      await say(idea.assistant, "off the record, an idea");

      expect(await taskRows()).toHaveLength(0);
      expect(await noteRows()).toHaveLength(0);
    });

    it("links a single created task to its source message too", async () => {
      const { assistant } = build(() => ({ kind: "create_task", title: "Read chapter 4" }));
      await assistant.handle(assistantPrincipal, "remind me to read ch 4", emptyConversation(), {
        sourceRef: "dashboard:ask-epi",
      });
      expect((await taskRows())[0]).toMatchObject({
        sourceText: "remind me to read ch 4",
        sourceRef: "dashboard:ask-epi",
      });
    });

    describe("corrections", () => {
      it("moves the item just created when the owner says it belongs elsewhere", async () => {
        const owner = await ownerPrincipal();
        const school = await services.categories.create(owner, "School");
        const { assistant } = build((request) =>
          request.message.startsWith("that's")
            ? { kind: "recategorize", reference: "the first one", category: "School" }
            : {
                kind: "capture",
                items: [{ type: "task", title: "Chem lab", dueDate: "2026-10-16" }],
              },
        );
        const first = await say(assistant, "chem lab due friday");
        const second = await say(assistant, "that's a school thing", first.state);
        expect(second.reply).toMatchObject({ outcome: "completed", changed: true });
        expect(second.reply.text).toContain('moved "Chem lab" to School');
        expect((await taskRows())[0]?.categoryId).toBe(school.id);
      });

      it("moves a note, refuses an unknown category, and leaves a correct one alone", async () => {
        const owner = await ownerPrincipal();
        const school = await services.categories.create(owner, "School");
        await services.notes.create(owner, { title: "Habit app", body: "idea", kind: "idea" });
        await services.tasks.create(owner, { title: "Chem lab", categoryId: school.id });

        const move = build(() => ({
          kind: "recategorize",
          reference: "habit app",
          category: "School",
        }));
        expect((await say(move.assistant, "put the habit app under school")).reply.changed).toBe(
          true,
        );
        expect((await noteRows())[0]?.categoryId).toBe(school.id);

        const unknown = build(() => ({
          kind: "recategorize",
          reference: "chem lab",
          category: "Fitness",
        }));
        const refused = await say(unknown.assistant, "move chem lab to fitness");
        expect(refused.reply).toMatchObject({ outcome: "clarification", changed: false });
        expect(refused.reply.text).toContain("Inbox, School");

        const same = build(() => ({
          kind: "recategorize",
          reference: "chem lab",
          category: "school",
        }));
        const already = await say(same.assistant, "chem lab is school");
        expect(already.reply).toMatchObject({ outcome: "answered", changed: false });
      });

      it("asks which one when the reference is ambiguous and reports an unknown one", async () => {
        await seed();
        await services.categories.create(await ownerPrincipal(), "School");
        const ambiguous = build(() => ({
          kind: "recategorize",
          reference: "biology",
          category: "School",
        }));
        const asked = await say(ambiguous.assistant, "biology is school");
        expect(asked.reply.outcome).toBe("clarification");
        expect(asked.reply.text).toContain("Biology quiz prep");

        const none = build(() => ({
          kind: "recategorize",
          reference: "zebra",
          category: "School",
        }));
        const missing = await say(none.assistant, "zebra is school");
        expect(missing.reply).toMatchObject({ outcome: "not_found", changed: false });
      });
    });

    it("refuses to capture or recategorize for a shared audience", async () => {
      const { assistant, provider } = build(() => ({
        kind: "capture",
        items: [{ type: "task", title: "x" }],
      }));
      const shared = await principalFor(ownerId, "shared");
      const { reply } = await say(assistant, MIXED, emptyConversation(), shared);
      expect(reply.outcome).toBe("denied");
      expect(provider.calls).toHaveLength(0);
      expect(await taskRows()).toHaveLength(0);
    });
  });

  describe("undoing the last change", () => {
    const script = (request: InterpretRequest): Intent => {
      if (request.message === "undo") return { kind: "undo" };
      if (request.message.startsWith("move")) {
        return { kind: "recategorize", reference: "chemistry", category: "School" };
      }
      if (request.message === "hello") return { kind: "respond", text: "Hi there!" };
      return { kind: "complete_task", reference: "chemistry lab" };
    };

    it("reopens a task that was just completed", async () => {
      await seed();
      const { assistant } = build(script);
      const done = await say(assistant, "finished the chem lab");
      expect(await statusOf("Chemistry lab report")).toBe("completed");
      expect(done.state.lastChange).toMatchObject({
        kind: "completed",
        title: "Chemistry lab report",
      });

      const undone = await say(assistant, "undo", done.state);
      expect(undone.reply).toMatchObject({ outcome: "completed", changed: true });
      expect(undone.reply.text).toContain('reopened "Chemistry lab report"');
      expect(await statusOf("Chemistry lab report")).toBe("open");
      expect(undone.state.lastChange).toBeNull();

      const again = await say(assistant, "undo", undone.state);
      expect(again.reply).toMatchObject({ outcome: "answered", changed: false });
      expect(again.reply.text).toContain("nothing recent");
    });

    it("moves a task back to the category it came from", async () => {
      await seed();
      const owner = await issueOwnerPrincipal(handle.db, ownerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
      const school = await services.categories.create(owner, "School");
      const { assistant } = build(script);
      const moved = await say(assistant, "move chemistry to school");
      expect((await taskRows()).find((t) => t.title === "Chemistry lab report")?.categoryId).toBe(
        school.id,
      );
      expect(moved.state.lastChange).toMatchObject({ kind: "moved", fromCategory: "Inbox" });

      const undone = await say(assistant, "undo", moved.state);
      expect(undone.reply.text).toContain("back to Inbox");
      expect(
        (await taskRows()).find((t) => t.title === "Chemistry lab report")?.categoryId,
      ).not.toBe(school.id);
    });

    it("forgets the change once anything else is said, so an old action is never reversed by surprise", async () => {
      await seed();
      const { assistant } = build(script);
      const done = await say(assistant, "finished the chem lab");
      const chatted = await say(assistant, "hello", done.state);
      expect(chatted.state.lastChange).toBeNull();
      const undone = await say(assistant, "undo", chatted.state);
      expect(undone.reply.changed).toBe(false);
      expect(await statusOf("Chemistry lab report")).toBe("completed");
    });

    it("refuses safely when the remembered task is gone or the state was tampered with", async () => {
      const { assistant } = build(script);
      for (const taskId of ["not-a-uuid", "00000000-0000-4000-8000-000000000000"]) {
        const state = {
          ...emptyConversation(),
          lastChange: { kind: "completed" as const, taskId, title: "Ghost" },
        };
        const { reply } = await say(assistant, "undo", state);
        expect(reply).toMatchObject({ outcome: "failed", changed: false });
        expect(reply.text).toContain("Nothing was changed");
      }
    });
  });

  describe("replying to reminders and routines", () => {
    const ownerPrincipal = () =>
      issueOwnerPrincipal(handle.db, ownerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });

    it("never completes an unrelated to-do from a stale task list after an event reminder", async () => {
      const owner = await ownerPrincipal();
      const todo = await services.tasks.create(owner, { title: "Get drone fixed" });
      const event = await services.events.create(owner, {
        title: "gym time",
        startsAt: "2026-10-14T15:45:00Z",
        endsAt: "2026-10-14T17:00:00Z",
        timezone: TZ,
      });
      for (const reference of ["it", "gym time", "Get drone fixed"]) {
        const { assistant, provider } = build(() => ({
          kind: "complete_task",
          reference,
          targetId: todo.id,
        }));
        const result = await say(assistant, "Already here cross it off", {
          ...emptyConversation(),
          listed: [{ id: todo.id, title: todo.title, due: null }],
          lastReminder: {
            reminderId: "00000000-0000-4000-8000-000000000001",
            kind: "event",
            subjectType: "event",
            subjectId: event.id,
            title: event.title,
          },
        });
        expect(result.reply.changed).toBe(false);
        expect((await services.tasks.get(owner, todo.id)).status).toBe("open");
        expect(provider.calls[0]?.lastReminder?.subjectId).toBe(event.id);
        expect(provider.calls[0]?.events).toEqual([
          expect.objectContaining({ id: event.id, title: "gym time" }),
        ]);
      }
    });

    it("acknowledges event attendance without canceling it, and suppresses future check-ins persistently", async () => {
      const owner = await ownerPrincipal();
      const event = await services.events.create(owner, {
        title: "gym time",
        startsAt: "2026-10-14T15:45:00Z",
        endsAt: "2026-10-14T17:00:00Z",
        timezone: TZ,
      });
      const settings = { ...parseReminderSettings([], now), briefingTime: null };
      await syncReminders({ db: handle.db, ownerId, now, timezone: TZ, settings });
      const { assistant } = build(() => ({ kind: "acknowledge_event", reference: "gym time" }));
      const result = await say(assistant, "Got done with gym time");
      expect(result.reply.changed).toBe(true);
      expect(result.reply.text).toContain("haven't canceled");
      expect((await services.events.get(owner, event.id)).status).toBe("scheduled");
      expect(
        (await services.reminders.recent(owner)).filter((item) => item.status === "scheduled"),
      ).toEqual([]);
      expect(
        (
          await syncReminders({
            db: handle.db,
            ownerId,
            now,
            timezone: TZ,
            settings: { ...settings, eventLeadMinutes: 10 },
          })
        ).created,
      ).toBe(0);
      expect((await say(assistant, "Finished gym time")).reply.changed).toBe(false);
      const delivery = { send: vi.fn().mockResolvedValue({ ok: true }) };
      await runReminderCycle({
        db: handle.db,
        ownerId,
        now: new Date("2026-10-14T16:15:00Z"),
        timezone: TZ,
        settings,
        delivery,
      });
      expect(delivery.send).not.toHaveBeenCalled();
      await expect(
        services.events.acknowledge(await principalFor(strangerId), event.id),
      ).rejects.toThrow(/not found/);
      await expect(
        services.events.acknowledge(await principalFor(ownerId, "shared"), event.id),
      ).rejects.toBeInstanceOf(AccessDeniedError);
    });

    it("creates simple to-dos without timing questions and filters them separately from tasks", async () => {
      const owner = await ownerPrincipal();
      await services.tasks.create(owner, {
        title: "Chemistry assignment",
        taskType: "task",
        estimatedMinutes: 45,
      });
      const create = build(() => ({
        kind: "create_task",
        title: "Repair drone",
        taskType: "todo",
      }));
      const saved = await say(create.assistant, "Add Repair drone as a to-do");
      expect(saved.reply).toMatchObject({ outcome: "created", changed: true });
      expect(saved.reply.text).toBe('Got it, I added "Repair drone" as a to-do.');
      expect(
        (await services.tasks.list(owner)).find((task) => task.taskType === "todo"),
      ).toMatchObject({
        title: "Repair drone",
        taskType: "todo",
        dueAt: null,
        estimatedMinutes: null,
      });

      const list = build(() => ({ kind: "list_tasks", status: "open", taskType: "todo" }));
      const listed = await say(list.assistant, "Show my to-dos");
      expect(listed.reply.text).toContain("Open to-dos (1)");
      expect(listed.reply.text).toContain("Repair drone (to-do)");
      expect(listed.reply.text).not.toContain("Chemistry assignment");
      expect(listed.state.listed).toHaveLength(1);
    });

    it("uses current dashboard task fields and supports to-do promotion, updates and reopening", async () => {
      const owner = await ownerPrincipal();
      const todo = await services.tasks.create(owner, {
        title: "Get drone fixed",
        taskType: "todo",
      });
      const update = build(() => ({
        kind: "update_task",
        reference: "Get drone fixed",
        dueDate: "2026-10-16",
        estimatedMinutes: 45,
        priority: "major",
      }));
      const result = await say(
        update.assistant,
        "Make Get drone fixed a major task due Friday, 45 minutes",
      );
      expect(result.reply.changed).toBe(true);
      expect(await services.tasks.get(owner, todo.id)).toMatchObject({
        taskType: "task",
        priority: "major",
        estimatedMinutes: 45,
      });
      await services.tasks.update(owner, todo.id, { title: "Repair drone" });
      const read = build(() => ({ kind: "list_tasks", status: "open", taskType: "todo" }));
      await say(read.assistant, "show my todos");
      expect(read.provider.calls[0]?.openTasks).toEqual([
        expect.objectContaining({
          title: "Repair drone",
          taskType: "task",
          priority: "major",
          estimatedMinutes: 45,
        }),
      ]);
      await services.tasks.complete(owner, todo.id);
      const reopen = build(() => ({ kind: "reopen_task", reference: "Repair drone" }));
      expect((await say(reopen.assistant, "reopen Repair drone")).reply.changed).toBe(true);
      expect((await services.tasks.get(owner, todo.id)).status).toBe("open");
    });

    it("understands 'finished it' as the task the reminder was about, and 'snooze' as that reminder", async () => {
      await seed();
      const task = (await taskRows()).find((t) => t.title === "Chemistry lab report")!;
      const { assistant } = build((request) =>
        request.message === "snooze"
          ? { kind: "snooze", minutes: 45 }
          : { kind: "complete_task", reference: "it" },
      );

      const reminderState = {
        ...emptyConversation(),
        listed: [{ id: task.id, title: task.title, due: null }],
        lastReminder: {
          reminderId: "00000000-0000-4000-8000-0000000000aa",
          kind: "task_deadline",
          subjectType: "task" as const,
          subjectId: task.id,
          title: task.title,
        },
      };
      const done = await say(assistant, "finished it", reminderState);
      expect(done.reply).toMatchObject({ outcome: "completed", changed: true });
      expect(await statusOf("Chemistry lab report")).toBe("completed");

      const unknown = await say(assistant, "snooze", reminderState);
      expect(unknown.reply).toMatchObject({ outcome: "failed", changed: false });
      expect(unknown.reply.text).toContain("Nothing was changed");

      const lost = await say(assistant, "snooze");
      expect(lost.reply.outcome).toBe("clarification");
    });

    it("snoozes a real reminder", async () => {
      const owner = await ownerPrincipal();
      await services.reminders.create(owner, {
        message: "Check in",
        at: new Date(now.getTime() + 10 * 60_000),
      });
      const [reminder] = await services.reminders.recent(owner);
      const { assistant } = build(() => ({ kind: "snooze", minutes: 45 }));
      const state = {
        ...emptyConversation(),
        lastReminder: {
          reminderId: reminder!.id,
          kind: "check_in",
          subjectType: null,
          subjectId: null,
          title: "Check in",
        },
      };
      const { reply, state: after } = await say(assistant, "snooze", state);
      expect(reply).toMatchObject({ outcome: "completed", changed: true });
      expect(reply.text).toContain("in 45 minutes");
      expect(after.lastReminder).toBeNull();
      expect((await services.reminders.recent(owner))[0]?.dueAt.getTime()).toBe(
        now.getTime() + 45 * 60_000,
      );
    });

    it("cancels the event a reminder was about when the owner says they are not going", async () => {
      const owner = await ownerPrincipal();
      const event = await services.events.create(owner, {
        title: "Study group",
        startsAt: "2026-10-14T20:00:00.000Z",
        endsAt: "2026-10-14T21:00:00.000Z",
        timezone: TZ,
      });
      const { assistant } = build(() => ({ kind: "skip_event" }));
      const state = {
        ...emptyConversation(),
        lastReminder: {
          reminderId: "00000000-0000-4000-8000-0000000000bb",
          kind: "event",
          subjectType: "event" as const,
          subjectId: event.id,
          title: "Study group",
        },
      };
      const { reply } = await say(assistant, "not going", state);
      expect(reply).toMatchObject({ outcome: "completed", changed: true });
      expect((await services.events.get(owner, event.id)).status).toBe("canceled");

      const nothing = await say(assistant, "not going");
      expect(nothing.reply).toMatchObject({ outcome: "clarification", changed: false });
    });

    it("pauses reminders for a while or until resumed, and resumes them", async () => {
      const owner = await ownerPrincipal();
      const timed = build(() => ({ kind: "pause_reminders", minutes: 120 }));
      const paused = await say(timed.assistant, "pause reminders for two hours");
      expect(paused.reply.text).toContain("120 minutes");
      expect((await services.preferences.get(owner, "reminders.paused_until"))?.value).toBe(
        new Date(now.getTime() + 120 * 60_000).toISOString(),
      );

      const open = build(() => ({ kind: "pause_reminders" }));
      await say(open.assistant, "leave me alone");
      expect((await services.preferences.get(owner, "reminders.paused"))?.value).toBe(true);

      const resume = build(() => ({ kind: "resume_reminders" }));
      const back = await say(resume.assistant, "bring reminders back");
      expect(back.reply.text).toContain("not replayed");
      expect((await services.preferences.get(owner, "reminders.paused"))?.value).toBe(false);
    });

    it("schedules the agreed follow-up when the owner starts an activity", async () => {
      const owner = await ownerPrincipal();
      const { assistant } = build(() => ({
        kind: "start_activity",
        activity: "gaming",
        minutes: 60,
      }));
      const { reply } = await say(assistant, "I'm gaming for an hour");
      expect(reply).toMatchObject({ outcome: "created", changed: true });
      expect(reply.text).toContain("in 60 minutes");
      const [reminder] = await services.reminders.recent(owner);
      expect(reminder?.message).toContain("Still going, or ready to wrap up?");
      expect(reminder?.dueAt.getTime()).toBe(now.getTime() + 60 * 60_000);
    });

    it("schedules a one-time errand alert 30 minutes before its target time", async () => {
      const owner = await ownerPrincipal();
      const { assistant } = build(() => ({
        kind: "create_reminder",
        title: "Go grocery shopping",
        date: "2026-10-14",
        time: "14:00",
      }));
      const { reply } = await say(assistant, "remind me at 2pm to go grocery shopping");
      expect(reply).toMatchObject({ outcome: "created", changed: true });
      expect(reply.text).toContain("1:30 PM");
      expect(reply.text).toContain("2:00 PM");
      const [reminder] = await services.reminders.recent(owner);
      expect(reminder).toMatchObject({
        kind: "custom",
        message: 'Time to "Go grocery shopping" (scheduled for 2:00 PM).',
        dueAt: new Date("2026-10-14T18:30:00.000Z"),
      });
    });

    it("clears a finished task's remaining work blocks but keeps the task and its deadline", async () => {
      const owner = await seed();
      const task = (await taskRows()).find((t) => t.title === "Chemistry lab report")!;
      const block = await services.workBlocks.create(
        owner,
        {
          taskId: task.id,
          startsAt: "2026-10-15T20:00:00.000Z",
          endsAt: "2026-10-15T21:00:00.000Z",
        },
        { intent: "explicit" },
      );
      const { assistant } = build(() => ({ kind: "complete_task", reference: "chemistry lab" }));
      const { reply } = await say(assistant, "finished the chem lab");
      expect(reply.text).toContain("cleared 1 planned work block");
      expect((await services.workBlocks.get(owner, block.id)).status).toBe("removed");
      const after = (await taskRows()).find((t) => t.id === task.id)!;
      expect(after.status).toBe("completed");
      expect(after.dueAt).not.toBeNull();
    });

    it("suggests using the time only when the task was finished well before its deadline", async () => {
      await services.tasks.create(await ownerPrincipal(), {
        title: "Due soon",
        dueAt: new Date(now.getTime() + 3 * 3_600_000).toISOString(),
      });
      const { assistant } = build(() => ({ kind: "complete_task", reference: "due soon" }));
      const { reply } = await say(assistant, "done with due soon");
      expect(reply.text).not.toContain("well ahead");
    });
  });

  describe("schedule, planning, and settings", () => {
    const ownerPrincipal = () =>
      issueOwnerPrincipal(handle.db, ownerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
    const showWeek: Intent = { kind: "show_schedule", from: "2026-10-14", through: "2026-10-18" };

    it("gives a grounded overview with free time and proposals, and schedules them only after a yes", async () => {
      const owner = await seed();
      await services.events.create(owner, {
        title: "Chem lecture",
        startsAt: "2026-10-15T20:30:00.000Z",
        endsAt: "2026-10-15T22:00:00.000Z",
        timezone: TZ,
      });
      const { assistant } = build((request) =>
        request.message === "yes" ? { kind: "confirm" } : showWeek,
      );
      const shown = await say(assistant, "what's my week look like, what can I crunch?");
      expect(shown.reply).toMatchObject({ outcome: "answered", changed: false });
      expect(shown.reply.text).toContain("Here's Wed, Oct 14 to Sun, Oct 18");
      expect(shown.reply.text).toContain("Chem lecture (3:30 PM to 5:00 PM)");
      expect(shown.reply.text).toContain("Chemistry lab report due");
      expect(shown.reply.text).toContain("Time you could use");
      expect(shown.reply.text).toContain("Want me to put those on your calendar?");
      expect(await handle.db.select().from(workBlocks)).toHaveLength(0);

      const plan = shown.state.pendingPlan!;
      expect(plan.items.length).toBeGreaterThan(0);
      const done = await say(assistant, "yes", shown.state);
      expect(done.reply).toMatchObject({ outcome: "created", changed: true });

      const blocks = await handle.db.select().from(workBlocks);
      expect(blocks).toHaveLength(plan.items.length);
      // Nothing overlaps, and everything is inside the default weekday hours (3 to 9 PM Chicago).
      const sorted = blocks.toSorted((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
      sorted.slice(1).forEach((block, i) => {
        expect(block.startsAt.getTime()).toBeGreaterThanOrEqual(sorted[i]!.endsAt.getTime());
      });
      for (const block of blocks) {
        const hour = Number(
          new Intl.DateTimeFormat("en-US", {
            timeZone: TZ,
            hour: "numeric",
            hourCycle: "h23",
          }).format(block.startsAt),
        );
        expect(hour).toBeGreaterThanOrEqual(15);
        expect(hour).toBeLessThan(21);
      }
    });

    it("drops a proposal whose time was taken in the meantime, and keeps a 'no' from scheduling anything", async () => {
      const owner = await seed();
      const { assistant } = build((request) =>
        request.message === "yes"
          ? { kind: "confirm" }
          : request.message === "no"
            ? { kind: "decline" }
            : showWeek,
      );
      const shown = await say(assistant, "show my week");
      const first = shown.state.pendingPlan!.items[0]!;
      await services.events.create(owner, {
        title: "Surprise meeting",
        startsAt: first.startsAt,
        endsAt: first.endsAt,
        timezone: TZ,
      });
      const done = await say(assistant, "yes", shown.state);
      expect(done.reply.text).toContain(`I skipped "${first.title}"`);
      expect((await handle.db.select().from(workBlocks)).length).toBe(
        shown.state.pendingPlan!.items.length - 1,
      );

      const again = await say(assistant, "show my week");
      const declined = await say(assistant, "no", again.state);
      expect(declined.reply).toMatchObject({ outcome: "declined", changed: false });
    });

    it("schedules a block at a requested time when it is free, and refuses with a reason and an alternative when it is not", async () => {
      const owner = await seed();
      await services.events.create(owner, {
        title: "Study group",
        startsAt: "2026-10-15T21:30:00.000Z",
        endsAt: "2026-10-15T23:00:00.000Z",
        timezone: TZ,
      });
      const ok = build(() => ({
        kind: "plan_work",
        reference: "chemistry",
        date: "2026-10-14",
        time: "16:00",
        minutes: 60,
      }));
      const planned = await say(ok.assistant, "block 4pm today for chem");
      expect(planned.reply).toMatchObject({ outcome: "created", changed: true });
      expect((await handle.db.select().from(workBlocks))[0]?.startsAt.toISOString()).toBe(
        "2026-10-14T21:00:00.000Z",
      );

      const clash = build(() => ({
        kind: "plan_work",
        reference: "history essay",
        date: "2026-10-15",
        time: "16:45",
        minutes: 60,
      }));
      const refused = await say(clash.assistant, "put the essay at 4:45 thursday");
      expect(refused.reply).toMatchObject({ outcome: "failed", changed: false });
      expect(refused.reply.text).toContain("overlaps Study group");
      expect(refused.reply.text).toContain("Want that instead?");

      const early = build(() => ({
        kind: "plan_work",
        reference: "history essay",
        date: "2026-10-15",
        time: "03:00",
        minutes: 60,
      }));
      expect((await say(early.assistant, "3am thursday")).reply.text).toContain(
        "outside the hours you like to work",
      );
      expect(await handle.db.select().from(workBlocks)).toHaveLength(1);
    });

    it("never treats an empty calendar as free time outside the owner's own hours", async () => {
      await seed();
      const owner = await ownerPrincipal();
      await services.preferences.set(owner, {
        key: "planning.preferred_hours",
        value: { thu: [{ start: "19:00", end: "20:00" }] },
        status: "confirmed",
      });
      const { assistant } = build(() => ({
        kind: "show_schedule",
        from: "2026-10-13",
        through: "2026-10-17",
      }));
      const { reply } = await say(assistant, "what's free this week?");
      expect(reply.text).toContain("Thu, Oct 15 7:00 PM to 8:00 PM");
      const free =
        reply.text.split("\n").find((line) => line.startsWith("Time you could use")) ?? "";
      expect(free).not.toMatch(/Mon|Tue|Wed|Fri|Sat|Sun/);
    });

    it("changes a setting, can remove one, and asks first before raising the daily reminder limit", async () => {
      const owner = await ownerPrincipal();
      const set = build(() => ({
        kind: "set_preference",
        key: "reminders.quiet_hours",
        value: { start: "22:00", end: "07:00" },
        summary: "quiet hours are 10 PM to 7 AM",
      }));
      const done = await say(set.assistant, "no reminders from 10pm to 7am");
      expect(done.reply).toMatchObject({ outcome: "created", changed: true });
      expect((await services.preferences.get(owner, "reminders.quiet_hours"))?.value).toEqual({
        start: "22:00",
        end: "07:00",
      });

      const clear = build(() => ({
        kind: "set_preference",
        key: "reminders.quiet_hours",
        value: false,
        summary: "quiet hours are off",
      }));
      await say(clear.assistant, "turn quiet hours off");
      expect((await services.preferences.get(owner, "reminders.quiet_hours"))?.value).toBe(false);

      const raise = build((request) =>
        request.message === "yes"
          ? { kind: "confirm" }
          : request.message === "no"
            ? { kind: "decline" }
            : {
                kind: "set_preference",
                key: "reminders.daily_limit",
                value: 30,
                summary: "up to 30 reminders a day",
              },
      );
      const asked = await say(raise.assistant, "let me get 30 reminders a day");
      expect(asked.reply).toMatchObject({ outcome: "confirmation_needed", changed: false });
      expect(await services.preferences.get(owner, "reminders.daily_limit")).toBeNull();

      const refused = await say(raise.assistant, "no", asked.state);
      expect(refused.reply.changed).toBe(false);
      expect(await services.preferences.get(owner, "reminders.daily_limit")).toBeNull();

      const again = await say(raise.assistant, "let me get 30 reminders a day");
      await say(raise.assistant, "yes", again.state);
      expect((await services.preferences.get(owner, "reminders.daily_limit"))?.value).toBe(30);

      const lower = build(() => ({
        kind: "set_preference",
        key: "reminders.daily_limit",
        value: 5,
        summary: "up to 5 reminders a day",
      }));
      expect((await say(lower.assistant, "only 5 a day")).reply.outcome).toBe("created");
    });

    it("confirms extra split reminders and can disable them without touching original alerts", async () => {
      const owner = await ownerPrincipal();
      const set = build((request) =>
        request.message === "yes"
          ? { kind: "confirm" }
          : {
              kind: "set_preference",
              key: "reminders.split",
              value: { enabled: true, count: 5 },
              summary: "five split reminders per due task",
            },
      );
      const asked = await say(set.assistant, "Add five split reminders for my assignments");
      expect(asked.reply.outcome).toBe("confirmation_needed");
      expect(await services.preferences.get(owner, "reminders.split")).toBeNull();
      expect((await say(set.assistant, "yes", asked.state)).reply.changed).toBe(true);
      expect((await services.preferences.get(owner, "reminders.split"))?.value).toEqual({
        enabled: true,
        count: 5,
      });
      expect(await services.preferences.get(owner, "reminders.deadline_lead_hours")).toBeNull();
      expect(await services.preferences.get(owner, "reminders.daily_limit")).toBeNull();
      const disable = build(() => ({
        kind: "set_preference",
        key: "reminders.split",
        value: { enabled: false, count: 5 },
        summary: "split reminders are off",
      }));
      expect(
        (await say(disable.assistant, "Turn the extra split reminders off")).reply.changed,
      ).toBe(true);
      expect(parseReminderSettings(await services.preferences.list(owner)).splitReminders).toEqual({
        enabled: false,
        count: 5,
      });
    });

    it("refuses schedules and settings in a shared channel", async () => {
      const { assistant, provider } = build(() => showWeek);
      const shared = await principalFor(ownerId, "shared");
      const { reply } = await say(assistant, "show my week", emptyConversation(), shared);
      expect(reply.outcome).toBe("denied");
      expect(provider.calls).toHaveLength(0);
    });
  });

  describe("learning from what the owner reports", () => {
    const ownerPrincipal = () =>
      issueOwnerPrincipal(handle.db, ownerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
    const script = (request: InterpretRequest): Intent => {
      if (request.message === "yes") return { kind: "confirm" };
      if (request.message === "no") return { kind: "decline" };
      if (request.message === "turn on learning") {
        return {
          kind: "set_preference",
          key: "tracking.enabled",
          value: true,
          summary: "learning is on",
        };
      }
      if (request.message === "pause learning") {
        return {
          kind: "set_preference",
          key: "tracking.paused",
          value: true,
          summary: "learning is paused",
        };
      }
      if (request.message.startsWith("it took")) {
        return {
          kind: "report_duration",
          reference: "chem lab",
          minutes: Number(request.message.match(/\d+/)![0]),
        };
      }
      if (request.message.startsWith("what have you learned")) return { kind: "show_insights" };
      if (request.message.startsWith("my chem labs"))
        return { kind: "correct_estimate", subject: "chemistry lab report", minutes: 90 };
      if (request.message.startsWith("forget what")) return { kind: "forget_insights" };
      return { kind: "create_task", title: "Chemistry lab report" };
    };
    const enable = async (assistant: Assistant) => {
      const asked = await say(assistant, "turn on learning");
      await say(assistant, "yes", asked.state);
    };

    it("is off until the owner says yes, and records nothing before that", async () => {
      await seed();
      const { assistant } = build(script);
      const ask = await say(assistant, "it took 45 minutes");
      expect(ask.reply).toMatchObject({ outcome: "confirmation_needed", changed: false });
      expect(await services.insights.list(await ownerPrincipal())).toHaveLength(0);

      const refused = await say(assistant, "no", ask.state);
      expect(refused.reply.changed).toBe(false);
      expect(await services.preferences.get(await ownerPrincipal(), "tracking.enabled")).toBeNull();

      const again = await say(assistant, "turn on learning");
      expect(again.reply.text).toContain("never record anything from silence");
      await say(assistant, "yes", again.state);
      expect(
        (await services.preferences.get(await ownerPrincipal(), "tracking.enabled"))?.value,
      ).toBe(true);
    });

    it("improves the estimate for similar work after repeated reports", async () => {
      await seed();
      const { assistant } = build(script);
      await enable(assistant);
      for (const minutes of [40, 50, 60]) await say(assistant, `it took ${minutes} minutes`);
      const later = await say(assistant, "add chem lab");
      expect(later.reply.text).toContain("about 50 min");
      expect(later.reply.text).toContain("how long similar ones took you");
    });

    it("draws no conclusion from a single report", async () => {
      await seed();
      const { assistant } = build(script);
      await enable(assistant);
      await say(assistant, "it took 40 minutes");
      const first = await say(assistant, "add chem lab");
      expect(first.reply.text).not.toContain("guessed the time");
    });

    it("lets a correction override the inferred time and shows what it has learned", async () => {
      await seed();
      const { assistant } = build(script);
      await enable(assistant);
      for (const minutes of [40, 45, 50]) await say(assistant, `it took ${minutes} minutes`);
      await say(assistant, "my chem labs take about 90 minutes");
      const task = await say(assistant, "add chem lab");
      expect(task.reply.text).toContain("about 90 min");
      expect(task.reply.text).toContain("what you told me");
      const shown = await say(assistant, "what have you learned about me?");
      expect(shown.reply.text).toContain("from 3 times you told me");
      expect(shown.reply.text).toContain("overrides what I guessed");
    });

    it("records nothing while paused, and forgets everything only after confirmation", async () => {
      await seed();
      const { assistant } = build(script);
      await enable(assistant);
      await say(assistant, "it took 30 minutes");
      await say(assistant, "pause learning");
      const paused = await say(assistant, "it took 99 minutes");
      expect(paused.reply.text).toContain("paused");
      expect(await services.insights.list(await ownerPrincipal())).toHaveLength(1);

      const asked = await say(assistant, "forget what you learned");
      expect(asked.reply).toMatchObject({ outcome: "confirmation_needed", changed: false });
      expect(await services.insights.list(await ownerPrincipal())).toHaveLength(1);
      const done = await say(assistant, "yes", asked.state);
      expect(done.reply.text).toContain("forgotten what I learned");
      expect(await services.insights.list(await ownerPrincipal())).toHaveLength(0);
    });

    it("never learns in a shared channel", async () => {
      const { assistant } = build(script);
      const shared = await principalFor(ownerId, "shared");
      const { reply } = await say(assistant, "it took 45 minutes", emptyConversation(), shared);
      expect(reply.outcome).toBe("denied");
      expect(await services.insights.list(await ownerPrincipal())).toHaveLength(0);
    });
  });

  describe("personal memory", () => {
    const ownerPrincipal = () =>
      issueOwnerPrincipal(handle.db, ownerId, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
    const script = (request: InterpretRequest): Intent => {
      if (request.message === "yes") return { kind: "confirm" };
      if (request.message === "no") return { kind: "decline" };
      if (request.message.startsWith("what do you remember")) return { kind: "list_memory" };
      if (request.message.startsWith("forget")) return { kind: "forget", reference: "gaming" };
      if (request.message.startsWith("remember")) {
        return { kind: "remember", text: "Homework comes before gaming.", explicit: true };
      }
      return { kind: "remember", text: "Works out after finishing homework.", explicit: false };
    };

    it("remembers what it is asked to, keeps it across sessions, and uses it when answering", async () => {
      const { assistant, provider } = build(script);
      const saved = await say(assistant, "remember that homework comes before gaming");
      expect(saved.reply).toMatchObject({ outcome: "created", changed: true });
      const owner = await ownerPrincipal();
      const stored = (await services.preferences.list(owner)).find((p) =>
        p.key.startsWith("memory."),
      );
      expect(stored).toMatchObject({ status: "confirmed", source: "discord" });
      expect(stored?.value).toEqual({ text: "Homework comes before gaming." });

      await say(assistant, "remember that homework comes before gaming");
      expect(
        (await services.preferences.list(owner)).filter((p) => p.key.startsWith("memory.")),
      ).toHaveLength(1);

      // A brand-new conversation (a new session) still has it.
      await say(assistant, "what should I do tonight?", emptyConversation());
      expect(provider.calls.at(-1)?.memories).toEqual(["Homework comes before gaming."]);
    });

    it("asks before keeping something it inferred, and does not use it until confirmed", async () => {
      const { assistant, provider } = build(script);
      const asked = await say(assistant, "I always work out after homework");
      expect(asked.reply).toMatchObject({ outcome: "confirmation_needed", changed: false });
      expect(asked.state.pendingMemory?.text).toBe("Works out after finishing homework.");
      await say(assistant, "what should I do tonight?");
      expect(provider.calls.at(-1)?.memories).toEqual([]);

      const yes = await say(assistant, "yes", asked.state);
      expect(yes.reply).toMatchObject({ outcome: "created", changed: true });
      await say(assistant, "hello again");
      expect(provider.calls.at(-1)?.memories).toEqual(["Works out after finishing homework."]);

      const other = await say(assistant, "I always work out after homework");
      const no = await say(assistant, "no", other.state);
      expect(no.reply.text).toContain("won't use it");
    });

    it("shows what it remembers with where it came from, and forgets one item after confirmation", async () => {
      const { assistant, provider } = build(script);
      await say(assistant, "remember that homework comes before gaming");
      await say(assistant, "I always work out after homework");
      const shown = await say(assistant, "what do you remember about me?");
      expect(shown.reply.text).toContain("Homework comes before gaming. (saved from discord");
      expect(shown.reply.text).toContain("not confirmed yet, so unused");

      const asked = await say(assistant, "forget the gaming thing");
      expect(asked.reply).toMatchObject({ outcome: "confirmation_needed", changed: false });
      expect(await services.preferences.list(await ownerPrincipal())).toHaveLength(2);
      const done = await say(assistant, "yes", asked.state);
      expect(done.reply.outcome).toBe("deleted");

      await say(assistant, "what should I do tonight?");
      expect(provider.calls.at(-1)?.memories).toEqual([]);
      expect(
        (await services.preferences.list(await ownerPrincipal())).map(
          (p) => (p.value as { text: string }).text,
        ),
      ).not.toContain("Homework comes before gaming.");
    });

    it("honors 'don't remember this' and never discloses memory to a shared audience", async () => {
      const { assistant } = build(script);
      const refused = await say(assistant, "remember this but don't save it, just chatting");
      expect(refused.reply.text).toContain("won't remember");
      expect(await services.preferences.list(await ownerPrincipal())).toHaveLength(0);

      await say(assistant, "remember that homework comes before gaming");
      const shared = await principalFor(ownerId, "shared");
      const leak = await say(
        assistant,
        "what do you remember about me?",
        emptyConversation(),
        shared,
      );
      expect(leak.reply.outcome).toBe("denied");
      expect(leak.reply.text).not.toContain("Homework");
    });

    it("finds a year-old completed assignment without making it active again", async () => {
      const owner = await ownerPrincipal();
      const old = await services.tasks.create(owner, {
        title: "Biology lab 3",
        dueAt: "2025-10-10T22:00:00.000Z",
      });
      await services.tasks.complete(owner, old.id);
      await handle.db
        .update(tasks)
        .set({ completedAt: new Date("2025-10-09T12:00:00.000Z") })
        .where(eq(tasks.id, old.id));
      const { assistant } = build(() => ({
        kind: "list_tasks",
        status: "completed",
        search: "biology",
      }));
      const { reply } = await say(assistant, "what did I do for biology last year?");
      expect(reply.text).toContain("Biology lab 3");
      const [row] = await taskRows();
      expect(row).toMatchObject({ status: "completed", archivedAt: null });
      const open = build(() => ({ kind: "list_tasks", status: "open" }));
      expect((await say(open.assistant, "what's open?")).reply.text).not.toContain("Biology lab 3");
    });
  });

  describe("setting up the Discord workspace", () => {
    const intent: Intent = { kind: "setup_workspace", server: "My Server" };

    function withWorkspace(result: WorkspaceSetupResult) {
      const calls: Array<{ principal: Principal; server: string | undefined }> = [];
      const assistant = createAssistant({
        services,
        provider: createScriptedProvider(() => intent),
        budget: budget(),
        timezone: TZ,
        workspace: {
          async setup(principal, server) {
            calls.push({ principal, server });
            return result;
          },
        },
        clock: () => now,
      });
      return { assistant, calls };
    }

    it("passes the server name on and reports what was created", async () => {
      const { assistant, calls } = withWorkspace({
        status: "ready",
        server: "My Server",
        created: ["assistant", "today"],
        categoryCreated: true,
      });
      const { reply } = await say(assistant, "set up my workspace in My Server");
      expect(calls).toHaveLength(1);
      expect(calls[0]?.server).toBe("My Server");
      expect(calls[0]?.principal.audience).toBe("private");
      expect(reply).toMatchObject({ outcome: "created", changed: true });
      expect(reply.text).toContain("#assistant, #today");
      expect(reply.text).toContain("My Server");
    });

    it("says so, and changes nothing, when everything already exists", async () => {
      const { assistant } = withWorkspace({
        status: "ready",
        server: "My Server",
        created: [],
        categoryCreated: false,
      });
      const { reply } = await say(assistant, "set up my workspace");
      expect(reply).toMatchObject({ outcome: "answered", changed: false });
      expect(reply.text).toContain("already set up");
    });

    it("tells a repair apart from a first-time setup", async () => {
      const { assistant } = withWorkspace({
        status: "ready",
        server: "My Server",
        created: ["today"],
        categoryCreated: false,
      });
      const { reply } = await say(assistant, "my channels got deleted, put them back");
      expect(reply).toMatchObject({ outcome: "created", changed: true });
      expect(reply.text).toContain("missing channels");
      expect(reply.text).not.toContain("I created a private");
    });

    it("asks which server when there are several, and when there are none says to invite Epi", async () => {
      const many = withWorkspace({ status: "choose", servers: ["Alpha", "Beta"] });
      const asked = await say(many.assistant, "set up my workspace");
      expect(asked.reply).toMatchObject({ outcome: "clarification", changed: false });
      expect(asked.reply.text).toContain("Alpha, Beta");

      const none = withWorkspace({ status: "no_server" });
      const told = await say(none.assistant, "set up my workspace");
      expect(told.reply).toMatchObject({ outcome: "not_found", changed: false });
      expect(told.reply.text).toContain("Invite me");
    });

    it("reports a permission problem honestly, including anything created before it stopped", async () => {
      const { assistant } = withWorkspace({
        status: "blocked",
        server: "My Server",
        created: [],
        categoryCreated: true,
        reason: "missing_permissions",
      });
      const { reply } = await say(assistant, "set up my workspace");
      expect(reply).toMatchObject({ outcome: "failed", changed: true });
      expect(reply.text).toContain("couldn't finish");
      expect(reply.text).toContain("Manage Channels");
      expect(reply.text).toContain("not Administrator");
      expect(reply.text).toContain('the "epiphany" category');

      const nothing = withWorkspace({
        status: "blocked",
        server: "My Server",
        created: [],
        categoryCreated: false,
        reason: "failed",
      });
      expect((await say(nothing.assistant, "set up my workspace")).reply.changed).toBe(false);
    });

    it("declines outside Discord, where no workspace capability exists", async () => {
      const { assistant } = build(() => intent);
      const { reply } = await say(assistant, "set up my workspace");
      expect(reply).toMatchObject({ outcome: "unavailable", changed: false });
      expect(reply.text).toContain("from Discord");
    });

    it("never reaches the capability from a shared channel", async () => {
      const { assistant, calls } = withWorkspace({ status: "no_server" });
      const shared = await principalFor(ownerId, "shared");
      const { reply } = await say(assistant, "set up my workspace", emptyConversation(), shared);
      expect(reply.outcome).toBe("denied");
      expect(calls).toHaveLength(0);
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
