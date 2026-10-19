import {
  ConfirmationError,
  ValidationError,
  assertPrincipal,
  type Principal,
  type Services,
} from "../services";
import { dateKeyOf, localWallToUtc, parseTimeOfDay, type DateKey } from "../planning/time";
import type { Budget } from "./budget";
import type { Intent } from "./intent";
import { resolveReference, type Candidate } from "./matching";
import { ProviderUnavailableError } from "./provider";
import type {
  InterpretRequest,
  NoteContext,
  OpenTaskContext,
  TextProvider,
  Turn,
} from "./provider";
import type { Note, Task } from "../db/schema";

const MAX_MESSAGE_LENGTH = 2000;
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
export interface ConversationState {
  turns: Turn[];
  listed: OpenTaskContext[];
  pending: PendingAction | null;
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
  | "unavailable"
  | "denied";

export interface AssistantReply {
  text: string;
  outcome: Outcome;
  // True only when a record was actually persisted by this message.
  changed: boolean;
}

export interface AssistantOptions {
  services: Services;
  provider: TextProvider;
  budget: Budget;
  // The owner's timezone; the model only ever reasons in local dates and times.
  timezone: string;
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
});

const noteTitle = (note: Note) => note.title?.trim() || note.body.trim().slice(0, 60);

function numbered(items: string[]): string {
  return items.map((line, index) => `${index + 1}. ${line}`).join("\n");
}

