import type { Intent } from "./intent";

export interface OpenTaskContext {
  id: string;
  title: string;
  // Local date (owner's timezone) or null.
  due: string | null;
}

export interface NoteContext {
  id: string;
  title: string;
}

export interface Turn {
  role: "user" | "assistant";
  text: string;
}

// Everything a provider sees. Only what is needed to interpret the message is included, and
// only for a verified private owner conversation.
export interface InterpretRequest {
  message: string;
  now: string;
  timezone: string;
  today: string;
  weekday: string;
  openTasks: OpenTaskContext[];
  recentNotes: NoteContext[];
  // Numbered results of the previous list, so "the second one" can be resolved.
  lastListed: OpenTaskContext[];
  history: Turn[];
  // Summary of an action waiting for yes or no, if any.
  pending: string | null;
}

export interface InterpretResult {
  intent: Intent;
  // Billed cost of this call in USD, as computed by the adapter.
  costUsd: number;
}

export interface TextProvider {
  interpret(request: InterpretRequest): Promise<InterpretResult>;
}

// The provider is down, rate limited, or returned something unusable.
export class ProviderUnavailableError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable = true) {
    super(message);
    this.name = "ProviderUnavailableError";
    this.retryable = retryable;
  }
}

// A deterministic stand-in for tests: the handler decides the intent for each request.
export function createScriptedProvider(
  handler: (request: InterpretRequest) => Intent | Promise<Intent>,
  costUsd = 0,
): TextProvider & { calls: InterpretRequest[] } {
  const calls: InterpretRequest[] = [];
  return {
    calls,
    async interpret(request) {
      calls.push(request);
      return { intent: await handler(request), costUsd };
    },
  };
}
