import type { Intent } from "./intent";

export interface OpenTaskContext {
  id: string;
  title: string;
  // Local date (owner's timezone) or null.
  due: string | null;
  taskType?: "task" | "todo";
  priority?: "minor" | "major";
  estimatedMinutes?: number | null;
}

export interface NoteContext {
  id: string;
  title: string;
  kind?: "note" | "idea";
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
  lastReminder?: {
    reminderId: string;
    subjectType: "task" | "event" | null;
    subjectId: string | null;
    title: string;
  } | null;
  events?: { id: string; title: string; startsAt: string; endsAt: string; allDay: boolean }[];
  history: Turn[];
  // Summary of an action waiting for yes or no, if any.
  pending: string | null;
  // What the owner has asked Epi to remember (confirmed only). Current records always win over a
  // remembered summary.
  memories: string[];
  // Existing names only; the model must not invent categories for a pasted list.
  categories?: string[];
  activeIdea?: {
    id: string;
    title: string;
    body: string;
    truncated: boolean;
  } | null;
  // An observed flat list count, not an AI guess about the number of tasks.
  listedEntryCount?: number;
}

export interface InterpretResult {
  intent: Intent;
  // A proposed action was rejected; conversational text is still useful, but no action may run.
  invalidAction?: boolean;
  // Estimated cost in USD from provider usage and configured prices (not a billing guarantee).
  costUsd: number;
}

// A response arrived, but cannot safely be used. Fixed messages only; never attach raw output.
export class ProviderOutputError extends Error {
  constructor(
    readonly reason: "invalid" | "refusal" | "truncated",
    readonly costUsd = 0,
  ) {
    super(`The AI service returned ${reason} output.`);
    this.name = "ProviderOutputError";
  }
}

export interface TextProvider {
  interpret(request: InterpretRequest): Promise<InterpretResult>;
}

// The provider is unreachable/rate limited, or a request was refused before dispatch.
export class ProviderUnavailableError extends Error {
  readonly retryable: boolean;
  // True when the message was more than one request can handle (too long to read, or too much to
  // answer), so the owner should send it in smaller pieces rather than try again as it is.
  readonly tooLarge: boolean;
  constructor(message: string, retryable = true, tooLarge = false) {
    super(message);
    this.name = "ProviderUnavailableError";
    this.retryable = retryable;
    this.tooLarge = tooLarge;
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
