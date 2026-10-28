import { describe, expect, it, vi } from "vitest";
import type { Database } from "../db/client";
import { issueOwnerPrincipal, type Services } from "../services";
import { createAssistant, emptyConversation, MAX_REPLY_CHARS } from "./assistant";
import { createBudget, createMemoryUsageStore } from "./budget";
import { createOpenAiProvider } from "./openai";

async function fixture(response: unknown, savedNotes: unknown[] = []) {
  // Only the owner lookup is stubbed; principal issuance and audience checks are real.
  const db = {
    select: () => ({ from: () => ({ where: async () => [{ id: "owner-1" }] }) }),
  } as unknown as Database;
  const principal = await issueOwnerPrincipal(db, "owner-1", {
    audience: "private",
    initiator: "assistant",
    source: "discord",
  });
  const create = vi.fn();
  const update = vi.fn();
  const tasks = { list: vi.fn(async () => []), create, update };
  const notes = {
    list: vi.fn(async () => savedNotes),
    get: vi.fn(async () => savedNotes[0]),
    create,
    update,
  };
  const services = {
    tasks,
    notes,
    events: { list: vi.fn(async () => []) },
    categories: { list: vi.fn(async () => []) },
    preferences: { list: vi.fn(async () => []) },
  } as unknown as Services;
  const fetchImpl = vi.fn(async () => new Response(JSON.stringify(response)));
  const provider = createOpenAiProvider({
    apiKey: "synthetic-test-key",
    model: "test-model",
    pricing: { inputPerMillion: 2, outputPerMillion: 8 },
    fetch: fetchImpl as unknown as typeof fetch,
  });
  const budget = createBudget(
    { monthlyLimitUsd: 10, warnPercent: 80, timezone: "America/Chicago" },
    createMemoryUsageStore(),
    () => new Date("2026-10-22T15:00:00Z"),
  );
  const assistant = createAssistant({
    services,
    provider,
    budget,
    timezone: "America/Chicago",
    clock: () => new Date("2026-10-22T15:00:00Z"),
  });
  return { assistant, principal, create, update, fetchImpl, budget };
}

const response = (message: unknown, finish_reason = "stop") => ({
  choices: [{ message, finish_reason }],
  usage: { prompt_tokens: 1000, completion_tokens: 100 },
});

