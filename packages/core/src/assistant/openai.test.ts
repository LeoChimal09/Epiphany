import { describe, expect, it, vi } from "vitest";
import { INTENT_KINDS } from "./intent";
import { createOpenAiProvider, SYSTEM_PROMPT } from "./openai";
import { ProviderOutputError, ProviderUnavailableError, type InterpretRequest } from "./provider";

const KEY = "sk-test-not-a-real-key";
const request: InterpretRequest = {
  message: "finished the chem lab",
  now: "2026-10-14T15:00:00.000Z",
  timezone: "America/Chicago",
  today: "2026-10-14",
  weekday: "Wednesday",
  openTasks: [{ id: "t1", title: "Chemistry lab report", due: "2026-10-16" }],
  recentNotes: [],
  lastListed: [],
  history: [],
  pending: null,
  memories: [],
};

const tool = (name: string, args: unknown) => ({
  type: "function",
  function: { name, arguments: JSON.stringify(args) },
});
const completion = (
  message: unknown,
  usage: unknown = { prompt_tokens: 1000, completion_tokens: 100 },
  finish_reason = "stop",
) => new Response(JSON.stringify({ choices: [{ message, finish_reason }], usage }));

const provider = (fetchImpl: () => Promise<Response>, caps = {}) =>
  createOpenAiProvider({
    apiKey: KEY,
    model: "model-under-test",
    pricing: { inputPerMillion: 2, outputPerMillion: 8 },
    fetch: fetchImpl as unknown as typeof fetch,
    ...caps,
  });

