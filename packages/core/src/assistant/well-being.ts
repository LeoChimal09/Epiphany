import type { Principal, Services } from "../services";
import { addDays, dateKeyOf, localWallToUtc } from "../planning/time";
import type { Budget } from "./budget";
import { ProviderOutputError, type InterpretRequest, type TextProvider } from "./provider";

// Not the owner's words: an internal request for one proactive question in private #well-being.
export const WELL_BEING_INSTRUCTION = `Internal request from Epi's scheduler, not a message from the owner. Do not call any function. Epi's goal is to get to know the owner as a person so it can talk and act more like they would. Reply with exactly ONE short, warm, curious, personal question (under 200 characters), like a close friend checking in. Anything about their life is welcome: how they are really doing, feelings, people they care about, hobbies, tastes, values, habits, routines, memories, goals, plans, what they enjoy or dislike, or how they like to talk and be talked to. Ground it in their current tasks, upcoming events, notes, ideas, or remembered facts shown in context when that makes it more meaningful (for example a trip, a gift for someone, an idea they keep building), otherwise ask something new about them. Prefer things not already in remembered facts. Ask, never assume or diagnose; keep it light enough to skip. Do not repeat or closely paraphrase a recently asked question. Output only the question.`;

const MAX_QUESTION = 240;

export function cleanWellBeingQuestion(text: string): string | null {
  const question = text
    .replace(/<@[!&]?\d+>|@(everyone|here)/g, "")
    .replace(/[`*_~>#]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^["']|["']$/g, "");
  if (question.length < 10 || question.length > MAX_QUESTION || !question.includes("?"))
    return null;
  return question;
}

// Writes one data-grounded question with the owner's own records. Returns null (caller falls back to a
// fixed question) when the budget is spent, the provider fails, or the output is not a plain question.
export async function composeWellBeingQuestion(options: {
  provider: TextProvider;
  budget: Budget;
  services: Services;
  principal: Principal;
  now: Date;
  timezone: string;
  recentQuestions?: string[];
}): Promise<string | null> {
  const recent = (options.recentQuestions ?? []).slice(-5);
  const question = await composePersonalLine(
    options,
    recent.length
      ? `${WELL_BEING_INSTRUCTION}\nRecently asked: ${recent.map((q) => `"${q}"`).join("; ")}`
      : WELL_BEING_INSTRUCTION,
  );
  if (!question) return null;
  const seen = recent.map((item) => item.toLowerCase());
  return seen.includes(question.toLowerCase()) ? null : question;
}

// A Jarvis-like morning opener for the briefing: greets the owner by their chosen form of address
// and asks how they are doing, informed by their day. Learning answers still need approval.
export function morningGreetingInstruction(address: string | null): string {
  return `Internal request from Epi's scheduler, not a message from the owner. Do not call any function. Write the opening line of the owner's morning briefing, like a loyal, warm, slightly witty personal assistant (think Jarvis). ${address ? `Address the owner as "${address}". ` : ""}Greet them for the morning and ask ONE short, personal "how are we doing" style question, optionally tied to something meaningful today or this week from context (an event, a deadline, a remembered fact). Under 200 characters, no lists, do not summarize the schedule (the briefing follows). Output only the line.`;
}

export interface MorningGreetingSetting {
  enabled: boolean;
  address: string | null;
}

export function parseMorningGreeting(value: unknown): MorningGreetingSetting {
  const v = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
  const address = typeof v.address === "string" ? v.address.trim().slice(0, 40) : "";
  return { enabled: v.enabled === true, address: address || null };
}

export function fallbackMorningGreeting(address: string | null): string {
  return `Good morning${address ? `, ${address}` : ""}. How are we doing today?`;
}

export async function composeMorningGreeting(options: {
  provider: TextProvider;
  budget: Budget;
  services: Services;
  principal: Principal;
  now: Date;
  timezone: string;
  address: string | null;
}): Promise<string | null> {
  return composePersonalLine(options, morningGreetingInstruction(options.address));
}

// Sends one internal instruction with the owner's own records and accepts only a short plain line
// that asks something. Null when the budget is spent, the provider fails, or the output is unusable.
async function composePersonalLine(
  options: {
    provider: TextProvider;
    budget: Budget;
    services: Services;
    principal: Principal;
    now: Date;
    timezone: string;
  },
  instruction: string,
): Promise<string | null> {
  const { provider, budget, services, principal, now, timezone } = options;
  if (!(await budget.check()).allowed) return null;
  const today = dateKeyOf(now, timezone);
  const [tasks, notes, events, preferences] = await Promise.all([
    services.tasks.list(principal, { status: "open", limit: 30 }),
    services.notes.list(principal, { limit: 15 }),
    services.events.list(principal, {
      from: now,
      to: localWallToUtc(addDays(today, 7), 0, timezone),
      limit: 30,
    }),
    services.preferences.list(principal),
  ]);
  const memories = preferences
    .filter((row) => row.key.startsWith("memory.") && row.status === "confirmed")
    .map((row) => String((row.value as { text?: unknown } | null)?.text ?? "").trim())
    .filter(Boolean)
    .slice(0, 20);
  const request: InterpretRequest = {
    message: instruction,
    now: now.toISOString(),
    timezone,
    today,
    weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(now),
    openTasks: tasks.map((task) => ({
      id: task.id,
      title: task.title,
      due: task.dueAt ? dateKeyOf(task.dueAt, timezone) : null,
      taskType: task.taskType,
      priority: task.priority,
    })),
    recentNotes: notes.map((note) => ({
      id: note.id,
      title: (note.title?.trim() || note.body.trim().split("\n")[0] || "").slice(0, 120),
      kind: note.kind,
    })),
    events: events.map((event) => ({
      id: event.id,
      title: event.title,
      startsAt: event.startsAt.toISOString(),
      endsAt: event.endsAt.toISOString(),
      allDay: event.allDay,
    })),
    lastListed: [],
    history: [],
    pending: null,
    memories,
  };
  try {
    const result = await provider.interpret(request);
    await budget.record(result.costUsd);
    if (result.invalidAction || result.intent.kind !== "respond") return null;
    return cleanWellBeingQuestion(result.intent.text);
  } catch (error) {
    if (error instanceof ProviderOutputError) await budget.record(error.costUsd);
    return null;
  }
}
