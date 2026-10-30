import { and, asc, desc, eq, gt, gte, inArray, isNull, lt, notInArray, sql } from "drizzle-orm";
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
  NotFoundError,
  removeWorkBlock,
  VersionConflictError,
} from "../db/domain";
import { listCategories, reopenTask, updateNote, updateTask } from "../db/edits";
import {
  actionHistory,
  discordOverviews,
  events,
  reminders,
  notes,
  owners,
  preferences,
  tasks,
  workBlocks,
  type ActionHistoryEntry,
  type CalendarEvent,
  type Category,
  type Note,
  type Preference,
  type Reminder,
  type Task,
  type WorkBlock,
} from "../db/schema";
import { createConfirmationService, type Proposal } from "./confirmations";
import {
  createEventInput,
  createEventSeriesInput,
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
import { AccessDeniedError, ValidationError } from "./errors";
import { discordAvatarUrl, type OwnerProfile } from "./profile";
import { recentReminders, scheduleReminder, snoozeReminder } from "../reminders/store";
import { createHash } from "node:crypto";
import { listObservations, recordObservation } from "../insights/store";
import type { Observation } from "../insights/insights";
import {
  oneOffReminderInput,
  overviewBindingInput,
  overviewKeyInput,
  type OverviewBinding,
} from "./schemas";
import { assertPrincipal } from "./principal";
import { createCalendarService, type CalendarServiceOptions } from "./calendar";
import { z } from "zod";
import { createEventSeries } from "./event-series";

export {
  AccessDeniedError,
  ConfirmationError,
  ConfirmationRequiredError,
  ValidationError,
} from "./errors";
export { ACTIONS, authorize, decide, type ActionName, type Decision } from "./permissions";
export { cleanAvatarHash, cleanDisplayName, discordAvatarUrl, type OwnerProfile } from "./profile";
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
export { CalendarError } from "../calendar/store";
export type { CalendarServiceOptions } from "./calendar";

export interface ServiceOptions {
  clock?: () => Date;
  // Present when Google Calendar is configured (token key and OAuth client).
  calendar?: CalendarServiceOptions;
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
      async get(principal: unknown, noteId: unknown): Promise<Note> {
        const { principal: p } = gate(principal, "note.read");
        const id = parseInput(idInput, noteId);
        const [row] = await db
          .select()
          .from(notes)
          .where(and(eq(notes.id, id), eq(notes.ownerId, p.ownerId), isNull(notes.archivedAt)));
        if (!row) throw new NotFoundError("Note");
        return row;
      },
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

    owner: {
      // Who is signed in: the name and avatar Discord reported at the last sign-in.
      async profile(principal: unknown): Promise<OwnerProfile> {
        const { principal: p } = gate(principal, "owner.read");
        const [row] = await db
          .select({
            displayName: owners.displayName,
            discordUserId: owners.discordUserId,
            avatarHash: owners.avatarHash,
          })
          .from(owners)
          .where(eq(owners.id, p.ownerId));
        if (!row) throw new AccessDeniedError("access", "unknown owner");
        return {
          displayName: row.displayName,
          avatarUrl: discordAvatarUrl(row.discordUserId, row.avatarHash),
        };
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
      // Attendance/completion stops check-ins, not the calendar appointment itself.
      async acknowledge(principal: unknown, eventId: unknown) {
        const { principal: p, actor } = gate(principal, "event.acknowledge");
        const id = parseInput(idInput, eventId);
        const changed = await db.transaction(async (tx) => {
          const [event] = await tx
            .select()
            .from(events)
            .where(and(eq(events.id, id), eq(events.ownerId, p.ownerId)))
            .for("update");
          if (!event || event.status !== "scheduled") throw new NotFoundError("Event");
          const [existing] = await tx
            .select()
            .from(actionHistory)
            .where(
              and(
                eq(actionHistory.ownerId, p.ownerId),
                eq(actionHistory.entityId, id),
                eq(actionHistory.action, "event.acknowledge"),
                sql`JSON_EXTRACT(${actionHistory.after}, '$.version') = ${event.version}`,
              ),
            )
            .limit(1);
          if (existing) return false;
          await tx
            .update(reminders)
            .set({
              status: "canceled",
              detail: "event acknowledged",
              version: sql`${reminders.version} + 1`,
            })
            .where(
              and(
                eq(reminders.ownerId, p.ownerId),
                eq(reminders.subjectType, "event"),
                eq(reminders.subjectId, id),
                eq(reminders.status, "scheduled"),
              ),
            );
          await tx.insert(actionHistory).values({
            id: newId(),
            ownerId: p.ownerId,
            source: actor.source,
            action: "event.acknowledge",
            entityType: "event",
            entityId: id,
            after: { version: event.version },
            createdAt: actor.now,
          });
          return true;
        });
        return { event: await getEvent(db, p.ownerId, id), changed };
      },
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
      async createSeries(principal: unknown, input: unknown): Promise<CalendarEvent[]> {
        const { actor } = gate(principal, "event.create");
        return createEventSeries(db, actor, parseInput(createEventSeriesInput, input));
      },
      // Events are not synced to an external calendar yet, so cancellation applies directly.
      // When external references exist, pass external: true to route this through confirmation.
      async cancel(principal: unknown, eventId: unknown, context: DecisionContext = {}) {
        const { actor, principal: p } = gate(principal, "event.cancel", context);
        const id = parseInput(idInput, eventId);
        const event = await getEvent(db, actor.ownerId, id);
        if (event.seriesId) {
          authorize(p, "event.cancel_series");
        }
        return cancelEvent(db, actor, id);
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

    // What the owner chose to report about how they work (durations, snoozes). The assistant only
    // records these when the owner has turned learning on.
    insights: {
      async record(
        principal: unknown,
        input: { kind: "duration" | "snooze"; key: string; value: number },
      ): Promise<void> {
        const { principal: p } = gate(principal, "insight.write");
        const value = parseInput(
          z
            .object({
              kind: z.enum(["duration", "snooze"]),
              key: z.string().trim().min(1).max(191),
              value: z.number().int().min(0).max(100_000),
            })
            .strict(),
          input,
        );
        await recordObservation(db, p.ownerId, value);
      },
      async list(principal: unknown, limit: unknown = 500): Promise<Observation[]> {
        const { principal: p } = gate(principal, "insight.read");
        return listObservations(
          db,
          p.ownerId,
          parseInput(z.number().int().min(1).max(2000), limit),
        );
      },
    },

    reminders: {
      async get(principal: unknown, id: unknown): Promise<Reminder | null> {
        const { principal: p } = gate(principal, "reminder.read");
        const [row] = await db
          .select()
          .from(reminders)
          .where(and(eq(reminders.ownerId, p.ownerId), eq(reminders.id, parseInput(idInput, id))));
        return row ?? null;
      },
      // Upcoming and recent reminder jobs, newest first, including ones that failed or were skipped.
      async recent(principal: unknown, limit: unknown = 20): Promise<Reminder[]> {
        const { principal: p } = gate(principal, "reminder.read");
        return recentReminders(db, p.ownerId, parseInput(z.number().int().min(1).max(100), limit));
      },
      // A one-off reminder the owner asked for, such as a check-in after an activity. Asking twice
      // for the same text at the same minute creates one reminder.
      async create(principal: unknown, input: unknown): Promise<boolean> {
        const { principal: p } = gate(principal, "reminder.create");
        const value = parseInput(oneOffReminderInput, input);
        return scheduleReminder(db, p.ownerId, {
          kind: value.kind,
          dedupeKey: `oneoff:${Math.floor(value.at.getTime() / 60_000)}:${createHash("sha256")
            .update(value.message)
            .digest("hex")
            .slice(0, 16)}`,
          message: value.message,
          dueAt: value.at,
        });
      },
      // Moves a reminder that has not been sent to a later time.
      async snooze(principal: unknown, id: unknown, minutes: unknown): Promise<boolean> {
        const { principal: p } = gate(principal, "reminder.snooze");
        const reminderId = parseInput(idInput, id);
        const wait = parseInput(
          z
            .number()
            .int()
            .min(1)
            .max(7 * 24 * 60),
          minutes,
        );
        return snoozeReminder(
          db,
          p.ownerId,
          reminderId,
          new Date(clock().getTime() + wait * 60_000),
        );
      },
    },

    // Which Discord message shows each overview, kept so it is edited in place and never duplicated.
    overviews: {
      async get(
        principal: unknown,
        guildId: unknown,
        viewKey: unknown,
      ): Promise<OverviewBinding | null> {
        const { principal: p } = gate(principal, "overview.read");
        const key = parseInput(overviewKeyInput, { guildId, viewKey });
        const [row] = await db
          .select()
          .from(discordOverviews)
          .where(
            and(
              eq(discordOverviews.ownerId, p.ownerId),
              eq(discordOverviews.guildId, key.guildId),
              eq(discordOverviews.viewKey, key.viewKey),
            ),
          );
        return row
          ? {
              guildId: row.guildId,
              viewKey: row.viewKey,
              channelId: row.channelId,
              messageId: row.messageId,
              contentHash: row.contentHash,
            }
          : null;
      },
      async save(principal: unknown, binding: unknown): Promise<void> {
        const { principal: p } = gate(principal, "overview.write");
        const value = parseInput(overviewBindingInput, binding);
        await db
          .insert(discordOverviews)
          .values({ ownerId: p.ownerId, ...value })
          .onDuplicateKeyUpdate({
            set: {
              channelId: value.channelId,
              messageId: value.messageId,
              contentHash: value.contentHash,
            },
          });
      },
    },

    calendar: createCalendarService(db, clock, options.calendar),

    history: {
      async changes(
        principal: unknown,
        since: unknown,
        seen: unknown = [],
      ): Promise<ActionHistoryEntry[]> {
        const { principal: p } = gate(principal, "history.read");
        const from = parseInput(
          z.iso.datetime().transform((value) => new Date(value)),
          since,
        );
        const ids = parseInput(z.array(z.uuid()).max(10_000), seen);
        return db
          .select()
          .from(actionHistory)
          .where(
            and(
              eq(actionHistory.ownerId, p.ownerId),
              gte(actionHistory.createdAt, from),
              ...(ids.length ? [notInArray(actionHistory.id, ids)] : []),
              inArray(actionHistory.action, [
                "task.create",
                "task.update",
                "task.complete",
                "task.reopen",
                "event.create",
                "event.cancel",
                "event.acknowledge",
                "note.create",
                "note.update",
                "note.delete",
                "work_block.create",
                "work_block.remove",
              ]),
            ),
          )
          .orderBy(asc(actionHistory.createdAt), asc(actionHistory.id))
          .limit(200);
      },
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
      async additions(principal: unknown): Promise<ActionHistoryEntry[]> {
        const { principal: p } = gate(principal, "history.read");
        return db
          .select()
          .from(actionHistory)
          .where(
            and(
              eq(actionHistory.ownerId, p.ownerId),
              inArray(actionHistory.action, ["task.create", "event.create"]),
            ),
          )
          .orderBy(desc(actionHistory.createdAt))
          .limit(100);
      },
    },
  };
}

export type Services = ReturnType<typeof createServices>;
