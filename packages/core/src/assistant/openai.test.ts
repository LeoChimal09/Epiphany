import { describe, expect, it, vi } from "vitest";
import { createOpenAiProvider, SYSTEM_PROMPT } from "./openai";
import { ProviderUnavailableError, type InterpretRequest } from "./provider";

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
};

const wire = (over: Record<string, unknown>) => ({
  kind: "respond",
  text: null,
  title: null,
  details: null,
  due_date: null,
  due_time: null,
  estimated_minutes: null,
  status: null,
  from_date: null,
  through_date: null,
  search: null,
  reference: null,
  target_id: null,
  ...over,
});

const completion = (content: unknown, usage = { prompt_tokens: 1000, completion_tokens: 100 }) =>
  new Response(
    JSON.stringify({ choices: [{ message: { content: JSON.stringify(content) } }], usage }),
    {
      status: 200,
    },
  );

const provider = (fetchImpl: typeof fetch) =>
  createOpenAiProvider({
    apiKey: KEY,
    model: "model-under-test",
    pricing: { inputPerMillion: 2, outputPerMillion: 8 },
    fetch: fetchImpl,
  });

describe("OpenAI provider adapter", () => {
  it("applies per-request token caps, refusing oversized input before any call", async () => {
    const fetchImpl = vi.fn(async () => completion(wire({ kind: "decline" })));
    const capped = createOpenAiProvider({
      apiKey: KEY,
      model: "model-under-test",
      pricing: { inputPerMillion: 2, outputPerMillion: 8 },
      maxInputTokens: 100,
      maxOutputTokens: 321,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    const failure = await capped.interpret(request).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect((failure as ProviderUnavailableError).retryable).toBe(false);
    expect(fetchImpl).not.toHaveBeenCalled();

    const roomy = createOpenAiProvider({
      apiKey: KEY,
      model: "model-under-test",
      pricing: { inputPerMillion: 2, outputPerMillion: 8 },
      maxInputTokens: 8000,
      maxOutputTokens: 321,
      fetch: fetchImpl as unknown as typeof fetch,
    });
    await roomy.interpret(request);
    const [, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(JSON.parse(String(init.body)).max_completion_tokens).toBe(321);
  });

  it("sends a strict structured-output request and returns a typed intent with its cost", async () => {
    const fetchImpl = vi.fn(async () =>
      completion(wire({ kind: "complete_task", reference: "chem lab", target_id: "t1" })),
    );
    const result = await provider(fetchImpl as unknown as typeof fetch).interpret(request);

    expect(result.intent).toEqual({ kind: "complete_task", reference: "chem lab", targetId: "t1" });
    expect(result.costUsd).toBeCloseTo((1000 * 2 + 100 * 8) / 1_000_000, 10);

    const [url, init] = fetchImpl.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${KEY}`);
    const body = JSON.parse(String(init.body));
    expect(body.model).toBe("model-under-test");
    expect(body.response_format.type).toBe("json_schema");
    expect(body.response_format.json_schema.strict).toBe(true);
    expect(body.messages[0]).toEqual({ role: "system", content: SYSTEM_PROMPT });
    expect(JSON.parse(body.messages[1].content)).toMatchObject({
      message: "finished the chem lab",
      today: "2026-10-14",
      openTasks: [{ id: "t1" }],
    });
    // The key travels only in the header.
    expect(String(init.body)).not.toContain(KEY);
  });

  it("treats rate limits and server errors as retryable and other HTTP errors as not", async () => {
    for (const [status, retryable] of [
      [429, true],
      [500, true],
      [503, true],
      [400, false],
      [401, false],
    ] as const) {
      const fetchImpl = vi.fn(async () => new Response("{}", { status }));
      const failure = await provider(fetchImpl as unknown as typeof fetch)
        .interpret(request)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect((failure as ProviderUnavailableError).retryable).toBe(retryable);
      expect((failure as Error).message).toContain(String(status));
      expect((failure as Error).message).not.toContain(KEY);
    }
  });

  it("never leaks request details or the key when the network fails", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error(`connect ECONNREFUSED while sending Bearer ${KEY}`);
    });
    const failure = await provider(fetchImpl as unknown as typeof fetch)
      .interpret(request)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(ProviderUnavailableError);
    expect((failure as Error).message).not.toContain(KEY);
    expect((failure as Error).message).not.toContain("ECONNREFUSED");
  });

  it("rejects refusals, empty answers, bad JSON, and answers outside the contract", async () => {
    const bodies: unknown[] = [
      { choices: [{ message: { content: null, refusal: "I can't help with that." } }] },
      { choices: [] },
      { choices: [{ message: { content: "not json" } }] },
      { choices: [{ message: { content: JSON.stringify(wire({ kind: "drop_database" })) } }] },
      {
        choices: [
          { message: { content: JSON.stringify(wire({ kind: "create_task", title: null })) } },
        ],
      },
    ];
    for (const body of bodies) {
      const fetchImpl = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 }));
      const failure = await provider(fetchImpl as unknown as typeof fetch)
        .interpret(request)
        .catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(ProviderUnavailableError);
      expect((failure as ProviderUnavailableError).retryable).toBe(false);
    }
  });

  it("treats missing usage as zero cost", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(wire({ kind: "decline" })) } }],
          }),
          {
            status: 200,
          },
        ),
    );
    expect((await provider(fetchImpl as unknown as typeof fetch).interpret(request)).costUsd).toBe(
      0,
    );
  });
});
