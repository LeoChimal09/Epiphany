import { and, asc, desc, eq, gt, isNull, lt, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import {
  cancelEvent,
  completeTask,
  createCategory,
  createEvent,
  createNote,
  createTask,
  createWorkBlock,
  getEvent,
  getTask,
  getWorkBlock,
  InvalidChangeError,
  newId,
  removeWorkBlock,
  VersionConflictError,
} from "../db/domain";
import { listCategories, reopenTask, updateNote, updateTask } from "../db/edits";
import {
  actionHistory,
  events,
  notes,
  preferences,
  tasks,
  workBlocks,
  type ActionHistoryEntry,
  type CalendarEvent,
  type Category,
  type Note,
  type Preference,
  type Task,
  type WorkBlock,
} from "../db/schema";
import { createConfirmationService, type Proposal } from "./confirmations";
import {
  createEventInput,
  createNoteInput,
  createTaskInput,
  createWorkBlockInput,
  idInput,
  listNotesInput,
  listRangeInput,
  listTasksInput,
  parseInput,
  reasonInput,
  updateNoteInput,
  updateTaskInput,
} from "./schemas";
import { authorize, type ActionName, type DecisionContext } from "./permissions";
import { ValidationError } from "./errors";
import { assertPrincipal } from "./principal";
import { z } from "zod";

export {
  AccessDeniedError,
  ConfirmationError,
  ConfirmationRequiredError,
  ValidationError,
} from "./errors";
export { ACTIONS, authorize, decide, type ActionName, type Decision } from "./permissions";
export {
  assertPrincipal,
  isPrincipal,
  issueOwnerPrincipal,
  resolveDiscordPrincipal,
  type Audience,
  type Initiator,
  type Principal,
} from "./principal";
export { CONFIRMATION_TTL_MS, type Proposal } from "./confirmations";
export { VersionConflictError } from "../db/domain";

export interface ServiceOptions {
  clock?: () => Date;
}

// The single path for reading and changing personal records. Every method: verifies the caller
// is an authenticated owner principal, checks the permission matrix, validates the input, calls
// the domain operation, and returns the persisted row re-read from MySQL.
export function createServices(db: Database, options: ServiceOptions = {}) {
  const clock = options.clock ?? (() => new Date());
  const confirmations = createConfirmationService(db, clock);

  // Domain rules that depend on the record's current state surface as ordinary invalid input.
  async function asInput<T>(operation: () => Promise<T>): Promise<T> {
    try {
      return await operation();
    } catch (error) {
      if (error instanceof InvalidChangeError) throw new ValidationError([error.message]);
      throw error;
    }
  }

  // Verifies the caller is an authenticated owner and that the permission matrix allows the
  // action right now. Returns the narrowed principal and the actor for domain operations.
  function gate(principal: unknown, action: ActionName, context?: DecisionContext) {
    assertPrincipal(principal);
    authorize(principal, action, context);
    return {
      principal,
      actor: { ownerId: principal.ownerId, source: principal.source, now: clock() },
    };
  }

  return {
    confirmations,

    preferences: {
      async list(principal: unknown): Promise<Preference[]> {
        const { principal: p } = gate(principal, "preference.read");
        return db
          .select()
          .from(preferences)
          .where(eq(preferences.ownerId, p.ownerId))
          .orderBy(asc(preferences.key));
      },
      async get(principal: unknown, key: unknown): Promise<Preference | null> {
        const { principal: p } = gate(principal, "preference.read");
        if (typeof key !== "string" || key.trim() === "") {
          throw new ValidationError(["preference key must not be empty"]);
        }
        const [preference] = await db
          .select()
          .from(preferences)
          .where(and(eq(preferences.ownerId, p.ownerId), eq(preferences.key, key.trim())));
        return preference ?? null;
      },
      async set(
        principal: unknown,
        input: {
          key: unknown;
          value: unknown;
          status?: "proposed" | "confirmed";
          expectedVersion?: unknown;
        },
      ): Promise<Preference> {
        const { principal: p, actor } = gate(principal, "preference.write");
        if (typeof input.key !== "string" || !/^[^\s].{0,98}\S$|^[^\s]$/.test(input.key)) {
          throw new ValidationError(["preference key must be 1 to 100 non-whitespace characters"]);
        }
        if (input.value === undefined) throw new ValidationError(["preference value is required"]);
        const status = input.status ?? "proposed";
        const expectedVersion = input.expectedVersion;
        if (
          expectedVersion !== undefined &&
          (!Number.isInteger(expectedVersion) || (expectedVersion as number) < 1)
        ) {
          throw new ValidationError(["expectedVersion must be a positive integer"]);
        }
        try {
          JSON.stringify(input.value);
        } catch {
          throw new ValidationError(["preference value must be JSON-serializable"]);
        }

        const key = input.key.trim();
        await db.transaction(async (tx) => {
          const [current] = await tx
            .select()
            .from(preferences)
            .where(and(eq(preferences.ownerId, p.ownerId), eq(preferences.key, key)))
            .for("update");
          if (current && expectedVersion !== undefined && current.version !== expectedVersion) {
            throw new VersionConflictError("Preference", current.version);
          }
          if (current) {
            await tx
              .update(preferences)
              .set({
                value: input.value,
                status,
                source: actor.source,
                version: current.version + 1,
              })
              .where(eq(preferences.id, current.id));
            await tx.insert(actionHistory).values({
              id: newId(),
              ownerId: p.ownerId,
              source: actor.source,
              action: "preference.update",
              entityType: "preference",
              entityId: current.id,
              before: { version: current.version, status: current.status },
              after: { version: current.version + 1, status },
              createdAt: actor.now ?? new Date(),
            });
          } else {
            const id = newId();
            await tx.insert(preferences).values({
              id,
              ownerId: p.ownerId,
              key,
              value: input.value,
              status,
              source: actor.source,
            });
            await tx.insert(actionHistory).values({
              id: newId(),
              ownerId: p.ownerId,
              source: actor.source,
              action: "preference.create",
              entityType: "preference",
              entityId: id,
              after: { key, status },
              createdAt: actor.now ?? new Date(),
            });
          }
        });

        const [saved] = await db
          .select()
          .from(preferences)
          .where(and(eq(preferences.ownerId, p.ownerId), eq(preferences.key, key)));
        if (!saved) throw new Error("Preference was not persisted.");
        return saved;
      },
      async proposeForget(principal: unknown, key: unknown): Promise<Proposal> {
        if (typeof key !== "string" || key.trim() === "") {
          throw new ValidationError(["preference key must not be empty"]);
        }
        return confirmations.propose(principal, {
          action: "preference.delete",
          payload: { key: key.trim() },
        });
      },
    },

    tasks: {
      async list(principal: unknown, input?: unknown): Promise<Task[]> {
        const { principal: p } = gate(principal, "task.read");
        const query = parseInput(listTasksInput, input);
        const filters = [eq(tasks.ownerId, p.ownerId)];
        if (query.status !== "all") filters.push(eq(tasks.status, query.status));
        if (query.categoryId) filters.push(eq(tasks.categoryId, query.categoryId));
        if (!query.includeArchived) filters.push(isNull(tasks.archivedAt));
        // Completed work: most recently finished first. Otherwise soonest deadline first, with
        // tasks that have no deadline last (MySQL would sort them first), so a page limit never
        // hides urgent work behind undated tasks.
        const order =
          query.status === "completed"
            ? [desc(tasks.completedAt), desc(tasks.createdAt)]
            : [sql`${tasks.dueAt} IS NULL`, tasks.dueAt, tasks.createdAt];
        return db
          .select()
          .from(tasks)
          .where(and(...filters))
          .orderBy(...order)
          .limit(query.limit)
          .offset(query.offset);
      },
      async get(principal: unknown, taskId: unknown): Promise<Task> {
        const { principal: p } = gate(principal, "task.read");
        return getTask(db, p.ownerId, parseInput(idInput, taskId));
      },
      async create(principal: unknown, input: unknown): Promise<Task> {
        const { actor } = gate(principal, "task.create");
        return createTask(db, actor, parseInput(createTaskInput, input));
      },
      async complete(principal: unknown, taskId: unknown) {
        const { actor } = gate(principal, "task.complete");
        return completeTask(db, actor, parseInput(idInput, taskId));
      },
      // Edits title, details, deadline, estimate, or category. Pass expectedVersion (the task's
      // `version` when it was loaded) to refuse a stale edit with VersionConflictError.
      async update(principal: unknown, taskId: unknown, input: unknown) {
        const { actor } = gate(principal, "task.update");
        const { expectedVersion, ...patch } = parseInput(updateTaskInput, input);
        return asInput(() =>
          updateTask(db, actor, parseInput(idInput, taskId), patch, expectedVersion),
        );
      },
      async reopen(principal: unknown, taskId: unknown) {
        const { actor } = gate(principal, "task.reopen");
        return reopenTask(db, actor, parseInput(idInput, taskId));
      },
    },

    notes: {
      async list(principal: unknown, input?: unknown): Promise<Note[]> {
        const { principal: p } = gate(principal, "note.read");
        const query = parseInput(listNotesInput, input);
        const filters = [eq(notes.ownerId, p.ownerId), isNull(notes.archivedAt)];
        if (query.categoryId) filters.push(eq(notes.categoryId, query.categoryId));
        if (query.kind) filters.push(eq(notes.kind, query.kind));
        return db
          .select()
          .from(notes)
          .where(and(...filters))
          .orderBy(desc(notes.createdAt))
          .limit(query.limit)
          .offset(query.offset);
      },
      async create(principal: unknown, input: unknown): Promise<Note> {
        const { actor } = gate(principal, "note.create");
        return createNote(db, actor, parseInput(createNoteInput, input));
      },
      async update(principal: unknown, noteId: unknown, input: unknown) {
        const { actor } = gate(principal, "note.update");
        const { expectedVersion, ...patch } = parseInput(updateNoteInput, input);
        return updateNote(db, actor, parseInput(idInput, noteId), patch, expectedVersion);
      },
    },

    categories: {
      // The owner's categories, Inbox first. Items without a category are in the Inbox.
      async list(principal: unknown): Promise<Category[]> {
        const { principal: p } = gate(principal, "category.read");
        return listCategories(db, p.ownerId);
      },
      async create(principal: unknown, name: unknown): Promise<Category> {
        const { actor } = gate(principal, "category.create");
        return createCategory(db, actor, parseInput(z.string().trim().min(1).max(100), name));
      },
    },

    events: {
      // Events overlapping [from, to), earliest first. Canceled events only with includeInactive.
      async list(principal: unknown, input: unknown): Promise<CalendarEvent[]> {
        const { principal: p } = gate(principal, "event.read");
        const query = parseInput(listRangeInput, input);
        const filters = [
          eq(events.ownerId, p.ownerId),
          lt(events.startsAt, query.to),
          gt(events.endsAt, query.from),
        ];
        if (!query.includeInactive) filters.push(eq(events.status, "scheduled"));
        return db
          .select()
          .from(events)
          .where(and(...filters))
          .orderBy(asc(events.startsAt), asc(events.id))
          .limit(query.limit);
      },
      async get(principal: unknown, eventId: unknown): Promise<CalendarEvent> {
        const { principal: p } = gate(principal, "event.read");
        return getEvent(db, p.ownerId, parseInput(idInput, eventId));
      },
      async create(principal: unknown, input: unknown): Promise<CalendarEvent> {
        const { actor } = gate(principal, "event.create");
        return createEvent(db, actor, parseInput(createEventInput, input));
      },
      // Events are not synced to an external calendar yet, so cancellation applies directly.
      // When external references exist, pass external: true to route this through confirmation.
      async cancel(principal: unknown, eventId: unknown, context: DecisionContext = {}) {
        const { actor } = gate(principal, "event.cancel", context);
        return cancelEvent(db, actor, parseInput(idInput, eventId));
      },
    },

    workBlocks: {
      // Blocks overlapping [from, to), earliest first. Completed and removed blocks only with
      // includeInactive.
      async list(principal: unknown, input: unknown): Promise<WorkBlock[]> {
        const { principal: p } = gate(principal, "work_block.read");
        const query = parseInput(listRangeInput, input);
        const filters = [
          eq(workBlocks.ownerId, p.ownerId),
          lt(workBlocks.startsAt, query.to),
          gt(workBlocks.endsAt, query.from),
        ];
        if (!query.includeInactive) filters.push(eq(workBlocks.status, "planned"));
        return db
          .select()
          .from(workBlocks)
          .where(and(...filters))
          .orderBy(asc(workBlocks.startsAt), asc(workBlocks.id))
          .limit(query.limit);
      },
      async get(principal: unknown, blockId: unknown): Promise<WorkBlock> {
        const { principal: p } = gate(principal, "work_block.read");
        return getWorkBlock(db, p.ownerId, parseInput(idInput, blockId));
      },
      async create(
        principal: unknown,
        input: unknown,
        context: DecisionContext = {},
      ): Promise<WorkBlock> {
        const { actor } = gate(principal, "work_block.create", context);
        return createWorkBlock(db, actor, parseInput(createWorkBlockInput, input));
      },
      async remove(
        principal: unknown,
        blockId: unknown,
        reason: unknown = "manual",
        context: DecisionContext = {},
      ) {
        const { actor } = gate(principal, "work_block.remove", context);
        return removeWorkBlock(
          db,
          actor,
          parseInput(idInput, blockId),
          parseInput(reasonInput, reason),
        );
      },
    },

    history: {
      async list(principal: unknown, limit: unknown = 50): Promise<ActionHistoryEntry[]> {
        const { principal: p } = gate(principal, "history.read");
        const max = parseInput(z.number().int().min(1).max(200), limit);
        return db
          .select()
          .from(actionHistory)
          .where(eq(actionHistory.ownerId, p.ownerId))
          .orderBy(desc(actionHistory.createdAt))
          .limit(max);
      },
    },
  };
}

export type Services = ReturnType<typeof createServices>;
