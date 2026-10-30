import {
  ConfirmationError,
  ConfirmationRequiredError,
  CONFIRMATION_TTL_MS,
  ValidationError,
  VersionConflictError,
  assertPrincipal,
  authorize,
  type Principal,
  type Services,
} from "../services";
import {
  addDays,
  dateKeyOf,
  localParts,
  localWallToUtc,
  parseTimeOfDay,
  type DateKey,
} from "../planning/time";
import {
  computeAvailability,
  DEFAULT_TASK_MINUTES,
  findConflicts,
  recommendWorkBlocks,
  parsePlanningPreferences,
  type FixedEvent,
  type PlannedBlock,
} from "../planning";
import { needsConsent } from "./settings";
import { buildInsights, estimateFor } from "../insights";
import type { Budget } from "./budget";
import type { CaptureItem, Intent } from "./intent";
import { createHash } from "node:crypto";
import { findDuplicate, resolveReference, similarTitles, type Candidate } from "./matching";
import { asksNotToSave } from "./nosave";
import { routineIntent } from "./routine";
import { listedEntryCount, parseCourseList } from "./intake";
import { appendIdeaPoints } from "./idea-journal";
import { ProviderOutputError, ProviderUnavailableError } from "./provider";
import type { VoiceCapability, WorkspaceCapability, WorkspaceSetupResult } from "./workspace";
import type {
  InterpretRequest,
  NoteContext,
  OpenTaskContext,
  TextProvider,
  Turn,
} from "./provider";
import type { CalendarEvent, Note, Task } from "../db/schema";

// Long enough for a pasted page of assignments from a school system.
export const MAX_MESSAGE_LENGTH = 8000;
const MAX_TURNS = 8;
const PROVIDER_TASKS = 40;
const PROVIDER_NOTES = 20;
const POOL_LIMIT = 100;
const LIST_LINES = 12;

export interface PendingAction {
  confirmationId: string;
  payloadHash: string;
  summary: string;
  expiresAt: string;
}

// The short-term context for one conversation (for example one Discord DM channel).
// The one change that "undo" can take back: the most recent completion or category move.
export type LastChange =
  | { kind: "completed"; taskId: string; title: string }
  | { kind: "moved"; taskId: string; title: string; fromCategoryId: string; fromCategory: string };

// The reminder Epi last sent in this conversation, so "snooze", "done", or "not going" mean it.
export interface LastReminder {
  reminderId: string;
  kind: string;
  subjectType: "task" | "event" | null;
  subjectId: string | null;
  title: string;
  receivedAt?: string;
}

// A setting change that needs a clear yes (raising how much Epi may notify the owner).
export interface PendingSetting {
  key: string;
  valueJson: string;
  summary: string;
}

// Work blocks Epi proposed after showing the schedule, waiting for the owner's yes.
export interface PendingPlan {
  items: { taskId: string; title: string; startsAt: string; endsAt: string }[];
}

// A remembered preference Epi proposed and is waiting for a yes or no about.
export interface PendingMemory {
  key: string;
  text: string;
}

export interface PendingCapture {
  ownerId: string;
  items: CaptureItem[];
  omitted: number;
  sourceText: string;
  sourceRef?: string;
  expiresAt: string;
}

export interface ConversationState {
  turns: Turn[];
  activeIdea?: { ownerId: string; noteId: string } | null;
  pendingCapture?: PendingCapture | null;
  pendingMemory?: PendingMemory | null;
  pendingSetting?: PendingSetting | null;
  pendingPlan?: PendingPlan | null;
  lastReminder?: LastReminder | null;
  listed: OpenTaskContext[];
  pending: PendingAction | null;
  lastChange?: LastChange | null;
}

export const emptyConversation = (): ConversationState => ({
  turns: [],
  listed: [],
  pending: null,
});

export type Outcome =
  | "answered"
  | "clarification"
  | "listed"
  | "created"
  | "completed"
  | "confirmation_needed"
  | "deleted"
  | "declined"
  | "not_found"
  | "failed"
  | "uncertain"
  | "unavailable"
  | "denied";

export interface AssistantReply {
  text: string;
  outcome: Outcome;
  // True only when a record was actually persisted by this message.
  changed: boolean;
}

// Extra facts about one incoming message.
export interface MessageContext {
  // Where it came from (for example "discord:<channel>/<message>"), stored on created records.
  sourceRef?: string;
}

export interface AssistantOptions {
  appUrl?: string;
  services: Services;
  provider: TextProvider;
  budget: Budget;
  // The owner's timezone; the model only ever reasons in local dates and times.
  timezone: string;
  // Only the Discord runtime can set up channels; without it the request is declined honestly.
  workspace?: WorkspaceCapability;
  // Only the Discord runtime can join a voice channel.
  voice?: VoiceCapability;
  clock?: () => Date;
}

const dayLabel = (key: DateKey) => {
  const [year, month, day] = key.split("-").map(Number) as [number, number, number];
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(Date.UTC(year, month - 1, day, 12)));
};

function localDue(task: Task, timezone: string): DateKey | null {
  if (!task.dueAt) return null;
  return task.dueDateOnly ? task.dueAt.toISOString().slice(0, 10) : dateKeyOf(task.dueAt, timezone);
}

function dueText(task: Task, timezone: string): string {
  const key = localDue(task, timezone);
  if (!key) return "no deadline";
  if (task.dueDateOnly || !task.dueAt) return `due ${dayLabel(key)}`;
  const time = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    hour: "numeric",
    minute: "2-digit",
  })
    .format(task.dueAt)
    // Some runtimes use a narrow no-break space before AM/PM.
    .replace(/\u202f/g, " ");
  return `due ${dayLabel(key)}, ${time}`;
}

const taskContext = (task: Task, timezone: string): OpenTaskContext => ({
  id: task.id,
  title: task.title,
  due: localDue(task, timezone),
  taskType: task.taskType,
  priority: task.priority,
  estimatedMinutes: task.estimatedMinutes,
});

const noteTitle = (note: Note) => note.title?.trim() || note.body.trim().slice(0, 60);