export function createAssistant(options: AssistantOptions) {
  const { services, provider, budget, timezone } = options;
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
    return { reply, state: { ...state, ...patch, turns } };
  }

  return {
    // One owner message in, one reply out. The reply is built from what was persisted, never
    // from the model's claim, so a failed change is reported as a failure.
    async handle(
      principal: unknown,
      message: string,
      state: ConversationState = emptyConversation(),
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

      const status = await budget.check();
      if (!status.allowed) {
        return finish(state, userText, {
          text: "I've reached this month's AI limit, so I can't interpret free-form messages until it resets on the 1st. Nothing was changed, and the dashboard works as usual.",
          outcome: "unavailable",
          changed: false,
        });
      }

      let openTasks: Task[];
      let notes: Note[];
      try {
        [openTasks, notes] = await Promise.all([
          services.tasks.list(principal, { status: "open", limit: POOL_LIMIT }),
          services.notes.list(principal, { limit: POOL_LIMIT }),
        ]);
      } catch (error) {
        if (error instanceof ProviderUnavailableError) {
          console.error(
            JSON.stringify({
              service: "assistant",
              event: "provider_unavailable",
              message: error.message,
              retryable: error.retryable,
            }),
          );
        }
        return finish(state, userText, {
          text: "I couldn't load your records just now, so I didn't do anything. Please try again.",
          outcome: "failed",
          changed: false,
        });
      }

      const now = clock();
      const today = dateKeyOf(now, timezone);
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
          .map((note): NoteContext => ({ id: note.id, title: noteTitle(note) })),
        lastListed: state.listed,
        history: state.turns,
        pending: state.pending?.summary ?? null,
      };

      let intent: Intent;
      try {
        const result = await provider.interpret(request);
        await budget.record(result.costUsd);
        intent = result.intent;
      } catch {
        return finish(state, userText, {
          text: "I can't interpret messages right now, so I didn't do anything. The dashboard still works, and you can try again in a moment.",
          outcome: "unavailable",
          changed: false,
        });
      }

      // A pending confirmation only survives an immediate yes or no.
      const base: ConversationState =
        intent.kind === "confirm" || intent.kind === "decline"
          ? state
          : { ...state, pending: null };

      try {
        return await dispatch(principal, userText, intent, base, openTasks, notes);
      } catch (error) {
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
    },
  };

  async function dispatch(
    principal: Principal,
    userText: string,
    intent: Intent,
    state: ConversationState,
    openTasks: Task[],
    notes: Note[],
  ) {
    const reply = (value: AssistantReply, patch?: Partial<ConversationState>) =>
      finish(state, userText, value, patch);

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
      case "respond":
        return reply({ text: intent.text, outcome: "answered", changed: false });

      case "clarify":
        return reply({ text: intent.question, outcome: "clarification", changed: false });

      case "list_tasks": {
        const rows = await services.tasks.list(principal, {
          status: intent.status,
          limit: POOL_LIMIT,
        });
        const query = intent.search?.toLowerCase();
        const matched = rows.filter((task) => {
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
        if (matched.length === 0) {
          return reply(
            {
              text: label ? `No ${label} tasks match that.` : "No tasks match that.",
              outcome: "listed",
              changed: false,
            },
            { listed: [] },
          );
        }
        const shown = matched.slice(0, LIST_LINES);
        const more = matched.length - shown.length;
        const lines = shown.map((task) => `${task.title} (${dueText(task, timezone)})`);
        const text = `${label ? `${label[0]!.toUpperCase()}${label.slice(1)}` : "Matching"} tasks (${matched.length}):\n${numbered(lines)}${more > 0 ? `\n...and ${more} more.` : ""}`;
        return reply(
          { text, outcome: "listed", changed: false },
          { listed: shown.map((task) => taskContext(task, timezone)) },
        );
      }

      case "create_task": {
        let dueAt: Date | undefined;
        let dueDateOnly: boolean | undefined;
        if (intent.dueDate) {
          if (intent.dueTime) {
            dueAt = localWallToUtc(intent.dueDate, parseTimeOfDay(intent.dueTime), timezone);
            dueDateOnly = false;
          } else {
            dueAt = new Date(`${intent.dueDate}T00:00:00.000Z`);
            dueDateOnly = true;
          }
        }
        const task = await services.tasks.create(principal, {
          title: intent.title,
          details: intent.details,
          dueAt,
          dueDateOnly,
          estimatedMinutes: intent.estimatedMinutes,
        });
        const effort = task.estimatedMinutes ? `, about ${task.estimatedMinutes} min` : "";
        return reply({
          text: `Added "${task.title}" (${dueText(task, timezone)}${effort}).`,
          outcome: "created",
          changed: true,
        });
      }

      case "create_note": {
        const note = await services.notes.create(principal, {
          title: intent.title,
          body: intent.body,
          kind: intent.noteKind,
        });
        return reply({
          text: `Saved ${note.kind} "${noteTitle(note)}".`,
          outcome: "created",
          changed: true,
        });
      }

      case "complete_task": {
        const pool = openTasks.map((task) => ({ id: task.id, title: task.title }));
        const found = resolveReference(intent.reference, pool, {
          listed: state.listed.map(({ id, title }) => ({ id, title })),
          ...(intent.targetId ? { targetId: intent.targetId } : {}),
        });
        if (found.kind === "none") {
          return reply({
            text: `I couldn't find an open task matching "${intent.reference}". Nothing was changed.`,
            outcome: "not_found",
            changed: false,
          });
        }
        if (found.kind === "many") return clarify(found.items);
        const { task, changed } = await services.tasks.complete(principal, found.item.id);
        return reply({
          text: changed ? `Marked "${task.title}" as done.` : `"${task.title}" was already done.`,
          outcome: "completed",
          changed,
        });
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
        const pending = state.pending;
        if (!pending) {
          return reply({
            text: "There's nothing waiting for your confirmation.",
            outcome: "answered",
            changed: false,
          });
        }
        try {
          await services.confirmations.confirm(principal, {
            confirmationId: pending.confirmationId,
            payloadHash: pending.payloadHash,
          });
        } catch (error) {
          if (!(error instanceof ConfirmationError)) throw error;
          const text =
            error.failure === "expired"
              ? "That confirmation expired, so nothing was deleted. Ask me again if you still want it."
              : `Nothing was deleted. ${error.message}`;
          return reply({ text, outcome: "failed", changed: false }, { pending: null });
        }
        return reply(
          { text: "Done. The note is deleted.", outcome: "deleted", changed: true },
          { pending: null },
        );
      }

      case "decline": {
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