describe("ordinary conversation and optional action failures", () => {
  const ideaResponse = () =>
    response({
      content: "How would returns work?",
      tool_calls: [
        {
          type: "function",
          function: {
            name: "create_note",
            arguments: JSON.stringify({
              title: "Tool library",
              details: "Share tools with neighbors",
              note_kind: "idea",
            }),
          },
        },
      ],
    });

  it("answers ordinary conversation without writes or a second call", async () => {
    const text = "A neighborhood tool library could be useful. What problem would it solve first?";
    const f = await fixture(response({ content: text }));
    const { reply } = await f.assistant.handle(f.principal, "What do you think of a tool library?");
    expect(reply).toMatchObject({ text, outcome: "answered", changed: false });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["Return tracking is worth considering. Would reminders help?", "", "word ".repeat(500)])(
    "explicitly reports an unsaved update while retaining useful text: %j",
    async (text) => {
      const f = await fixture(
        response({
          content: text || null,
          tool_calls: [{ type: "function", function: { name: "develop_idea", arguments: "{}" } }],
        }),
      );
      const state = {
        ...emptyConversation(),
        pendingMemory: {
          key: "memory.borrowing",
          text: "I like borrowing tools",
          expiresAt: "2026-10-22T15:10:00Z",
        },
      };
      const { reply, state: next } = await f.assistant.handle(
        f.principal,
        "Add a return-tracking concern to the tool library idea",
        state,
      );
      expect(reply).toMatchObject({ outcome: "failed", changed: false });
      expect(reply.text).toContain("update was not saved");
      expect(reply.text).toContain("Nothing was changed");
      expect(reply.text).not.toContain("can't interpret messages right now");
      expect(reply.text.length).toBeLessThanOrEqual(MAX_REPLY_CHARS + 3);
      if (text && text.length < 100) expect(reply.text).toContain(text);
      expect(next.pendingMemory).toBeNull();
      expect(f.create).not.toHaveBeenCalled();
      expect(f.update).not.toHaveBeenCalled();
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      expect((await f.budget.check()).spentUsd).toBeCloseTo(0.0028);
    },
  );

  it.each([
    [response({ content: "private refusal", refusal: "private refusal" }), "usable reply"],
    [response({ content: "unfinished private output" }, "length"), "cut short"],
    [{ choices: [], usage: { prompt_tokens: 1000, completion_tokens: 100 } }, "validate"],
  ])(
    "reports output failures accurately, records cost, and logs no content",
    async (body, wording) => {
      const log = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const f = await fixture(body);
        const { reply } = await f.assistant.handle(
          f.principal,
          "Discuss the private tool library idea",
        );
        expect(reply).toMatchObject({ outcome: "failed", changed: false });
        expect(reply.text).toContain(wording);
        expect(reply.text).toContain("update was not saved");
        expect((await f.budget.check()).spentUsd).toBeCloseTo(0.0028);
        expect(JSON.stringify(log.mock.calls)).not.toContain("private");
        expect(JSON.stringify(log.mock.calls)).not.toContain("synthetic-test-key");
        expect(f.create).not.toHaveBeenCalled();
        expect(f.fetchImpl).toHaveBeenCalledTimes(1);
      } finally {
        log.mockRestore();
      }
    },
  );

  it("continues to deny forged owners and shared audiences before calling the provider", async () => {
    const f = await fixture(response({ content: "No records should be disclosed." }));
    await expect(
      f.assistant.handle({ ...f.principal }, "Tell me about the tool library"),
    ).rejects.toThrow();
    const db = {
      select: () => ({ from: () => ({ where: async () => [{ id: "owner-1" }] }) }),
    } as unknown as Database;
    const shared = await issueOwnerPrincipal(db, "owner-1", {
      audience: "shared",
      initiator: "assistant",
      source: "discord",
    });
    const { reply } = await f.assistant.handle(shared, "Tell me about the tool library");
    expect(reply.outcome).toBe("denied");
    expect(f.fetchImpl).not.toHaveBeenCalled();
  });

  it("dispatches valid tools through the owner-bound service before acknowledging success", async () => {
    const f = await fixture(ideaResponse());
    f.create.mockResolvedValue({
      id: "idea-1",
      title: "Tool library",
      body: "Share tools with neighbors",
      kind: "idea",
    });
    const { reply, state } = await f.assistant.handle(f.principal, "Save my tool library idea");
    expect(f.create).toHaveBeenCalledExactlyOnceWith(f.principal, {
      title: "Tool library",
      body: "Share tools with neighbors",
      kind: "idea",
      sourceRef: undefined,
    });
    expect(reply).toMatchObject({ changed: true, outcome: "created" });
    expect(reply.text).toContain("How would returns work?");
    expect(state.activeIdea).toEqual({ ownerId: f.principal.ownerId, noteId: "idea-1" });
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a valid but stale repeated create_note tool instead of acknowledging a reminder", async () => {
    const f = await fixture(ideaResponse(), [
      {
        id: "idea-1",
        title: "Tool library",
        kind: "idea",
        body: "Share tools with neighbors",
      },
    ]);
    const state = {
      ...emptyConversation(),
      activeIdea: { ownerId: f.principal.ownerId, noteId: "idea-1" },
    };
    const { reply } = await f.assistant.handle(
      f.principal,
      "also remind me to renew the domain registration",
      state,
    );
    expect(reply).toMatchObject({ outcome: "clarification", changed: false });
    expect(reply.text).toContain("may not match your latest request");
    expect(reply.text).toContain("when should I remind you?");
    expect(reply.text).not.toContain("Saved");
    expect(reply.text).not.toContain("How would returns work?");
    expect(f.create).not.toHaveBeenCalled();
    expect(f.update).not.toHaveBeenCalled();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("honors no-save instructions even when a valid write tool was proposed", async () => {
    const f = await fixture(ideaResponse());
    const { reply } = await f.assistant.handle(
      f.principal,
      "Don't save this: what do you think of a neighborhood tool library?",
    );
    expect(reply).toMatchObject({ changed: false, outcome: "answered" });
    expect(f.create).not.toHaveBeenCalled();
    expect(f.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("does not acknowledge a proposed write when the shared service refuses it", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const f = await fixture(ideaResponse());
      f.create.mockRejectedValue(new Error("private database details"));
      const { reply } = await f.assistant.handle(f.principal, "Save my tool library idea");
      expect(reply).toMatchObject({ changed: false, outcome: "failed" });
      expect(reply.text).toContain("nothing was changed");
      expect(reply.text).not.toContain("Saved");
      expect(JSON.stringify(log.mock.calls)).not.toContain("private database details");
      expect(f.fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      log.mockRestore();
    }
  });
});