function numbered(items: string[]): string {
  return items.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

// The service layer reports a missing or other-owner record the same way: not found.
function isMissingRecord(error: unknown): boolean {
  return error instanceof Error && error.name === "NotFoundError";
}

// The same text always maps to the same key, so remembering something twice stores it once.
function memoryKey(text: string): string {
  return `memory.${createHash("sha256").update(text.toLowerCase()).digest("hex").slice(0, 12)}`;
}

function workspaceReply(result: WorkspaceSetupResult): AssistantReply {
  switch (result.status) {
    case "ready": {
      if (result.created.length === 0 && !result.categoryCreated) {
        return {
          text: `Your workspace in ${result.server} is already set up, so I didn't change anything. You can talk to me in #assistant or right here.`,
          outcome: "answered",
          changed: false,
        };
      }
      const list = result.created.map((name) => `#${name}`).join(", ");
      return {
        text: result.categoryCreated
          ? `All set. I created a private "epiphany" category in ${result.server} with these channels: ${list}. Only you and I can see it, so say hi in #assistant whenever you're ready.`
          : `Done. I added the missing channels to your "epiphany" category in ${result.server}: ${list}. Everything else was already there, so I left it alone.`,
        outcome: "created",
        changed: true,
      };
    }
    case "choose":
      return {
        text: `I share more than one server with you: ${result.servers.join(", ")}. Which one should I set up? Just tell me its name.`,
        outcome: "clarification",
        changed: false,
      };
    case "no_server":
      return {
        text: "I'm not in any server you're a member of yet. Invite me to one, then ask me again and I'll set it up.",
        outcome: "not_found",
        changed: false,
      };
    case "blocked": {
      const madeAny = result.created.length > 0 || result.categoryCreated;
      const made = madeAny
        ? ` Before stopping I had already created ${[...(result.categoryCreated ? ['the "epiphany" category'] : []), ...result.created.map((name) => `#${name}`)].join(", ")}.`
        : "";
      const why =
        result.reason === "missing_permissions"
          ? "I'm missing a permission there. I need Manage Channels, View Channels, Send Messages, and Read Message History, but not Administrator. Once that's fixed, ask me again."
          : "Discord returned an error, so please try again in a moment.";
      return {
        text: `I couldn't finish setting up ${result.server}.${made} ${why}`,
        outcome: "failed",
        changed: madeAny,
      };
    }
    case "unavailable":
      return {
        text: "I can't reach Discord's server settings right now, so nothing was changed. Please try again in a moment.",
        outcome: "unavailable",
        changed: false,
      };
  }
}

function clearPending(state: ConversationState): ConversationState {
  return {
    ...state,
    pending: null,
    pendingMemory: null,
    pendingSetting: null,
    pendingPlan: null,
    pendingCapture: null,
  };
}

// Records why a step failed without logging message text, records, keys, or SQL parameters.
// Provider errors carry a fixed, safe message (for example "returned HTTP 403"); anything else is
// reduced to its class and driver/system code.
function logFailure(event: string, error: unknown): void {
  const detail =
    error instanceof ProviderUnavailableError
      ? { message: error.message, retryable: error.retryable }
      : {
          error: error instanceof Error ? error.name : typeof error,
          ...(typeof (error as { code?: unknown } | null)?.code === "string"
            ? { code: (error as { code: string }).code }
            : {}),
        };
  console.error(JSON.stringify({ service: "assistant", event, ...detail }));
}

// A conversational answer is a few sentences. The prompt asks for that; this keeps a runaway
// answer from filling the chat by cutting at the last sentence that fits.
export const MAX_REPLY_CHARS = 700;

export function fitReply(text: string, limit: number = MAX_REPLY_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return trimmed;
  const head = trimmed.slice(0, limit);
  const sentenceEnd = Math.max(
    head.lastIndexOf(". "),
    head.lastIndexOf("! "),
    head.lastIndexOf("? "),
  );
  if (sentenceEnd >= limit * 0.5) return head.slice(0, sentenceEnd + 1);
  const wordEnd = head.lastIndexOf(" ");
  return `${head.slice(0, wordEnd > 0 ? wordEnd : limit).trimEnd()}...`;
}

export function createAssistant(options: AssistantOptions) {
  const { services, provider, budget, timezone, workspace, voice } = options;
  const websiteUrl = options.appUrl ? new URL("/dashboard", options.appUrl).href : null;
  const clock = options.clock ?? (() => new Date());

  function finish(
    state: ConversationState,
    userText: string,
    reply: AssistantReply,
    patch: Partial<ConversationState> = {},
  ) {
    const turns: Turn[] = [
      ...state.turns,
      { role: "user" as const, text: userText.slice(0, 500) },
      { role: "assistant" as const, text: reply.text.slice(0, 500) },
    ].slice(-MAX_TURNS);
    // Only the change just made can be undone; anything said since forgets the older one.
    return { reply, state: { ...state, lastChange: null, ...patch, turns } };
  }

  return {
    // One owner message in, one reply out. The reply is built from what was persisted, never
    // from the model's claim, so a failed change is reported as a failure.
    async handle(
      principal: unknown,
      message: string,
      state: ConversationState = emptyConversation(),
      context: MessageContext = {},
    ): Promise<{ reply: AssistantReply; state: ConversationState }> {
      assertPrincipal(principal);
      if (principal.audience !== "private") {
        return {
          reply: {
            text: "I can only work with your tasks in a private conversation.",
            outcome: "denied",
            changed: false,
          },
          state,
        };
      }
      const userText = message.trim();
      if (
        state.lastReminder?.receivedAt &&
        clock().getTime() - Date.parse(state.lastReminder.receivedAt) > 60 * 60_000
      ) {
        state = { ...state, lastReminder: null, listed: [] };
      }
      if (!userText) {
        return {
          reply: {
            text: "I didn't catch anything. What would you like to do?",
            outcome: "answered",
            changed: false,
          },
          state,
        };
      }
      if (userText.length > MAX_MESSAGE_LENGTH) {
        return {
          reply: {
            text: `That message is too long for me to read in one go (the limit is ${MAX_MESSAGE_LENGTH} characters). Could you split it up?`,
            outcome: "failed",
            changed: false,
          },
          state,
        };
      }

      const localIntent = routineIntent(userText);
      if (localIntent) return execute(principal, localIntent, [], []);
      const courseList = asksNotToSave(userText)
        ? null
        : parseCourseList(userText, dateKeyOf(clock(), timezone));
      if (courseList) return execute(principal, courseList, [], []);

      const status = await budget.check();
      if (!status.allowed) {
        return finish(clearPending(state), userText, {
          text: "I've reached this month's AI limit, so I can't interpret free-form messages until it resets on the 1st. Nothing was changed, and the dashboard works as usual.",
          outcome: "unavailable",
          changed: false,
        });
      }

      let openTasks: Task[];
      let notes: Note[];
      let categories: string[];
      let activeIdea: Note | undefined;
      let currentEvents: CalendarEvent[];
      try {
        const today = dateKeyOf(clock(), timezone);
        const [taskRows, noteRows, categoryRows, eventRows] = await Promise.all([
          services.tasks.list(principal, { status: "open", limit: POOL_LIMIT }),
          services.notes.list(principal, { limit: POOL_LIMIT }),
          services.categories.list(principal),
          services.events.list(principal, {
            from: localWallToUtc(addDays(today, -1), 0, timezone),
            to: localWallToUtc(addDays(today, 7), 0, timezone),
            limit: 40,
          }),
        ]);
        currentEvents = eventRows;
        openTasks = taskRows;
        notes = noteRows;
        categories = categoryRows.map((category) => category.name);
        if (state.activeIdea?.ownerId === principal.ownerId) {
          try {
            const note = await services.notes.get(principal, state.activeIdea.noteId);
            if (note.kind === "idea") activeIdea = note;
          } catch (error) {
            if (!isMissingRecord(error)) throw error;
          }
        }
        if (activeIdea) {
          const currentIdea = activeIdea;
          notes = [currentIdea, ...notes.filter((note) => note.id !== currentIdea.id)];
        }
      } catch (error) {
        logFailure("records_unavailable", error);
        return finish(clearPending(state), userText, {
          text: "I couldn't load your records just now, so I didn't do anything. Please try again.",
          outcome: "failed",
          changed: false,
        });
      }

      const memories = (await loadMemories(principal))
        .filter((memory) => memory.confirmed)
        .map((memory) => memory.text)
        .slice(0, 20);
      const now = clock();
      const today = dateKeyOf(now, timezone);
      const entryCount = listedEntryCount(userText);
      const request: InterpretRequest = {
        message: userText,
        now: now.toISOString(),
        timezone,
        today,
        weekday: new Intl.DateTimeFormat("en-US", { timeZone: timezone, weekday: "long" }).format(
          now,
        ),
        openTasks: openTasks.slice(0, PROVIDER_TASKS).map((task) => taskContext(task, timezone)),
        recentNotes: notes
          .slice(0, PROVIDER_NOTES)
          .map((note): NoteContext => ({ id: note.id, title: noteTitle(note), kind: note.kind })),
        lastListed: state.lastReminder?.subjectType === "event" ? [] : state.listed,
        lastReminder: state.lastReminder ?? null,
        events: currentEvents.map((event) => ({
          id: event.id,
          title: event.title,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt.toISOString(),
          allDay: event.allDay,
        })),
        history: state.turns,
        pending:
          state.pending?.summary ??
          state.pendingSetting?.summary ??
          (state.pendingCapture
            ? `Save the ${state.pendingCapture.items.length} tasks and notes in the import preview`
            : state.pendingMemory
              ? `Remember: ${state.pendingMemory.text}`
              : state.pendingPlan
                ? "Schedule the proposed work blocks"
                : null),
        memories,
        categories,
        activeIdea: activeIdea
          ? {
              id: activeIdea.id,
              title: noteTitle(activeIdea),
              body: activeIdea.body.slice(0, 4000),
              truncated: activeIdea.body.length > 4000,
            }
          : null,
        ...(entryCount ? { listedEntryCount: entryCount } : {}),
      };

      let intent: Intent;
      try {
        const result = await provider.interpret(request);
        await budget.record(result.costUsd);
        if (result.invalidAction) {
          const warning =
            "I couldn't validate the requested action, so the update was not saved. Nothing was changed.";
          const conversation =
            result.intent.kind === "respond"
              ? fitReply(result.intent.text, MAX_REPLY_CHARS - warning.length - 2)
              : "";
          return finish(clearPending(state), userText, {
            text: conversation ? `${warning}\n\n${conversation}` : warning,
            outcome: "failed",
            changed: false,
          });
        }
        intent = result.intent;
      } catch (error) {
        logFailure("interpret_failed", error);
        if (error instanceof ProviderOutputError) {
          await budget.record(error.costUsd);
          return finish(clearPending(state), userText, {
            text:
              error.reason === "truncated"
                ? "The reply was cut short, so the update was not saved and nothing was changed. Could you send it in smaller pieces?"
                : error.reason === "refusal"
                  ? "I couldn't provide a usable reply to that request, so the update was not saved. Nothing was changed. Could you rephrase it?"
                  : "I couldn't validate the reply, so the update was not saved. Nothing was changed. Could you rephrase the request?",
            outcome: "failed",
            changed: false,
          });
        }
        if (error instanceof ProviderUnavailableError && error.tooLarge) {
          return finish(clearPending(state), userText, {
            text: "That's more than I can work through in one go, so I didn't save anything from it. Could you send it in smaller pieces, say about ten items at a time? Nothing was changed.",
            outcome: "failed",
            changed: false,
          });
        }
        return finish(clearPending(state), userText, {
          text: "I can't interpret messages right now, so I didn't do anything. The dashboard still works, and you can try again in a moment.",
          outcome: "unavailable",
          changed: false,
        });
      }

      return execute(principal, intent, openTasks, notes);

      async function execute(
        principal: Principal,
        intent: Intent,
        openTasks: Task[],
        notes: Note[],
      ) {
        // A pending confirmation only survives an immediate yes or no.
        const base: ConversationState =
          intent.kind === "confirm" || intent.kind === "decline"
            ? { ...state }
            : clearPending(state);
        if (
          ![
            "develop_idea",
            "resume_idea",
            "create_note",
            "website_link",
            "respond",
            "clarify",
          ].includes(intent.kind)
        ) {
          base.activeIdea = null;
        }
        try {
          const count = listedEntryCount(userText);
          const extracted =
            intent.kind === "capture"
              ? intent.items.length + (intent.omitted ?? 0)
              : intent.kind === "create_task" ||
                  (intent.kind === "create_note" && intent.noteKind !== "idea")
                ? 1
                : undefined;
          if (count && extracted !== undefined && extracted < count && !asksNotToSave(userText)) {
            return finish(clearPending(base), userText, {
              text: `I can see ${count} list entries, but I only extracted ${extracted} item${extracted === 1 ? "" : "s"}. I haven't saved anything because that would miss part of your list. Please resend the list in smaller groups or clarify which entries belong together.`,
              outcome: "clarification",
              changed: false,
            });
          }
          return await dispatch(principal, userText, intent, base, openTasks, notes, context);
        } catch (error) {
          logFailure("action_failed", error);
          if (error instanceof ValidationError) {
            return finish(base, userText, {
              text: `I couldn't do that: ${error.issues.join("; ")}. Nothing was changed.`,
              outcome: "failed",
              changed: false,
            });
          }
          return finish(base, userText, {
            text: "That didn't work, and nothing was changed. Please try again.",
            outcome: "failed",
            changed: false,
          });
        }
      }
    },
  };

  // A deadline given as a local date, with or without a time, in the owner's timezone. A date alone
  // is a date-only deadline: no time is invented.
  function dueFields(dueDate?: DateKey, dueTime?: string) {
    if (!dueDate) return { dueAt: undefined, dueDateOnly: undefined };
    if (dueTime) {
      return {
        dueAt: localWallToUtc(dueDate, parseTimeOfDay(dueTime), timezone),
        dueDateOnly: false,
      };
    }
    return { dueAt: new Date(`${dueDate}T00:00:00.000Z`), dueDateOnly: true };
  }

  // Everything the planning engine needs for a range of local dates.
  async function planningContext(principal: Principal, from: DateKey, to: DateKey) {
    const [prefRows, eventRows, blockRows] = await Promise.all([
      services.preferences.list(principal),
      services.events.list(principal, {
        from: localWallToUtc(addDays(from, -1), 0, timezone),
        to: localWallToUtc(addDays(to, 2), 0, timezone),
        limit: 200,
      }),
      services.workBlocks.list(principal, {
        from: localWallToUtc(from, 0, timezone),
        to: localWallToUtc(addDays(to, 1), 0, timezone),
        limit: 200,
      }),
    ]);
    const events: FixedEvent[] = eventRows.map((event) => ({
      id: event.id,
      title: event.title,
      startsAt: event.startsAt,
      endsAt: event.endsAt,
      allDay: event.allDay,
      timezone: event.timezone,
      status: event.status,
    }));
    const blocks: PlannedBlock[] = blockRows.map((block) => ({
      id: block.id,
      startsAt: block.startsAt,
      endsAt: block.endsAt,
      status: block.status,
    }));
    return {
      preferences: parsePlanningPreferences(prefRows, timezone),
      events,
      blocks,
      eventRows,
    };
  }

  function clockLabel(at: Date): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      hour: "numeric",
      minute: "2-digit",
    })
      .format(at)
      .replace(/\u202f/g, " ");
  }

  function dayWord(at: Date): string {
    return new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
    }).format(at);
  }

  async function showSchedule(
    principal: Principal,
    userText: string,
    intent: Extract<Intent, { kind: "show_schedule" }>,
    state: ConversationState,
    openTasks: Task[],
  ) {
    const now = clock();
    const today = dateKeyOf(now, timezone);
    const from = intent.from ?? today;
    const through = intent.through ?? (intent.from ? intent.from : addDays(today, 6));
    const last = through > addDays(from, 13) ? addDays(from, 13) : through;
    const context = await planningContext(principal, from, last);
    const { windows } = computeAvailability({
      range: { from, to: last },
      events: context.events,
      workBlocks: context.blocks,
      preferences: context.preferences,
      notBefore: now,
    });

    const days: string[] = [];
    for (let key = from; key <= last; key = addDays(key, 1)) {
      const parts: string[] = [];
      for (const event of context.eventRows) {
        if (event.status !== "scheduled") continue;
        if (dateKeyOf(event.startsAt, event.allDay ? event.timezone : timezone) !== key) continue;
        parts.push(
          event.allDay
            ? `${event.title} (all day)`
            : `${event.title} (${clockLabel(event.startsAt)} to ${clockLabel(event.endsAt)})`,
        );
      }
      for (const task of openTasks) {
        if (localDue(task, timezone) === key)
          parts.push(`${task.title} due ${dueText(task, timezone).replace(/^due /, "")}`);
      }
      if (parts.length > 0) {
        days.push(`• ${dayLabel(key)}: ${parts.join("; ")}`);
      }
    }

    const dueInRange = openTasks.filter((task) => {
      const due = localDue(task, timezone);
      return due !== null && due <= addDays(last, 3);
    });
    const recs = recommendWorkBlocks(
      dueInRange.map((task) => ({
        id: task.id,
        title: task.title,
        due: localDue(task, timezone),
        estimatedMinutes: task.estimatedMinutes,
      })),
      windows,
      4,
    );

    const label = from === last ? dayLabel(from) : `${dayLabel(from)} to ${dayLabel(last)}`;
    const lines: string[] = [
      days.length > 0 ? `Here's ${label}:` : `Nothing is scheduled or due for ${label}.`,
    ];
    lines.push(...days.slice(0, 10));
    if (windows.length === 0) {
      lines.push("I don't see free time inside your preferred hours in that stretch.");
    } else {
      const free = windows
        .slice(0, 4)
        .map(
          (window) =>
            `${dayWord(window.start)} ${clockLabel(window.start)} to ${clockLabel(window.end)}`,
        );
      lines.push(`Time you could use: ${free.join("; ")}.`);
    }
    if (recs.length > 0) {
      lines.push("What I'd tackle:");
      lines.push(
        numbered(
          recs.map(
            (rec) =>
              `${rec.title}: ${dayWord(rec.startsAt)}, ${clockLabel(rec.startsAt)} to ${clockLabel(rec.endsAt)}`,
          ),
        ),
      );
      lines.push("Want me to put those on your calendar?");
    } else if (dueInRange.length > 0) {
      lines.push(
        "I couldn't fit what's due into your free time, so you may want to move something or free up a window.",
      );
    }
    return finish(
      state,
      userText,
      { text: lines.join("\n"), outcome: "answered", changed: false },
      {
        pendingPlan:
          recs.length > 0
            ? {
                items: recs.map((rec) => ({
                  taskId: rec.taskId,
                  title: rec.title,
                  startsAt: rec.startsAt.toISOString(),
                  endsAt: rec.endsAt.toISOString(),
                })),
              }
            : null,
      },
    );
  }

  async function confirmPlan(
    principal: Principal,
    userText: string,
    state: ConversationState,
    plan: PendingPlan,
  ) {
    const created: string[] = [];
    const skipped: string[] = [];
    const first = plan.items[0];
    const start = first
      ? dateKeyOf(new Date(first.startsAt), timezone)
      : dateKeyOf(clock(), timezone);
    const end = plan.items.reduce(
      (latest, item) => Math.max(latest, new Date(item.endsAt).getTime()),
      clock().getTime(),
    );
    const context = await planningContext(principal, start, dateKeyOf(new Date(end), timezone));
    const blocks = [...context.blocks];
    for (const item of plan.items) {
      const candidate = { startsAt: new Date(item.startsAt), endsAt: new Date(item.endsAt) };
      const open = (await services.tasks.list(principal, { status: "open", limit: 100 })).some(
        (task) => task.id === item.taskId,
      );
      const conflicts = findConflicts(candidate, {
        events: context.events,
        workBlocks: blocks,
        preferences: context.preferences,
      });
      if (!open || conflicts.length > 0) {
        skipped.push(item.title);
        continue;
      }
      const block = await services.workBlocks.create(
        principal,
        {
          taskId: item.taskId,
          title: item.title,
          startsAt: candidate.startsAt,
          endsAt: candidate.endsAt,
        },
        { intent: "explicit" },
      );
      blocks.push({
        id: block.id,
        startsAt: block.startsAt,
        endsAt: block.endsAt,
        status: "planned",
      });
      created.push(
        `${item.title} (${dayWord(candidate.startsAt)}, ${clockLabel(candidate.startsAt)})`,
      );
    }
    const parts = [
      created.length > 0
        ? `Done, I put ${created.length === 1 ? "this" : "these"} on your calendar: ${created.join("; ")}.`
        : "",
      skipped.length > 0
        ? `I skipped ${skipped.map((title) => `"${title}"`).join(", ")} because the time is no longer free or the task changed.`
        : "",
    ].filter(Boolean);
    return finish(
      state,
      userText,
      {
        text: parts.join(" ") || "There was nothing to schedule.",
        outcome: created.length > 0 ? "created" : "failed",
        changed: created.length > 0,
      },
      { pendingPlan: null },
    );
  }

  async function planWork(
    principal: Principal,
    userText: string,
    intent: Extract<Intent, { kind: "plan_work" }>,
    state: ConversationState,
    openTasks: Task[],
  ) {
    const reply = (value: AssistantReply, patch?: Partial<ConversationState>) =>
      finish(state, userText, value, patch);
    const pool = openTasks.map((task) => ({ id: task.id, title: task.title }));
    const found = resolveReference(intent.reference, pool, {
      listed: state.listed.map(({ id, title }) => ({ id, title })),
      ...(intent.targetId ? { targetId: intent.targetId } : {}),
    });
    if (found.kind === "none") {
      return reply({
        text: `I couldn't find an open task matching "${intent.reference}", so I didn't schedule anything.`,
        outcome: "not_found",
        changed: false,
      });
    }
    if (found.kind === "many") {
      return reply(
        {
          text: `Which one do you mean?\n${numbered(found.items.slice(0, 5).map((item) => item.title))}`,
          outcome: "clarification",
          changed: false,
        },
        {
          listed: found.items
            .slice(0, 5)
            .map((item) => ({ id: item.id, title: item.title, due: null })),
        },
      );
    }
    const task = openTasks.find((entry) => entry.id === found.item.id)!;
    const minutes = intent.minutes ?? task.estimatedMinutes ?? DEFAULT_TASK_MINUTES;
    const startsAt = localWallToUtc(intent.date, parseTimeOfDay(intent.time), timezone);
    const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
    const day = dateKeyOf(startsAt, timezone);
    const context = await planningContext(principal, day, dateKeyOf(endsAt, timezone));
    const conflicts = findConflicts(
      { startsAt, endsAt },
      { events: context.events, workBlocks: context.blocks, preferences: context.preferences },
    );
    if (conflicts.length > 0) {
      const why = [
        ...new Set(
          conflicts.map((conflict) =>
            conflict.kind === "outside_preferred_hours"
              ? "it's outside the hours you like to work"
              : conflict.label
                ? `it overlaps ${conflict.label}`
                : `it overlaps your ${conflict.kind.replace("_", " ")}`,
          ),
        ),
      ].slice(0, 3);
      const next = computeAvailability({
        range: { from: day, to: addDays(day, 6) },
        events: context.events,
        workBlocks: context.blocks,
        preferences: context.preferences,
        notBefore: startsAt,
      }).windows.find((window) => window.minutes >= minutes);
      return reply({
        text: `I didn't schedule that, because ${why.join(" and ")}.${next ? ` The next free time that fits is ${dayWord(next.start)}, ${clockLabel(next.start)}. Want that instead?` : ""}`,
        outcome: "failed",
        changed: false,
      });
    }
    await services.workBlocks.create(
      principal,
      { taskId: task.id, title: task.title, startsAt, endsAt },
      { intent: "explicit" },
    );
    return reply({
      text: `Done. I blocked ${dayWord(startsAt)}, ${clockLabel(startsAt)} to ${clockLabel(endsAt)} for "${task.title}".`,
      outcome: "created",
      changed: true,
    });
  }

  // Whether the owner has turned learning from their habits on, and whether it is paused.
  async function tracking(principal: Principal) {
    const [enabled, paused] = await Promise.all([
      services.preferences.get(principal, "tracking.enabled"),
      services.preferences.get(principal, "tracking.paused"),
    ]);
    const on = enabled?.status === "confirmed" && enabled.value === true;
    const isPaused = paused?.status === "confirmed" && paused.value === true;
    return { enabled: on, paused: isPaused, active: on && !isPaused };
  }

  async function loadCorrections(principal: Principal) {
    const rows = await services.preferences.list(principal);
    return rows
      .filter((row) => row.key.startsWith("insight.correction.") && row.status === "confirmed")
      .map((row) => row.value as { key?: unknown; minutes?: unknown })
      .filter(
        (value): value is { key: string; minutes: number } =>
          typeof value.key === "string" && typeof value.minutes === "number",
      );
  }

  async function learnedEstimate(principal: Principal, title: string) {
    // The owner's own corrections always apply; estimates from reports need learning switched on.
    const state_ = await tracking(principal);
    return estimateFor(title, state_.active ? await services.insights.list(principal) : [], {
      corrections: await loadCorrections(principal),
    });
  }

  async function loadMemories(principal: Principal) {
    const rows = await services.preferences.list(principal);
    return rows
      .filter((row) => row.key.startsWith("memory."))
      .map((row) => ({
        key: row.key,
        text: String((row.value as { text?: unknown } | null)?.text ?? "").trim(),
        confirmed: row.status === "confirmed",
        source: row.source,
        savedAt: row.updatedAt,
      }))
      .filter((memory) => memory.text.length > 0);
  }

  async function proposeCancellation(
    principal: Principal,
    userText: string,
    state: ConversationState,
    eventId: string,
    scope: "occurrence" | "series",
  ) {
    const proposal = await services.confirmations.propose(principal, {
      action: "event.cancel_series",
      payload: { eventId, scope },
    });
    const summary = String(proposal.preview.summary);
    return finish(
      state,
      userText,
      {
        text: `${summary}. Nothing has changed yet. Should I cancel ${scope === "series" ? "these occurrences" : "this occurrence"}?`,
        outcome: "confirmation_needed",
        changed: false,
      },
      {
        pending: {
          confirmationId: proposal.confirmationId,
          payloadHash: proposal.payloadHash,
          summary: summary.slice(0, 400),
          expiresAt: proposal.expiresAt.toISOString(),
        },
      },
    );
  }

  // Removes the task's remaining planned work blocks once it is done. The blocks are marked
  // removed, not deleted, so history keeps them.
  async function clearPlannedBlocks(principal: Principal, taskId: string): Promise<number> {
    const from = clock();
    const to = new Date(from.getTime() + 60 * 24 * 3_600_000);
    const blocks = await services.workBlocks.list(principal, { from, to, limit: 200 });
    let cleared = 0;
    for (const block of blocks) {
      if (block.taskId !== taskId) continue;
      await services.workBlocks.remove(principal, block.id, "task_completed", {
        intent: "explicit",
      });
      cleared++;
    }
    return cleared;
  }

  // True when the task was finished at least a day before its deadline.
  function finishedEarly(task: Task): boolean {
    if (!task.dueAt) return false;
    const due = task.dueDateOnly
      ? localWallToUtc(task.dueAt.toISOString().slice(0, 10), 23 * 60 + 59, timezone)
      : task.dueAt;
    return due.getTime() - clock().getTime() >= 24 * 3_600_000;
  }

  async function capture(
    principal: Principal,
    userText: string,
    items: CaptureItem[],
    omitted: number,
    state: ConversationState,
    openTasks: Task[],
    notes: Note[],
    sourceRef: string | undefined,
    sourceText: string = userText,
  ) {
    const categories = await services.categories.list(principal);
    const byName = new Map(categories.map((category) => [category.name.toLowerCase(), category]));
    const known = openTasks.map((task) => ({
      title: task.title,
      due: localDue(task, timezone),
      details: task.details,
    }));
    const knownNotes = notes.map((note) => noteTitle(note));

    const savedTasks: { task: Task; category: string; flagged: string | null }[] = [];
    const savedNotes: { id: string; text: string; kind: string }[] = [];
    const remarks: string[] = [];
    const skipped: { title: string; existing: string }[] = [];
    const failed: string[] = [];
    const unverified: string[] = [];

    for (const item of items) {
      const category = item.category ? byName.get(item.category.toLowerCase()) : undefined;
      const categoryName = category?.name ?? "Inbox";
      if (item.category && !category) {
        remarks.push(
          `I don't have a "${item.category}" category, so "${item.title}" is in your Inbox.`,
        );
      }

      try {
        if (item.type === "task") {
          const due = item.dueDate ?? null;
          const repeat = findDuplicate({ title: item.title, due, details: item.details }, known);
          if (repeat) {
            skipped.push({ title: item.title, existing: repeat.title });
            continue;
          }
          const { dueAt, dueDateOnly } = dueFields(item.dueDate, item.dueTime);
          const task = await services.tasks.create(principal, {
            title: item.title,
            details: item.details,
            sourceText,
            sourceRef,
            dueAt,
            dueDateOnly,
            estimatedMinutes: item.estimatedMinutes,
            priority: item.priority,
            categoryId: category?.id,
            reviewNote: item.review ?? (!item.dueDate ? "no due date given" : undefined),
          });
          known.push({ title: task.title, due, details: task.details });
          savedTasks.push({ task, category: categoryName, flagged: task.reviewNote });
        } else {
          const existing = knownNotes.find((title) => similarTitles(item.title, title));
          if (existing) {
            skipped.push({ title: item.title, existing });
            continue;
          }
          const note = await services.notes.create(principal, {
            title: item.details ? item.title : undefined,
            body: item.details ?? item.title,
            kind: item.type,
            categoryId: category?.id,
            sourceRef,
          });
          knownNotes.push(noteTitle(note));
          savedNotes.push({ id: note.id, text: noteTitle(note), kind: note.kind });
        }
      } catch (error) {
        logFailure("capture_item_failed", error);
        if (error instanceof ValidationError) failed.push(item.title);
        else unverified.push(item.title);
      }
    }

    const parts: string[] = [];
    const total = savedTasks.length + savedNotes.length;
    if (total > 0) {
      parts.push(total === 1 ? "Got it, I saved that." : `Got it, I saved ${total} things.`);
    }
    if (savedTasks.length > 0) {
      const shown = savedTasks.slice(0, LIST_LINES);
      const lines = shown.map(({ task, category }) => {
        const effort = task.estimatedMinutes ? `, about ${task.estimatedMinutes} min` : "";
        const where = category === "Inbox" ? "" : `, ${category}`;
        return `${task.title} (${dueText(task, timezone)}${effort}${where})`;
      });
      const more = savedTasks.length - shown.length;
      parts.push(
        `Tasks:\n${numbered(lines)}${more > 0 ? `\n...and ${more} more, all saved. You'll find them in your Inbox.` : ""}`,
      );
    }
    if (savedNotes.length > 0) {
      parts.push(
        `Saved separately: ${savedNotes.map(({ kind, text }) => `${kind} "${text}"`).join(", ")}.`,
      );
    }
    const flagged = savedTasks.filter((entry) => entry.flagged);
    if (flagged.length > 0) {
      parts.push(
        `${flagged.length === 1 ? "One needs" : "A few need"} a look, so I flagged ${flagged.length === 1 ? "it" : "them"} for review in your Inbox: ${flagged.map(({ task }) => `"${task.title}" (${task.reviewNote})`).join("; ")}. Tell me what's missing and I'll fix it.`,
      );
    }
    parts.push(...remarks);
    for (const entry of skipped) {
      parts.push(`I skipped "${entry.title}" because you already have "${entry.existing}".`);
    }
    if (failed.length > 0) {
      parts.push(
        `I couldn't save ${failed.map((title) => `"${title}"`).join(", ")}, so nothing was stored for ${failed.length === 1 ? "it" : "those"}.`,
      );
    }
    if (unverified.length > 0) {
      parts.push(
        `I couldn't verify whether ${unverified.map((title) => `"${title}"`).join(", ")} ${unverified.length === 1 ? "was" : "were"} saved. Please check your Inbox before retrying; don't assume ${unverified.length === 1 ? "it was" : "they were"} saved or lost.`,
      );
    }
    if (omitted > 0) {
      parts.push(
        `That was more than I can take in at once, so I only went through the first ${items.length} items and left ${omitted} more out. Send the rest in another message and I'll add them.`,
      );
    }
    // Messy pasted text is easy to misread, so say plainly that something may have been missed.
    if (total >= 4) {
      parts.push(
        "Pasted lists can be messy and I can miss or misread an item, so please skim your Inbox to make sure everything is there.",
      );
    }
    if (total === 0 && skipped.length === 0 && failed.length === 0 && unverified.length === 0) {
      parts.push("I didn't find anything to save in that, so nothing was changed.");
    }

    return finish(
      state,
      userText,
      {
        text: parts.join("\n"),
        outcome:
          unverified.length > 0
            ? "uncertain"
            : total > 0
              ? "created"
              : failed.length > 0
                ? "failed"
                : "answered",
        changed: total > 0,
      },
      {
        listed: savedTasks.slice(0, LIST_LINES).map(({ task }) => taskContext(task, timezone)),
        pending: null,
        activeIdea:
          savedNotes.filter((note) => note.kind === "idea").length === 1
            ? {
                ownerId: principal.ownerId,
                noteId: savedNotes.find((note) => note.kind === "idea")!.id,
              }
            : null,
      },
    );
  }

  async function recategorize(
    principal: Principal,
    userText: string,
    intent: Extract<Intent, { kind: "recategorize" }>,
    state: ConversationState,
    openTasks: Task[],
    notes: Note[],
  ) {
    const reply = (value: AssistantReply, patch?: Partial<ConversationState>) =>
      finish(state, userText, value, patch);
    const categories = await services.categories.list(principal);
    const wanted = intent.category.trim().toLowerCase();
    const category = categories.find((entry) => entry.name.toLowerCase() === wanted);
    if (!category) {
      return reply({
        text: `I don't have a category called "${intent.category}". Your categories are ${categories.map((entry) => entry.name).join(", ")}. Which one should I use?`,
        outcome: "clarification",
        changed: false,
      });
    }

    const taskPool = openTasks.map((task) => ({ id: task.id, title: task.title }));
    const notePool = notes.map((note) => ({ id: note.id, title: noteTitle(note) }));
    const options = intent.targetId ? { targetId: intent.targetId } : {};
    const foundTask = resolveReference(intent.reference, taskPool, {
      listed: state.listed.map(({ id, title }) => ({ id, title })),
      ...options,
    });
    const foundNote = resolveReference(intent.reference, notePool, options);

    const ask = (items: Candidate[]) =>
      reply(
        {
          text: `Which one do you mean?\n${numbered(items.slice(0, 5).map((item) => item.title))}`,
          outcome: "clarification",
          changed: false,
        },
        {
          listed: items.slice(0, 5).map((item) => ({ id: item.id, title: item.title, due: null })),
        },
      );

    if (foundTask.kind === "many") return ask(foundTask.items);
    if (foundTask.kind === "one" && foundNote.kind !== "none") {
      return ask([
        foundTask.item,
        ...(foundNote.kind === "one" ? [foundNote.item] : foundNote.items),
      ]);
    }
    if (foundTask.kind === "none" && foundNote.kind === "many") return ask(foundNote.items);

    if (foundTask.kind === "one") {
      const task = openTasks.find((entry) => entry.id === foundTask.item.id)!;
      if (task.categoryId === category.id) {
        return reply({
          text: `"${task.title}" is already in ${category.name}, so I left it.`,
          outcome: "answered",
          changed: false,
        });
      }
      await services.tasks.update(principal, task.id, {
        categoryId: category.id,
        expectedVersion: task.version,
      });
      const fromCategory =
        categories.find((entry) => entry.id === task.categoryId)?.name ?? "its old category";
      return reply(
        {
          text: `Done. I moved "${task.title}" to ${category.name}.`,
          outcome: "completed",
          changed: true,
        },
        {
          lastChange: {
            kind: "moved",
            taskId: task.id,
            title: task.title,
            fromCategoryId: task.categoryId,
            fromCategory,
          },
        },
      );
    }
    if (foundNote.kind === "one") {
      const note = notes.find((entry) => entry.id === foundNote.item.id)!;
      if (note.categoryId === category.id) {
        return reply({
          text: `"${noteTitle(note)}" is already in ${category.name}, so I left it.`,
          outcome: "answered",
          changed: false,
        });
      }
      await services.notes.update(principal, note.id, {
        categoryId: category.id,
        expectedVersion: note.version,
      });
      return reply({
        text: `Done. I moved your ${note.kind} "${noteTitle(note)}" to ${category.name}.`,
        outcome: "completed",
        changed: true,
      });
    }
    return reply({
      text: `I couldn't find an open task or a note matching "${intent.reference}". Nothing was changed.`,
      outcome: "not_found",
      changed: false,
    });
  }

  async function developIdea(
    principal: Principal,
    userText: string,
    intent: Extract<Intent, { kind: "develop_idea" | "resume_idea" }>,
    state: ConversationState,
    notes: Note[],
  ) {
    const ideas = notes.filter((note) => note.kind === "idea");
    const active =
      state.activeIdea?.ownerId === principal.ownerId
        ? ideas.find((note) => note.id === state.activeIdea?.noteId)
        : undefined;
    const reference = /^(?:(?:this|that)(?: idea)?|it|the idea)$/i.test(intent.reference.trim())
      ? ""
      : intent.reference;
    const found = resolveReference(
      reference,
      ideas.map((note) => ({ id: note.id, title: noteTitle(note) })),
      {
        ...(intent.targetId ? { targetId: intent.targetId } : {}),
        listed: active ? [{ id: active.id, title: noteTitle(active) }] : [],
      },
    );
    if (found.kind !== "one") {
      return finish(
        state,
        userText,
        {
          text:
            found.kind === "many"
              ? `Which idea should we build on?\n${numbered(found.items.slice(0, 5).map((item) => item.title))}`
              : "Which saved idea should we build on? Tell me its title; I haven't changed anything.",
          outcome: "clarification",
          changed: false,
        },
        { activeIdea: null },
      );
    }
    const idea = ideas.find((note) => note.id === found.item.id)!;
    if (intent.kind === "resume_idea") {
      return finish(
        state,
        userText,
        {
          text: `Let's pick up "${noteTitle(idea)}". Here's the saved idea:\n\n${idea.body.slice(0, 1800)}${idea.body.length > 1800 ? "\n[Excerpt; open Ideas for the full text.]" : ""}\n\nWhat part would you like to explore next?`,
          outcome: "answered",
          changed: false,
        },
        { activeIdea: { ownerId: principal.ownerId, noteId: idea.id } },
      );
    }
    const { body, additions } = appendIdeaPoints(
      idea.body,
      intent.points,
      dateKeyOf(idea.createdAt, timezone),
      dateKeyOf(clock(), timezone),
    );
    const nextState = { activeIdea: { ownerId: principal.ownerId, noteId: idea.id } };
    const feedback = intent.feedback ? `\n\n${fitReply(intent.feedback)}` : "";
    if (additions.length === 0) {
      return finish(
        state,
        userText,
        {
          text: `Those points are already in "${noteTitle(idea)}", so I didn't add duplicates.${feedback}`,
          outcome: "answered",
          changed: false,
        },
        nextState,
      );
    }
    try {
      const result = await services.notes.update(principal, idea.id, {
        body,
        expectedVersion: idea.version,
      });
      return finish(
        state,
        userText,
        {
          text: `I added these points to "${noteTitle(result.note)}":\n${additions.map((point) => `- ${point}`).join("\n")}${feedback || "\nWhat would you like to explore next?"}`,
          outcome: "created",
          changed: result.changed,
        },
        nextState,
      );
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      if (!(error instanceof VersionConflictError)) {
        logFailure("idea_update_unverified", error);
        return finish(state, userText, {
          text: `I couldn't verify whether the new points were saved to "${noteTitle(idea)}". Please check the idea before retrying.`,
          outcome: "uncertain",
          changed: false,
        });
      }
      logFailure("idea_changed", error);
      return finish(state, userText, {
        text: "That idea changed while we were talking. I didn't overwrite it. Send your additions again so I can use the latest version.",
        outcome: "failed",
        changed: false,
      });
    }
  }

  async function dispatch(
    principal: Principal,
    userText: string,
    intent: Intent,
    state: ConversationState,
    openTasks: Task[],
    notes: Note[],
    context: MessageContext,
  ) {
    const reply = (value: AssistantReply, patch?: Partial<ConversationState>) =>
      finish(state, userText, value, patch);
    // Where the message came from, kept on every record created from it.
    const sourceRef = context.sourceRef?.slice(0, 255);

    // Saying "don't save this" or "just chatting" is honored whatever the model decided.
    if (
      (intent.kind === "create_task" ||
        intent.kind === "create_event" ||
        intent.kind === "create_note" ||
        intent.kind === "develop_idea" ||
        intent.kind === "capture") &&
      asksNotToSave(userText)
    ) {
      return reply({
        text: "Okay, I won't save that. We're just talking, and nothing was added to your tasks, notes, or events.",
        outcome: "answered",
        changed: false,
      });
    }

    const clarify = (items: Candidate[]) => {
      const shown = items.slice(0, 5);
      return reply(
        {
          text: `Which one do you mean?\n${numbered(shown.map((item) => item.title))}`,
          outcome: "clarification",
          changed: false,
        },
        { listed: shown.map((item) => ({ id: item.id, title: item.title, due: null })) },
      );
    };

    switch (intent.kind) {
      case "website_link":
        return reply({
          text: websiteUrl
            ? `Here's your Epiphany dashboard: ${websiteUrl}`
            : "The website address isn't configured here yet. Set APP_URL to your Epiphany website address.",
          outcome: websiteUrl ? "answered" : "unavailable",
          changed: false,
        });
      case "respond":
        return reply({ text: fitReply(intent.text), outcome: "answered", changed: false });

      case "clarify":
        return reply({ text: fitReply(intent.question), outcome: "clarification", changed: false });

      case "list_tasks": {
        const rows = await services.tasks.list(principal, {
          status: intent.status,
          limit: POOL_LIMIT,
        });
        const query = intent.search?.toLowerCase();
        const matched = rows.filter((task) => {
          if (intent.taskType && task.taskType !== intent.taskType) return false;
          const due = localDue(task, timezone);
          if ((intent.dueFrom || intent.dueThrough) && !due) return false;
          if (intent.dueFrom && due && due < intent.dueFrom) return false;
          if (intent.dueThrough && due && due > intent.dueThrough) return false;
          if (query) {
            return `${task.title} ${task.details ?? ""}`.toLowerCase().includes(query);
          }
          return true;
        });
        const label =
          intent.status === "completed" ? "completed" : intent.status === "all" ? "" : "open";
        const noun = intent.taskType === "todo" ? "to-dos" : "tasks";
        if (matched.length === 0) {
          return reply(
            {
              text: label
                ? `I don't see any ${label} ${noun} that match that. Want me to look at something else?`
                : `I don't see any ${noun} that match that. Want me to look at something else?`,
              outcome: "listed",
              changed: false,
            },
            { listed: [] },
          );
        }
        const shown = matched.slice(0, LIST_LINES);
        const more = matched.length - shown.length;
        const lines = shown.map((task) =>
          task.taskType === "todo"
            ? `${task.title} (to-do)`
            : `${task.title} (${task.priority}, ${dueText(task, timezone)}${task.estimatedMinutes ? `, ${task.estimatedMinutes} min` : ""})`,
        );
        const closing = more > 0 ? "" : "\nWant me to check any of these off?";
        const text = `${label ? `${label[0]!.toUpperCase()}${label.slice(1)}` : "Matching"} ${noun} (${matched.length}):\n${numbered(lines)}${more > 0 ? `\n...and ${more} more.` : ""}${closing}`;
        return reply(
          { text, outcome: "listed", changed: false },
          { listed: shown.map((task) => taskContext(task, timezone)) },
        );
      }

      case "create_task": {
        const due = dueFields(intent.dueDate, intent.dueTime);
        // With learning on, a task with no stated effort gets an estimate from what the owner has
        // reported for similar work (or their own correction), and says so.
        const learned =
          intent.estimatedMinutes || intent.taskType === "todo"
            ? null
            : await learnedEstimate(principal, intent.title);
        const task = await services.tasks.create(principal, {
          title: intent.title,
          taskType: intent.taskType,
          details: intent.details,
          sourceText: userText,
          sourceRef,
          dueAt: due.dueAt,
          dueDateOnly: due.dueDateOnly,
          estimatedMinutes: intent.estimatedMinutes ?? learned?.minutes,
          priority: intent.priority,
        });
        const effort = task.estimatedMinutes ? `, about ${task.estimatedMinutes} min` : "";
        const why = learned
          ? ` I guessed the time from ${learned.source === "correction" ? "what you told me" : "how long similar ones took you"}.`
          : "";
        const timingFollowUp =
          intent.taskType === "todo"
            ? ""
            : !due.dueAt && !task.estimatedMinutes
              ? " Do you know when it's due or how long it might take? That's optional; you can leave it as-is or add timing to the task later."
              : !due.dueAt
                ? " Do you know when it's due? That's optional; you can leave it as-is or add a due date later."
                : !task.estimatedMinutes
                  ? " Do you know how long it might take? That's optional; you can leave it as-is or add an estimate later."
                  : "";
        return reply({
          text:
            task.taskType === "todo"
              ? `Got it, I added "${task.title}" as a to-do.${timingFollowUp}`
              : `Got it, I added "${task.title}" to your list (${dueText(task, timezone)}${effort}).${why}${timingFollowUp}`,
          outcome: "created",
          changed: true,
        });
      }

      case "create_event": {
        const startsAt = localWallToUtc(intent.date, parseTimeOfDay(intent.startTime), timezone);
        const endsAt = localWallToUtc(intent.date, parseTimeOfDay(intent.endTime), timezone);
        if (intent.recurrence) {
          const events = await services.events.createSeries(principal, {
            title: intent.title,
            startDate: intent.date,
            startTime: intent.startTime,
            endTime: intent.endTime,
            timezone,
            location: intent.location,
            recurrence: intent.recurrence,
          });
          return reply({
            text: `I saved ${events.length} ${intent.recurrence.frequency} occurrences of "${intent.title}", from ${dayLabel(dateKeyOf(events[0]!.startsAt, timezone))} through ${dayLabel(dateKeyOf(events.at(-1)!.startsAt, timezone))}, at ${intent.startTime} to ${intent.endTime} (${timezone}). You can ask to cancel one occurrence or the whole series; I'll show the scope before confirming.`,
            outcome: "created",
            changed: true,
          });
        }
        const event = await services.events.create(principal, {
          title: intent.title,
          startsAt,
          endsAt,
          timezone,
          location: intent.location,
        });
        const time = new Intl.DateTimeFormat("en-US", {
          timeZone: timezone,
          hour: "numeric",
          minute: "2-digit",
        });
        const startTime = time.format(startsAt).replace(/\u202f/g, " ");
        const endTime = time.format(endsAt).replace(/\u202f/g, " ");
        return reply({
          text: `I added "${event.title}" to your calendar for ${dayLabel(intent.date)} from ${startTime} to ${endTime}.`,
          outcome: "created",
          changed: true,
        });
      }

      case "create_note": {
        if (intent.noteKind === "idea") {
          const title = intent.title?.trim() || intent.body.trim().slice(0, 60);
          const matching = notes.filter(
            (note) => note.kind === "idea" && similarTitles(title, noteTitle(note)),
          );
          if (matching.length > 0) {
            const repeated = findDuplicate(
              { title, due: null, details: intent.body },
              matching.map((note) => ({
                title: noteTitle(note),
                due: null,
                details: note.body,
              })),
            );
            return reply({
              text: repeated
                ? `The proposed save repeats an existing idea, "${noteTitle(matching[0]!)}", but may not match your latest request. I haven't saved or changed anything. Did you mean to add to that idea, save a separate idea with a different title, or create a task/reminder? If it's a reminder, when should I remind you?`
                : `You already have an idea titled "${noteTitle(matching[0]!)}", but the proposed content is different. I haven't saved or changed anything. Should these be new points in that idea, or a separate idea with a different title? If you meant a task/reminder instead, tell me what to do and when.`,
              outcome: "clarification",
              changed: false,
            });
          }
        }
        const note = await services.notes.create(principal, {
          title: intent.title,
          body: intent.body,
          kind: intent.noteKind,
          sourceRef,
        });
        return reply(
          {
            text:
              note.kind === "idea"
                ? `Saved your idea "${noteTitle(note)}".\n\n${intent.feedback ? fitReply(intent.feedback) : "What's the main problem you want it to solve? We can build it out together."}`
                : `Saved your ${note.kind} "${noteTitle(note)}". It's in your notes whenever you want it.`,
            outcome: "created",
            changed: true,
          },
          {
            activeIdea:
              note.kind === "idea" ? { ownerId: principal.ownerId, noteId: note.id } : null,
          },
        );
      }

      case "develop_idea":
      case "resume_idea":
        return developIdea(principal, userText, intent, state, notes);

      case "capture": {
        if (intent.items.length > 1 || intent.omitted) {
          const categories = await services.categories.list(principal);
          const lines = intent.items.map((item) => {
            const category = categories.find(
              (entry) => entry.name.toLowerCase() === item.category?.toLowerCase(),
            );
            const due = item.dueDate
              ? `${item.dueDate}${item.dueTime ? ` ${item.dueTime}` : ""}`
              : "no deadline";
            const review =
              item.review ?? (item.type === "task" && !item.dueDate ? "no due date given" : "");
            const details = item.details
              ? `\n   ${item.details.slice(0, 160)}${item.details.length > 160 ? "..." : ""}`
              : "";
            return `[${item.type}] ${item.title} (${due}; ${category?.name ?? "Inbox"}${item.estimatedMinutes ? `; ${item.estimatedMinutes} min` : ""})${review ? `; needs review: ${review}` : ""}${details}`;
          });
          const omitted = intent.omitted
            ? `\n${intent.omitted} more items were left out. Send those separately.`
            : "";
          return reply(
            {
              text: `I found ${intent.items.length} items. Nothing is saved yet; check for missing items, wrong dates, or categories:\n${numbered(lines)}${omitted}\nReply yes to save these, or no to discard them. To correct the list, send the corrected version instead. This preview expires in 10 minutes.`,
              outcome: "confirmation_needed",
              changed: false,
            },
            {
              pendingCapture: {
                ownerId: principal.ownerId,
                items: intent.items,
                omitted: intent.omitted ?? 0,
                sourceText: userText,
                ...(sourceRef ? { sourceRef } : {}),
                expiresAt: new Date(clock().getTime() + CONFIRMATION_TTL_MS).toISOString(),
              },
            },
          );
        }
        return capture(
          principal,
          userText,
          intent.items,
          intent.omitted ?? 0,
          state,
          openTasks,
          notes,
          sourceRef,
        );
      }

      case "voice_control": {
        authorize(principal, "voice.session", { intent: "explicit" });
        if (!voice) {
          return reply({
            text: "I can only join a voice channel from Discord. Ask me there, from a server voice channel, and I'll come in.",
            outcome: "unavailable",
            changed: false,
          });
        }
        const result = await voice.control(principal, intent.action);
        const text =
          result.status === "ok"
            ? result.text
            : result.status === "not_in_voice"
              ? "I can't see you in a voice channel. Join one in a server I'm in, then ask me again."
              : result.status === "nothing_to_do"
                ? "I'm not in a voice conversation right now, so there's nothing to change."
                : "Voice isn't set up right now, so I can't do that. Text still works.";
        return reply({
          text,
          outcome: result.status === "ok" ? "completed" : "answered",
          changed: false,
        });
      }

      case "report_duration": {
        const state_ = await tracking(principal);
        if (!state_.enabled) {
          return reply(
            {
              text: "I only keep track of how long things take if you turn that on. Do you want me to? I'd only record what you tell me, and you can pause or erase it any time.",
              outcome: "confirmation_needed",
              changed: false,
            },
            {
              pendingSetting: {
                key: "tracking.enabled",
                valueJson: "true",
                summary: "I'll learn from how long you tell me things take",
              },
            },
          );
        }
        if (state_.paused) {
          return reply({
            text: "Learning is paused, so I didn't record that. Tell me to resume whenever you like.",
            outcome: "answered",
            changed: false,
          });
        }
        const pool = openTasks.map((task) => ({ id: task.id, title: task.title }));
        const found = resolveReference(intent.reference, pool, {
          listed: state.listed.map(({ id, title }) => ({ id, title })),
          ...(intent.targetId ? { targetId: intent.targetId } : {}),
        });
        const subject =
          found.kind === "one"
            ? found.item.title
            : state.lastChange?.kind === "completed"
              ? state.lastChange.title
              : intent.reference;
        if (!subject.trim()) {
          return reply({
            text: "Which task was that? Tell me its name and how long it took.",
            outcome: "clarification",
            changed: false,
          });
        }
        await services.insights.record(principal, {
          kind: "duration",
          key: subject,
          value: intent.minutes,
        });
        return reply({
          text: `Thanks, I noted that "${subject}" took about ${intent.minutes} minutes. The more you tell me, the better my estimates get.`,
          outcome: "created",
          changed: true,
        });
      }

      case "show_insights": {
        const state_ = await tracking(principal);
        const observations = await services.insights.list(principal);
        const insights = state_.enabled ? buildInsights(observations) : [];
        const corrections = await loadCorrections(principal);
        const lines = [
          ...insights.map((insight) => insight.text),
          ...corrections.map(
            (entry) =>
              `You told me "${entry.key}" takes about ${entry.minutes} minutes, so I use that.`,
          ),
        ];
        if (!state_.enabled) {
          return reply({
            text: "I'm not learning from your habits right now, so there's nothing to show. Say the word and I'll start, only from what you tell me.",
            outcome: "answered",
            changed: false,
          });
        }
        return reply({
          text:
            lines.length > 0
              ? `Here's what I've picked up:\n${numbered(lines)}\nCorrect me any time, and what you say overrides what I guessed.`
              : `I don't have enough yet to say anything useful (I need a few reports of similar work; I have ${observations.length} so far). Nothing is concluded from a single report.${state_.paused ? " Learning is paused." : ""}`,
          outcome: "answered",
          changed: false,
        });
      }

      case "correct_estimate": {
        const subject = intent.subject.trim();
        await services.preferences.set(principal, {
          key: `insight.correction.${createHash("sha256").update(subject.toLowerCase()).digest("hex").slice(0, 12)}`,
          value: { key: subject, minutes: intent.minutes },
          status: "confirmed",
        });
        return reply({
          text: `Got it, "${subject}" takes about ${intent.minutes} minutes. That overrides anything I worked out myself.`,
          outcome: "created",
          changed: true,
        });
      }

      case "forget_insights": {
        const proposal = await services.confirmations.propose(principal, {
          action: "memory.clear",
          payload: { scope: "observations" },
        });
        const summary = String(proposal.preview.summary ?? "Forget what I've learned");
        return reply(
          {
            text: `${summary}. Reply "yes" within 10 minutes to confirm, or "no" to cancel.`,
            outcome: "confirmation_needed",
            changed: false,
          },
          {
            pending: {
              confirmationId: proposal.confirmationId,
              payloadHash: proposal.payloadHash,
              summary,
              expiresAt: proposal.expiresAt.toISOString(),
            },
          },
        );
      }

      case "set_preference": {
        const current = (await services.preferences.get(principal, intent.key))?.value;
        if (needsConsent(intent.key, intent.value, current)) {
          return reply(
            {
              text:
                intent.key === "tracking.enabled"
                  ? "Turning this on means I'll keep track of how long things take when you tell me, so my estimates get better. You can pause it or have me erase it any time, and I never record anything from silence. Do you want me to turn it on?"
                  : intent.key === "reminders.split"
                    ? `That adds split-day reminders (${intent.summary}) without changing your existing deadline alerts or daily notification limit. Do you want me to enable that?`
                    : `That would let me send you more reminders each day (${intent.summary}). Do you want me to raise it?`,
              outcome: "confirmation_needed",
              changed: false,
            },
            {
              pendingSetting: {
                key: intent.key,
                valueJson: JSON.stringify(intent.value),
                summary: intent.summary,
              },
            },
          );
        }
        await services.preferences.set(principal, {
          key: intent.key,
          value: intent.value,
          status: "confirmed",
        });
        return reply({
          text: `Done, ${intent.summary}.`,
          outcome: "created",
          changed: true,
        });
      }

      case "show_schedule":
        return showSchedule(principal, userText, intent, state, openTasks);

      case "plan_work":
        return planWork(principal, userText, intent, state, openTasks);

      case "remember": {
        if (asksNotToSave(userText)) {
          return reply({
            text: "Okay, I won't remember that. We're just talking.",
            outcome: "answered",
            changed: false,
          });
        }
        const text = intent.text.trim();
        const key = memoryKey(text);
        if (intent.explicit) {
          await services.preferences.set(principal, { key, value: { text }, status: "confirmed" });
          return reply({
            text: `Got it, I'll remember that: ${text}`,
            outcome: "created",
            changed: true,
          });
        }
        // Epi inferred this from conversation: keep it unconfirmed and unused until the owner agrees.
        await services.preferences.set(principal, { key, value: { text }, status: "proposed" });
        return reply(
          {
            text: `It sounds like this matters to you: ${text} Want me to remember it? I won't use it unless you say yes.`,
            outcome: "confirmation_needed",
            changed: false,
          },
          { pendingMemory: { key, text } },
        );
      }

      case "list_memory": {
        const items = await loadMemories(principal);
        if (items.length === 0) {
          return reply({
            text: "I'm not remembering anything about you yet. Tell me something to remember, and I'll keep it until you say to forget it.",
            outcome: "answered",
            changed: false,
          });
        }
        const lines = items.slice(0, 15).map((memory) => {
          const when = new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            month: "short",
            day: "numeric",
          }).format(memory.savedAt);
          return `${memory.text} (${memory.confirmed ? `saved from ${memory.source}, ${when}` : "not confirmed yet, so unused"})`;
        });
        return reply({
          text: `Here's what I remember:\n${numbered(lines)}\nTell me to forget any of it and it's gone.`,
          outcome: "answered",
          changed: false,
        });
      }

      case "forget": {
        const items = await loadMemories(principal);
        const found = resolveReference(
          intent.reference,
          items.map((memory) => ({ id: memory.key, title: memory.text })),
        );
        if (found.kind === "none") {
          return reply({
            text: `I couldn't find anything I remember that matches "${intent.reference}". Nothing was changed.`,
            outcome: "not_found",
            changed: false,
          });
        }
        if (found.kind === "many") return clarify(found.items);
        const proposal = await services.confirmations.propose(principal, {
          action: "preference.delete",
          payload: { key: found.item.id },
        });
        const summary = `Forget: ${found.item.title}`;
        return reply(
          {
            text: `${summary}. Reply "yes" within 10 minutes to confirm, or "no" to cancel.`,
            outcome: "confirmation_needed",
            changed: false,
          },
          {
            pending: {
              confirmationId: proposal.confirmationId,
              payloadHash: proposal.payloadHash,
              summary,
              expiresAt: proposal.expiresAt.toISOString(),
            },
          },
        );
      }

      case "undo": {
        const last = state.lastChange;
        if (!last) {
          return reply({
            text: "There's nothing recent for me to undo. You can reopen a finished task or edit one from the dashboard.",
            outcome: "answered",
            changed: false,
          });
        }
        try {
          if (last.kind === "completed") {
            const { changed } = await services.tasks.reopen(principal, last.taskId);
            return reply({
              text: changed
                ? `Okay, I reopened "${last.title}".`
                : `"${last.title}" is already open, so there was nothing to undo.`,
              outcome: "completed",
              changed,
            });
          }
          await services.tasks.update(principal, last.taskId, { categoryId: last.fromCategoryId });
          return reply({
            text: `Okay, I moved "${last.title}" back to ${last.fromCategory}.`,
            outcome: "completed",
            changed: true,
          });
        } catch (error) {
          if (!(error instanceof ValidationError) && !isMissingRecord(error)) throw error;
          return reply({
            text: `I couldn't undo that, because "${last.title}" has changed or is gone. Nothing was changed.`,
            outcome: "failed",
            changed: false,
          });
        }
      }

      case "snooze": {
        const last = state.lastReminder;
        if (!last) {
          return reply({
            text: "I'm not sure which reminder you mean. Tell me what to remind you about and when, and I'll set it up.",
            outcome: "clarification",
            changed: false,
          });
        }
        const moved = await services.reminders.snooze(principal, last.reminderId, intent.minutes);
        if (moved && (await tracking(principal)).active) {
          await services.insights.record(principal, {
            kind: "snooze",
            key: last.kind,
            value: intent.minutes,
          });
        }
        return reply(
          {
            text: moved
              ? `Okay, I'll remind you about "${last.title}" again in ${intent.minutes} minutes.`
              : `I couldn't snooze that one, because it has already gone out or been cleared. Nothing was changed.`,
            outcome: moved ? "completed" : "failed",
            changed: moved,
          },
          moved ? { lastReminder: null } : {},
        );
      }

      case "skip_event": {
        const last = state.lastReminder;
        if (!last || last.subjectType !== "event" || !last.subjectId) {
          return reply({
            text: "Which event are you skipping? I can only cancel one I just reminded you about, so tell me its name.",
            outcome: "clarification",
            changed: false,
          });
        }
        const event = await services.events.get(principal, last.subjectId);
        if (event.seriesId) {
          return proposeCancellation(principal, userText, state, event.id, "occurrence");
        }
        try {
          await services.events.cancel(principal, last.subjectId);
        } catch (error) {
          if (!(error instanceof ConfirmationRequiredError)) throw error;
          return reply({
            text: `"${last.title}" comes from your calendar, so I won't cancel it from here. Nothing was changed.`,
            outcome: "failed",
            changed: false,
          });
        }
        return reply(
          {
            text: `Okay, I canceled "${last.title}". It stays in your history if you change your mind.`,
            outcome: "completed",
            changed: true,
          },
          { lastReminder: null },
        );
      }

      case "pause_reminders": {
        if (intent.minutes) {
          const until = new Date(clock().getTime() + intent.minutes * 60_000).toISOString();
          await services.preferences.set(principal, {
            key: "reminders.paused_until",
            value: until,
            status: "confirmed",
          });
        } else {
          await services.preferences.set(principal, {
            key: "reminders.paused",
            value: true,
            status: "confirmed",
          });
        }
        return reply({
          text: intent.minutes
            ? `Okay, I'll stay quiet for ${intent.minutes} minutes. No reminders until then, and nothing is held against you.`
            : "Okay, I've paused reminders. Tell me when you want them back. Nothing is held against you.",
          outcome: "completed",
          changed: true,
        });
      }

      case "resume_reminders": {
        await services.preferences.set(principal, {
          key: "reminders.paused",
          value: false,
          status: "confirmed",
        });
        await services.preferences.set(principal, {
          key: "reminders.paused_until",
          value: new Date(0).toISOString(),
          status: "confirmed",
        });
        return reply({
          text: "Okay, reminders are back on. Anything you missed while they were paused is not replayed.",
          outcome: "completed",
          changed: true,
        });
      }

      case "start_activity": {
        const at = new Date(clock().getTime() + intent.minutes * 60_000);
        await services.reminders.create(principal, {
          message: `Time's up on "${intent.activity}". Still going, or ready to wrap up?`,
          at,
          kind: "check_in",
        });
        return reply({
          text: `Sounds good, enjoy your ${intent.activity}. I'll check in with you in ${intent.minutes} minutes.`,
          outcome: "created",
          changed: true,
        });
      }

      case "create_reminder": {
        const targetAt = localWallToUtc(intent.date, parseTimeOfDay(intent.time), timezone);
        const now = clock();
        if (targetAt.getTime() <= now.getTime()) {
          return reply({
            text: `That time has already passed in your timezone. What future date and time should I remind you about "${intent.title}"?`,
            outcome: "clarification",
            changed: false,
          });
        }
        const remindAt = new Date(Math.max(targetAt.getTime() - 30 * 60_000, now.getTime()));
        const display = (value: Date) =>
          new Intl.DateTimeFormat("en-US", {
            timeZone: timezone,
            hour: "numeric",
            minute: "2-digit",
          }).format(value);
        const notifyWhen = remindAt.getTime() <= now.getTime() + 60_000 ? "now" : display(remindAt);
        await services.reminders.create(principal, {
          message: `Time to "${intent.title}" (scheduled for ${display(targetAt)}).`,
          at: remindAt,
          kind: "custom",
        });
        return reply({
          text: `Got it. I'll remind you in Discord ${notifyWhen === "now" ? "now" : `at ${notifyWhen}`}, before ${display(targetAt)}, to ${intent.title}.`,
          outcome: "created",
          changed: true,
        });
      }

      case "recategorize":
        return recategorize(principal, userText, intent, state, openTasks, notes);

      case "cancel_event":
      case "acknowledge_event": {
        const last = state.lastReminder;
        const today = dateKeyOf(clock(), timezone);
        const eventRows = await services.events.list(principal, {
          from: localWallToUtc(intent.date ?? addDays(today, -1), 0, timezone),
          to: localWallToUtc(
            intent.date ? addDays(intent.date, 1) : addDays(today, 60),
            0,
            timezone,
          ),
          limit: 500,
        });
        const rows = intent.startTime
          ? eventRows.filter((event) => {
              const { hour, minute } = localParts(event.startsAt, timezone);
              return hour * 60 + minute === parseTimeOfDay(intent.startTime!);
            })
          : eventRows;
        let found = resolveReference(intent.reference, rows, {
          listed:
            last?.subjectType === "event"
              ? rows.filter((event) => event.id === last.subjectId)
              : state.listed.flatMap((item) => rows.filter((event) => event.id === item.id)),
        });
        if (!intent.reference.trim() && (intent.date || intent.startTime) && rows.length) {
          found =
            rows.length === 1 ? { kind: "one", item: rows[0]! } : { kind: "many", items: rows };
        }
        if (found.kind === "many") {
          const matches = found.items;
          const reminded = matches.find((event) => event.id === last?.subjectId);
          if (
            intent.kind === "cancel_event" &&
            intent.scope === "series" &&
            matches[0]?.seriesId &&
            matches.every((event) => event.seriesId === matches[0]!.seriesId)
          ) {
            found = { kind: "one", item: matches[0] };
          } else if (reminded && !intent.date) {
            found = { kind: "one", item: reminded };
          }
        }
        if (found.kind === "many") {
          return clarify(
            found.items.map((event) => ({
              ...event,
              title: `${event.title.slice(0, 240)} (${dayWord(event.startsAt)}, ${clockLabel(event.startsAt)})`,
            })),
          );
        }
        if (found.kind === "none")
          return reply({
            text: "Which event do you mean? I haven't changed any tasks or events.",
            outcome: "clarification",
            changed: false,
          });
        if (intent.kind === "cancel_event") {
          return proposeCancellation(principal, userText, state, found.item.id, intent.scope);
        }
        const result = await services.events.acknowledge(principal, found.item.id);
        return reply(
          {
            text: `Got it, I stopped the remaining check-ins for "${result.event.title}". The event stays on your calendar and in your history; I haven't canceled it or completed any task.`,
            outcome: "completed",
            changed: result.changed,
          },
          { lastReminder: null, listed: [] },
        );
      }

      case "update_task":
      case "reopen_task": {
        const rows =
          intent.kind === "reopen_task"
            ? await services.tasks.list(principal, { status: "completed", limit: POOL_LIMIT })
            : openTasks;
        const found = resolveReference(intent.reference, rows, {
          listed: state.listed.flatMap((item) => {
            const row = rows.find((row) => row.id === item.id);
            return row ? [row] : [];
          }),
        });
        if (found.kind === "many") return clarify(found.items);
        if (found.kind === "none")
          return reply({
            text: "Which task or to-do do you want to change? Nothing was changed.",
            outcome: "clarification",
            changed: false,
          });
        const result =
          intent.kind === "reopen_task"
            ? await services.tasks.reopen(principal, found.item.id)
            : await services.tasks.update(principal, found.item.id, {
                expectedVersion: found.item.version,
                ...(intent.title ? { title: intent.title } : {}),
                ...(intent.taskType || intent.dueDate || intent.estimatedMinutes
                  ? { taskType: intent.taskType ?? "task" }
                  : {}),
                ...(intent.priority ? { priority: intent.priority } : {}),
                ...(intent.estimatedMinutes ? { estimatedMinutes: intent.estimatedMinutes } : {}),
                ...(intent.dueDate ? dueFields(intent.dueDate, intent.dueTime) : {}),
              });
        return reply({
          text: result.changed
            ? `I ${intent.kind === "reopen_task" ? "reopened" : "updated"} "${result.task.title}" (${result.task.taskType === "todo" ? "to-do" : `${result.task.priority}, ${dueText(result.task, timezone)}`}).`
            : `"${result.task.title}" was already up to date.`,
          outcome: "completed",
          changed: result.changed,
        });
      }

      case "complete_task": {
        const pool = openTasks.map((task) => ({ id: task.id, title: task.title }));
        const last = state.lastReminder;
        // A provider-selected ID is not evidence that a different record was requested.
        const listed = last?.subjectType === "event" ? [] : state.listed;
        const foundEvent =
          last?.subjectType === "event"
            ? resolveReference(
                intent.reference,
                [{ id: last.subjectId ?? "", title: last.title }],
                {
                  listed: [{ id: last.subjectId ?? "", title: last.title }],
                },
              )
            : null;
        if (foundEvent?.kind === "one")
          return reply({
            text: `Do you mean you've arrived at or finished "${last!.title}"? That's an event, not a task. I haven't checked off any task. I can stop its remaining check-ins without canceling the event.`,
            outcome: "clarification",
            changed: false,
          });
        const found = resolveReference(intent.reference, pool, {
          listed: listed.map(({ id, title }) => ({ id, title })),
        });
        if (found.kind === "none") {
          return reply({
            text: `I couldn't find an open task matching "${intent.reference}". Nothing was changed.`,
            outcome: "not_found",
            changed: false,
          });
        }
        if (found.kind === "many") return clarify(found.items);
        if (
          last?.subjectType === "event" &&
          resolveReference(intent.reference, [{ id: "message", title: userText }]).kind !== "one"
        ) {
          return reply({
            text: `Your latest reminder was for the event "${last.title}". Which event or task do you mean? Nothing was changed.`,
            outcome: "clarification",
            changed: false,
          });
        }
        const { task, changed } = await services.tasks.complete(principal, found.item.id);
        let extra = "";
        if (changed) {
          const cleared = await clearPlannedBlocks(principal, task.id);
          if (cleared > 0) {
            extra += ` I also cleared ${cleared} planned work ${cleared === 1 ? "block" : "blocks"} for it; the task and its deadline stay in your history.`;
          }
          if (finishedEarly(task)) {
            extra +=
              " You're well ahead of the deadline, so you've earned some time. Want to use it for catch-up work, a workout, or a break?";
          }
        }
        return reply(
          {
            text: changed
              ? `Nice, I marked "${task.title}" as done.${extra}`
              : `"${task.title}" was already marked done, so there was nothing to change.`,
            outcome: "completed",
            changed,
          },
          changed
            ? {
                lastChange: { kind: "completed", taskId: task.id, title: task.title },
                lastReminder: null,
                listed: [],
              }
            : {},
        );
      }

      case "setup_workspace": {
        authorize(principal, "workspace.setup", { intent: "explicit" });
        if (!workspace) {
          return reply({
            text: "I can only set up the Discord workspace from Discord. Message me there, ask again, and I'll take care of it.",
            outcome: "unavailable",
            changed: false,
          });
        }
        return reply(workspaceReply(await workspace.setup(principal, intent.server)));
      }

      case "delete_note": {
        const pool = notes.map((note) => ({ id: note.id, title: noteTitle(note) }));
        const found = resolveReference(intent.reference, pool, {
          ...(intent.targetId ? { targetId: intent.targetId } : {}),
        });
        if (found.kind === "none") {
          return reply({
            text: `I couldn't find a note matching "${intent.reference}". Nothing was changed.`,
            outcome: "not_found",
            changed: false,
          });
        }
        if (found.kind === "many") return clarify(found.items);
        const proposal = await services.confirmations.propose(principal, {
          action: "note.delete",
          payload: { noteId: found.item.id },
        });
        const summary = String(proposal.preview.summary ?? "Delete this note");
        return reply(
          {
            text: `${summary}. This can't be undone. Reply "yes" within 10 minutes to confirm, or "no" to cancel.`,
            outcome: "confirmation_needed",
            changed: false,
          },
          {
            pending: {
              confirmationId: proposal.confirmationId,
              payloadHash: proposal.payloadHash,
              summary,
              expiresAt: proposal.expiresAt.toISOString(),
            },
          },
        );
      }

      case "confirm": {
        if (state.pendingCapture) {
          const pending = state.pendingCapture;
          const cleared = { ...state, pendingCapture: null };
          if (
            pending.ownerId !== principal.ownerId ||
            !Number.isFinite(Date.parse(pending.expiresAt)) ||
            Date.parse(pending.expiresAt) <= clock().getTime()
          ) {
            return finish(cleared, userText, {
              text: "That import preview expired or belongs to another conversation. Nothing was saved. Send the list again for a fresh preview.",
              outcome: "failed",
              changed: false,
            });
          }
          const [currentTasks, currentNotes] = await Promise.all([
            services.tasks.list(principal, { status: "open", limit: POOL_LIMIT }),
            services.notes.list(principal, { limit: POOL_LIMIT }),
          ]);
          return capture(
            principal,
            userText,
            pending.items,
            pending.omitted,
            cleared,
            currentTasks,
            currentNotes,
            pending.sourceRef,
            pending.sourceText,
          );
        }
        const pending = state.pending;
        if (!pending && !state.pendingMemory && state.pendingSetting) {
          const { key, valueJson, summary } = state.pendingSetting;
          await services.preferences.set(principal, {
            key,
            value: JSON.parse(valueJson),
            status: "confirmed",
          });
          return reply(
            { text: `Done, ${summary}.`, outcome: "created", changed: true },
            { pendingSetting: null },
          );
        }
        if (!pending && !state.pendingMemory && state.pendingPlan) {
          return confirmPlan(principal, userText, state, state.pendingPlan);
        }
        if (!pending && state.pendingMemory) {
          const { key, text } = state.pendingMemory;
          await services.preferences.set(principal, { key, value: { text }, status: "confirmed" });
          return reply(
            { text: `Got it, I'll remember that: ${text}`, outcome: "created", changed: true },
            { pendingMemory: null },
          );
        }
        if (!pending) {
          return reply({
            text: "There's nothing waiting for your confirmation.",
            outcome: "answered",
            changed: false,
          });
        }
        let outcome: { result: Record<string, unknown> };
        try {
          outcome = await services.confirmations.confirm(principal, {
            confirmationId: pending.confirmationId,
            payloadHash: pending.payloadHash,
          });
        } catch (error) {
          if (!(error instanceof ConfirmationError)) throw error;
          const text =
            error.failure === "expired"
              ? "That confirmation expired, so nothing was changed. Ask me again if you still want it."
              : `Nothing was changed. ${error.message}`;
          return reply({ text, outcome: "failed", changed: false }, { pending: null });
        }
        const gone = outcome.result;
        return reply(
          {
            text:
              gone.canceled === "events"
                ? `Done. I canceled ${gone.count} event occurrence${gone.count === 1 ? "" : "s"}. They stay in history, and remaining reminders stop.`
                : gone.cleared
                  ? "Done. I've forgotten what I learned about how long things take. Estimates go back to what you set."
                  : gone.deleted === "preference"
                    ? "Done. I've forgotten that."
                    : "Done. The note is deleted.",
            outcome: gone.canceled ? "completed" : "deleted",
            changed: true,
          },
          { pending: null },
        );
      }

      case "decline": {
        if (state.pendingCapture) {
          return reply(
            {
              text: "Okay, I discarded that preview. Nothing was saved.",
              outcome: "declined",
              changed: false,
            },
            { pendingCapture: null },
          );
        }
        if (state.pendingSetting || state.pendingPlan) {
          return reply(
            {
              text: "Okay, I won't do that. Nothing was changed.",
              outcome: "declined",
              changed: false,
            },
            { pendingSetting: null, pendingPlan: null },
          );
        }
        if (state.pendingMemory) {
          return reply(
            {
              text: "Okay, I won't remember that. It stays unconfirmed and I won't use it.",
              outcome: "declined",
              changed: false,
            },
            { pendingMemory: null },
          );
        }
        if (state.pending) {
          await services.confirmations.cancel(principal, state.pending.confirmationId);
          return reply(
            {
              text: "Okay, I won't do that. Nothing was changed.",
              outcome: "declined",
              changed: false,
            },
            { pending: null },
          );
        }
        return reply({ text: "Okay.", outcome: "answered", changed: false });
      }
    }
  }
}

export type Assistant = ReturnType<typeof createAssistant>;