describe("OpenAI conversational adapter", () => {
  it("returns free text without an action envelope and makes exactly one call", async () => {
    const text =
      "A neighborhood tool library could help people share equipment. How would returns work?";
    const fetchImpl = vi.fn(async () => completion({ content: text }));
    const result = await provider(fetchImpl).interpret(request);
    expect(result.intent).toEqual({ kind: "respond", text });
    expect(result.invalidAction).toBeUndefined();
    expect(result.costUsd).toBeCloseTo(0.0028, 10);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body).not.toHaveProperty("response_format");
    expect(body).toMatchObject({
      tool_choice: "auto",
      parallel_tool_calls: false,
    });
    expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(String(init.body)).not.toContain(KEY);
    const names = body.tools.map((entry: { function: { name: string } }) => entry.function.name);
    expect(names.sort()).toEqual(
      INTENT_KINDS.filter((kind) => kind !== "respond" && kind !== "clarify").sort(),
    );
    const idea = body.tools.find(
      (entry: { function: { name: string } }) => entry.function.name === "develop_idea",
    ).function.parameters;
    expect(Object.keys(idea.properties).sort()).toEqual(["details", "reference", "target_id"]);
    expect(idea.required).toEqual(["details"]);
    expect(idea.additionalProperties).toBe(false);
  });

  it("combines a minimal idea tool with useful feedback in one completion", async () => {
    const fetchImpl = vi.fn(async () =>
      completion({
        content: "Clear lending periods could help. How long should people keep a tool?",
        tool_calls: [
          tool("develop_idea", { details: "Concern: Tracking returns", target_id: "idea-1" }),
        ],
      }),
    );
    const result = await provider(fetchImpl).interpret(request);
    expect(result.intent).toEqual({
      kind: "develop_idea",
      reference: "",
      targetId: "idea-1",
      points: ["Concern: Tracking returns"],
      feedback: "Clear lending periods could help. How long should people keep a tool?",
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("sends freshly loaded idea context and intake metadata, preserving read-only resumption", async () => {
    const fetchImpl = vi.fn(async () =>
      completion({
        tool_calls: [tool("resume_idea", { reference: "Tool library", target_id: "idea-1" })],
      }),
    );
    const activeIdea = {
      id: "idea-1",
      title: "Tool library",
      body: "Concern: Return tracking",
      truncated: false,
    };
    const result = await provider(fetchImpl).interpret({
      ...request,
      activeIdea,
      categories: ["School"],
      listedEntryCount: 10,
    });
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const sent = JSON.parse(JSON.parse(String(init.body)).messages[1].content);
    expect(sent).toMatchObject({ activeIdea, categories: ["School"], listedEntryCount: 10 });
    expect(result.intent).toEqual({
      kind: "resume_idea",
      reference: "Tool library",
      targetId: "idea-1",
    });
  });

  it("validates sparse capture items without requiring nullable filler fields", async () => {
    const fetchImpl = vi.fn(async () =>
      completion({
        tool_calls: [
          tool("capture", { items: [{ type: "task", title: "Return borrowed drill" }] }),
        ],
      }),
    );
    expect((await provider(fetchImpl).interpret(request)).intent).toEqual({
      kind: "capture",
      items: [{ type: "task", title: "Return borrowed drill" }],
    });
  });

  it.each([null, []])("accepts text with no optional tools (%j)", async (tool_calls) => {
    const fetchImpl = vi.fn(async () =>
      completion({ content: "Let's think about returns.", tool_calls }),
    );
    expect((await provider(fetchImpl).interpret(request)).intent).toEqual({
      kind: "respond",
      text: "Let's think about returns.",
    });
  });

  it.each([
    tool("develop_idea", {}),
    tool("develop_idea", { details: "x".repeat(501) }),
    tool("unknown_action", {}),
    tool("create_task", { title: "Return drill", due_date: "2026-02-30" }),
    tool("create_task", { title: "Return drill", ownerId: "other-owner" }),
    tool("capture", { items: [{ type: "task", title: "Return drill", ownerId: "other-owner" }] }),
    tool("set_preference", { search: "tracking.enabled", details: "not json" }),
    { type: "function", function: { name: "develop_idea", arguments: "{broken" } },
    { type: "function", function: null },
    null,
  ])("rejects invalid actions while preserving useful conversational text: %j", async (call) => {
    const text = "Return tracking is worth considering. Would reminders help?";
    const fetchImpl = vi.fn(async () => completion({ content: text, tool_calls: [call] }));
    const result = await provider(fetchImpl).interpret(request);
    expect(result).toMatchObject({
      intent: { kind: "respond", text },
      invalidAction: true,
      costUsd: 0.0028,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects an invalid-only action and multiple actions without executing any", async () => {
    for (const calls of [
      [tool("create_task", {})],
      [tool("create_task", { title: "A" }), tool("create_task", { title: "B" })],
      "not an array",
    ]) {
      const fetchImpl = vi.fn(async () => completion({ content: null, tool_calls: calls }));
      expect(await provider(fetchImpl).interpret(request)).toMatchObject({
        intent: { kind: "respond", text: "" },
        invalidAction: true,
      });
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    }
  });

  it("counts tool definitions toward the input cap and sends the output cap", async () => {
    const fetchImpl = vi.fn(async () => completion({ content: "Let's think it through." }));
    const uncapped = provider(fetchImpl);
    await uncapped.interpret(request);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const withoutTools = Math.ceil((SYSTEM_PROMPT.length + body.messages[1].content.length) / 4);
    fetchImpl.mockClear();
    await expect(
      provider(fetchImpl, { maxInputTokens: withoutTools }).interpret(request),
    ).rejects.toMatchObject({ tooLarge: true, retryable: false });
    expect(fetchImpl).not.toHaveBeenCalled();
    await provider(fetchImpl, {
      maxInputTokens: 20_000,
      maxOutputTokens: 321,
    }).interpret(request);
    const [, cappedInit] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(cappedInit.body)).max_completion_tokens).toBe(321);
  });

  it("fits accumulated context under the default cap without changing the current request or state", async () => {
    const fetchImpl = vi.fn(async () => completion({ content: "Which workout do you mean?" }));
    const crowded: InterpretRequest = {
      ...request,
      message: "Epi my event at 330 is done",
      history: Array.from({ length: 8 }, (_, index) => ({
        role: index % 2 ? "assistant" : "user",
        text: "Earlier task discussion. ".repeat(20),
      })),
      openTasks: Array.from({ length: 40 }, (_, index) => ({
        id: `task-${index}`,
        title: `Unrelated task ${index} ${"long title ".repeat(20)}`,
        due: null,
      })),
      recentNotes: Array.from({ length: 20 }, (_, index) => ({
        id: `note-${index}`,
        title: "An earlier note ".repeat(20),
      })),
      lastReminder: {
        reminderId: "reminder-1",
        subjectType: "event",
        subjectId: "gym-1",
        title: "Gym workout",
      },
      pending: "Confirm the current setting",
    };
    const before = structuredClone(crowded);
    await provider(fetchImpl, { maxInputTokens: 8000 }).interpret(crowded);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    const content = body.messages[1].content;
    expect(
      Math.ceil((SYSTEM_PROMPT.length + JSON.stringify(body.tools).length + content.length) / 4),
    ).toBeLessThanOrEqual(8000);
    expect(JSON.parse(content)).toMatchObject({
      message: crowded.message,
      lastReminder: crowded.lastReminder,
      pending: crowded.pending,
      contextLimited: true,
    });
    expect(crowded).toEqual(before);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a truly oversized current message before dispatch and accepts the next short one", async () => {
    const fetchImpl = vi.fn(async () => completion({ content: "What should the note say?" }));
    const capped = provider(fetchImpl, { maxInputTokens: 8000 });
    await expect(
      capped.interpret({ ...request, message: "x".repeat(32_000) }),
    ).rejects.toMatchObject({ tooLarge: true });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(
      (await capped.interpret({ ...request, message: "Save a note about dinner" })).intent,
    ).toMatchObject({ kind: "respond" });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    [429, true],
    [500, true],
    [503, true],
    [400, false],
    [401, false],
  ])("handles HTTP %i without retries or leaking response details", async (status, retryable) => {
    const fetchImpl = vi.fn(async () => new Response("private response", { status }));
    await expect(provider(fetchImpl).interpret(request)).rejects.toMatchObject({
      name: "ProviderUnavailableError",
      retryable,
      message: `The AI service returned HTTP ${status}.`,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("never leaks request details or the key when the network fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED while sending ${KEY} ${request.message}`);
    });
    const failure = await provider(fetchImpl)
      .interpret(request)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect((failure as Error).message).toBe("The AI service could not be reached.");
  });

  it.each([
    [{ content: null, refusal: "Private refusal details" }, "stop", "refusal"],
    [
      { content: "Incomplete", tool_calls: [tool("create_task", { title: "Drill" })] },
      "length",
      "truncated",
    ],
    [{ content: "Private filter details" }, "content_filter", "refusal"],
    [{ content: null }, "stop", "invalid"],
    [{ content: 42 }, "stop", "invalid"],
    [{ content: "Hello" }, "function_call", "invalid"],
  ])(
    "distinguishes unusable output from network failure and preserves cost",
    async (message, finish, reason) => {
      const fetchImpl = vi.fn(async () =>
        completion(message, { prompt_tokens: 1000, completion_tokens: 100 }, finish),
      );
      const failure = await provider(fetchImpl)
        .interpret(request)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderOutputError);
      expect(failure).toMatchObject({ reason, costUsd: 0.0028 });
      expect((failure as Error).message).not.toContain("Private");
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it.each(["null", "{}", "{bad json", '{"choices":[]}'])(
    "safely rejects malformed response %s",
    async (body) => {
      await expect(
        provider(vi.fn(async () => new Response(body))).interpret(request),
      ).rejects.toBeInstanceOf(ProviderOutputError);
    },
  );

  it.each([undefined, {}, { prompt_tokens: -5, completion_tokens: "bad" }])(
    "treats missing or invalid usage as zero cost: %j",
    async (usage) => {
      const fetchImpl = vi.fn(
        async () =>
          new Response(
            JSON.stringify({ choices: [{ message: { content: "Let's discuss it." } }], usage }),
          ),
      );
      expect((await provider(fetchImpl).interpret(request)).costUsd).toBe(0);
    },
  );
});
