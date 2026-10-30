import { createHash } from "node:crypto";
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import type { Database } from "../db/client";
import { newId, NotFoundError, recordAction } from "../db/domain";
import {
  confirmations,
  calendarEventRefs,
  events,
  reminders,
  notes,
  observations,
  preferences,
  type ConfirmationTarget,
} from "../db/schema";
import { AccessDeniedError, ConfirmationError, ValidationError } from "./errors";
import { decide, type ActionName } from "./permissions";
import { assertPrincipal, type Principal } from "./principal";
import type { Tx } from "./types";

export const CONFIRMATION_TTL_MS = 10 * 60 * 1000;

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value instanceof Date ? value.toISOString() : value);
}

export function hashProposal(input: {
  ownerId: string;
  action: string;
  payload: unknown;
  targets: ConfirmationTarget[];
}): string {
  return createHash("sha256").update(canonicalJson(input)).digest("hex");
}

interface Executor<P> {
  schema: z.ZodType<P>;
  // Locks and reads the current targets with their versions.
  targets: (tx: Tx, ownerId: string, payload: P) => Promise<ConfirmationTarget[]>;
  preview: (tx: Tx, ownerId: string, payload: P) => Promise<Record<string, unknown>>;
  execute: (
    tx: Tx,
    principal: Principal,
    payload: P,
    confirmationId: string,
    now: Date,
  ) => Promise<Record<string, unknown>>;
  // Replaces the stored preview once executed so deleted content is not kept in a copy.
  scrub: (preview: Record<string, unknown>) => Record<string, unknown>;
}

const noteDelete: Executor<{ noteId: string }> = {
  schema: z.object({ noteId: z.uuid() }).strict(),
  async targets(tx, ownerId, { noteId }) {
    const [row] = await tx
      .select({ id: notes.id, version: notes.version })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerId, ownerId)))
      .for("update");
    if (!row) throw new NotFoundError("Note");
    return [{ entityType: "note", entityId: row.id, version: row.version }];
  },
  async preview(tx, ownerId, { noteId }) {
    const [row] = await tx
      .select({ kind: notes.kind, title: notes.title, body: notes.body })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerId, ownerId)));
    if (!row) throw new NotFoundError("Note");
    return {
      summary: `Delete the ${row.kind} "${row.title ?? row.body.slice(0, 60)}"`,
      consequences: ["The note is permanently deleted.", "This cannot be undone."],
    };
  },
  async execute(tx, principal, { noteId }, confirmationId) {
    const [row] = await tx
      .select({ kind: notes.kind, categoryId: notes.categoryId })
      .from(notes)
      .where(and(eq(notes.id, noteId), eq(notes.ownerId, principal.ownerId)));
    if (!row) throw new NotFoundError("Note");
    await tx.delete(notes).where(eq(notes.id, noteId));
    // History keeps what happened, not the deleted content.
    await recordAction(tx, principal, {
      action: "note.delete",
      entityType: "note",
      entityId: noteId,
      before: { kind: row.kind, categoryId: row.categoryId },
      after: { confirmationId },
    });
    return { deleted: "note", id: noteId };
  },
  scrub: () => ({ summary: "Deleted note (content removed)" }),
};

const preferenceDelete: Executor<{ key: string }> = {
  schema: z.object({ key: z.string().trim().min(1).max(100) }).strict(),
  async targets(tx, ownerId, { key }) {
    const [row] = await tx
      .select({ id: preferences.id, version: preferences.version })
      .from(preferences)
      .where(and(eq(preferences.ownerId, ownerId), eq(preferences.key, key)))
      .for("update");
    if (!row) throw new NotFoundError("Preference");
    return [{ entityType: "preference", entityId: row.id, version: row.version }];
  },
  async preview(tx, ownerId, { key }) {
    const [row] = await tx
      .select({ status: preferences.status })
      .from(preferences)
      .where(and(eq(preferences.ownerId, ownerId), eq(preferences.key, key)));
    if (!row) throw new NotFoundError("Preference");
    return {
      summary: `Forget the preference "${key}"`,
      consequences: [`The ${row.status} preference will be removed.`],
    };
  },
  async execute(tx, principal, { key }, confirmationId) {
    const [row] = await tx
      .select({ id: preferences.id, status: preferences.status })
      .from(preferences)
      .where(and(eq(preferences.ownerId, principal.ownerId), eq(preferences.key, key)));
    if (!row) throw new NotFoundError("Preference");
    await tx.delete(preferences).where(eq(preferences.id, row.id));
    await recordAction(tx, principal, {
      action: "preference.delete",
      entityType: "preference",
      entityId: row.id,
      before: { key, status: row.status },
      after: { confirmationId },
    });
    return { deleted: "preference", key };
  },
  scrub: (preview) => ({ summary: preview.summary ?? "Forgot preference (value removed)" }),
};

// Forgets everything learned about how the owner works. The target's version is the number of
// observations, so a confirmation given before new ones were recorded no longer matches.
const memoryClear: Executor<{ scope: "observations" }> = {
  schema: z.object({ scope: z.literal("observations") }).strict(),
  async targets(tx, ownerId) {
    const [row] = await tx
      .select({ count: sql<number>`COUNT(*)` })
      .from(observations)
      .where(eq(observations.ownerId, ownerId));
    return [{ entityType: "observations", entityId: ownerId, version: Number(row?.count ?? 0) }];
  },
  async preview(tx, ownerId) {
    const [row] = await tx
      .select({ count: sql<number>`COUNT(*)` })
      .from(observations)
      .where(eq(observations.ownerId, ownerId));
    return {
      summary: `Forget what I've learned about how long things take (${Number(row?.count ?? 0)} reports)`,
      consequences: ["All reports are permanently deleted.", "Estimates go back to what you set."],
    };
  },
  async execute(tx, principal, _payload, confirmationId) {
    await tx.delete(observations).where(eq(observations.ownerId, principal.ownerId));
    await recordAction(tx, principal, {
      action: "memory.clear",
      entityType: "observations",
      entityId: principal.ownerId,
      after: { confirmationId },
    });
    return { cleared: "observations" };
  },
  scrub: () => ({ summary: "Forgot what I'd learned (reports removed)" }),
};

const eventCancellationSchema = z
  .object({
    eventId: z.uuid(),
    scope: z.enum(["occurrence", "series"]),
  })
  .strict();
type EventCancellation = z.infer<typeof eventCancellationSchema>;

async function cancellationEvents(tx: Tx, ownerId: string, payload: EventCancellation) {
  const [event] = await tx
    .select()
    .from(events)
    .where(and(eq(events.id, payload.eventId), eq(events.ownerId, ownerId)))
    .for("update");
  if (!event) throw new NotFoundError("Event");
  if (payload.scope === "series" && !event.seriesId) {
    throw new ValidationError(["This event is not part of a local recurring series."]);
  }
  const rows = await tx
    .select()
    .from(events)
    .where(
      and(
        eq(events.ownerId, ownerId),
        payload.scope === "series" ? eq(events.seriesId, event.seriesId!) : eq(events.id, event.id),
        eq(events.status, "scheduled"),
      ),
    )
    .orderBy(asc(events.id))
    .for("update");
  if (!rows.length) throw new ValidationError(["These events are already canceled."]);
  const external = await tx
    .select({ id: calendarEventRefs.id })
    .from(calendarEventRefs)
    .where(
      and(
        eq(calendarEventRefs.ownerId, ownerId),
        inArray(
          calendarEventRefs.eventId,
          rows.map((row) => row.id),
        ),
        eq(calendarEventRefs.ownership, "external"),
      ),
    )
    .limit(1);
  if (external.length)
    throw new ValidationError(["Cancel externally managed events in their source calendar."]);
  return rows;
}

const eventCancellation: Executor<EventCancellation> = {
  schema: eventCancellationSchema,
  async targets(tx, ownerId, payload) {
    return (await cancellationEvents(tx, ownerId, payload)).map((row) => ({
      entityType: "event",
      entityId: row.id,
      version: row.version,
    }));
  },
  async preview(tx, ownerId, payload) {
    const rows = await cancellationEvents(tx, ownerId, payload);
    const sorted = rows.sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime());
    const first = sorted[0]!;
    const label = (date: Date) =>
      new Intl.DateTimeFormat("en-US", {
        timeZone: first.timezone,
        dateStyle: "medium",
        timeStyle: "short",
      }).format(date);
    return {
      summary:
        payload.scope === "series"
          ? `Cancel all ${rows.length} scheduled occurrences of "${first.title}", ${label(first.startsAt)} through ${label(sorted.at(-1)!.startsAt)} (${first.timezone})`
          : `Cancel only "${first.title}" on ${label(first.startsAt)} (${first.timezone}); other occurrences stay scheduled`,
      consequences: ["Canceled events stay in history. Their remaining reminders stop."],
    };
  },
  async execute(tx, principal, payload, confirmationId, now) {
    const rows = await cancellationEvents(tx, principal.ownerId, payload);
    const ids = rows.map((row) => row.id);
    await tx
      .update(events)
      .set({
        status: "canceled",
        canceledAt: now,
        version: sql`${events.version} + 1`,
      })
      .where(and(eq(events.ownerId, principal.ownerId), inArray(events.id, ids)));
    await tx
      .update(reminders)
      .set({
        status: "canceled",
        detail: "event canceled",
        version: sql`${reminders.version} + 1`,
      })
      .where(
        and(
          eq(reminders.ownerId, principal.ownerId),
          eq(reminders.subjectType, "event"),
          inArray(reminders.subjectId, ids),
          eq(reminders.status, "scheduled"),
        ),
      );
    for (const event of rows) {
      await recordAction(
        tx,
        { ...principal, now },
        {
          action: "event.cancel",
          entityType: "event",
          entityId: event.id,
          before: { status: event.status, seriesId: event.seriesId },
          after: { status: "canceled", scope: payload.scope, confirmationId },
        },
      );
    }
    return { canceled: "events", count: rows.length, scope: payload.scope };
  },
  scrub: (preview) => preview,
};

const EXECUTORS: Partial<Record<ActionName, Executor<never>>> = {
  "event.cancel_series": eventCancellation as unknown as Executor<never>,
  "memory.clear": memoryClear as unknown as Executor<never>,
  "note.delete": noteDelete as unknown as Executor<never>,
  "preference.delete": preferenceDelete as unknown as Executor<never>,
};

function executorFor(action: string): Executor<unknown> {
  const executor = (EXECUTORS as Record<string, Executor<unknown> | undefined>)[action];
  if (!executor) throw new ValidationError([`${action} has no confirmable handler yet`]);
  return executor;
}

export interface Proposal {
  confirmationId: string;
  payloadHash: string;
  preview: Record<string, unknown>;
  expiresAt: Date;
}

export interface ConfirmationOutcome {
  confirmationId: string;
  result: Record<string, unknown>;
}

function sameTargets(a: ConfirmationTarget[], b: ConfirmationTarget[]): boolean {
  return canonicalJson(a) === canonicalJson(b);
}

export function createConfirmationService(db: Database, clock: () => Date = () => new Date()) {
  return {
    async propose(
      principal: unknown,
      input: { action: ActionName; payload: unknown },
    ): Promise<Proposal> {
      assertPrincipal(principal);
      const decision = decide(principal, input.action);
      if (decision.kind === "deny") throw new AccessDeniedError(input.action, decision.reason);
      if (decision.kind !== "confirm") {
        throw new ValidationError([`${input.action} does not use the confirmation flow`]);
      }

      const executor = executorFor(input.action);
      const parsed = executor.schema.safeParse(input.payload);
      if (!parsed.success) {
        throw new ValidationError(
          parsed.error.issues.map((i) => `${i.path.join(".") || "payload"} ${i.message}`),
        );
      }
      const payload = parsed.data as Record<string, unknown>;
      const now = clock();

      return db.transaction(async (tx) => {
        const targets = await executor.targets(tx, principal.ownerId, payload);
        const preview = await executor.preview(tx, principal.ownerId, payload);
        const payloadHash = hashProposal({
          ownerId: principal.ownerId,
          action: input.action,
          payload,
          targets,
        });

        // A new proposal for the same action and payload replaces any older pending one.
        const pending = await tx
          .select()
          .from(confirmations)
          .where(
            and(
              eq(confirmations.ownerId, principal.ownerId),
              eq(confirmations.action, input.action),
              eq(confirmations.status, "pending"),
            ),
          )
          .for("update");
        for (const old of pending) {
          if (canonicalJson(old.payload) === canonicalJson(payload)) {
            await tx
              .update(confirmations)
              .set({ status: "superseded", resolvedAt: now })
              .where(eq(confirmations.id, old.id));
          }
        }

        const confirmationId = newId();
        const expiresAt = new Date(now.getTime() + CONFIRMATION_TTL_MS);
        await tx.insert(confirmations).values({
          id: confirmationId,
          ownerId: principal.ownerId,
          action: input.action,
          targets,
          payload,
          payloadHash,
          preview,
          source: principal.source,
          expiresAt,
          createdAt: now,
        });
        return { confirmationId, payloadHash, preview, expiresAt };
      });
    },

    // Executes exactly what was previewed, once, if it is still current. Any change to the
    // targets since the proposal means the confirmation is void and a fresh one is required.
    async confirm(
      principal: unknown,
      input: { confirmationId: string; payloadHash: string },
    ): Promise<ConfirmationOutcome> {
      assertPrincipal(principal);
      if (principal.audience === "shared") {
        throw new AccessDeniedError(
          "confirmation",
          "personal data is not available in shared channels",
        );
      }
      const now = clock();

      type Result =
        { ok: true; result: Record<string, unknown> } | { ok: false; failure: ConfirmationError };

      const outcome: Result = await db.transaction(async (tx) => {
        const [row] = await tx
          .select()
          .from(confirmations)
          .where(
            and(
              eq(confirmations.id, input.confirmationId),
              eq(confirmations.ownerId, principal.ownerId),
            ),
          )
          .for("update");
        if (!row) {
          return {
            ok: false,
            failure: new ConfirmationError("not_found", "No such confirmation."),
          };
        }
        if (row.status !== "pending") {
          return {
            ok: false,
            failure: new ConfirmationError(
              "already_resolved",
              `This confirmation was already ${row.status}. Ask again to get a fresh one.`,
            ),
          };
        }
        if (now.getTime() >= row.expiresAt.getTime()) {
          await tx
            .update(confirmations)
            .set({ status: "expired", resolvedAt: now })
            .where(eq(confirmations.id, row.id));
          return {
            ok: false,
            failure: new ConfirmationError("expired", "This confirmation expired. Ask again."),
          };
        }
        if (input.payloadHash !== row.payloadHash) {
          return {
            ok: false,
            failure: new ConfirmationError(
              "mismatch",
              "That confirmation does not match the proposed action.",
            ),
          };
        }

        // The policy may have changed since the proposal; the stored action must still need
        // (and be allowed) this confirmation.
        const decision = decide(principal, row.action);
        if (decision.kind !== "confirm") {
          throw new AccessDeniedError(row.action, "this action can no longer be confirmed");
        }

        const executor = executorFor(row.action);
        let current: ConfirmationTarget[];
        try {
          current = await executor.targets(tx, principal.ownerId, row.payload);
        } catch (error) {
          if (!(error instanceof NotFoundError)) throw error;
          current = [];
        }
        if (!sameTargets(current, row.targets)) {
          await tx
            .update(confirmations)
            .set({ status: "superseded", resolvedAt: now })
            .where(eq(confirmations.id, row.id));
          return {
            ok: false,
            failure: new ConfirmationError(
              "stale",
              "The records changed since this was proposed. Ask again to review the current state.",
            ),
          };
        }

        const result = await executor.execute(
          tx,
          { ...principal, source: principal.source },
          row.payload,
          row.id,
          now,
        );
        await tx
          .update(confirmations)
          .set({ status: "executed", resolvedAt: now, preview: executor.scrub(row.preview) })
          .where(eq(confirmations.id, row.id));
        return { ok: true, result };
      });

      if (!outcome.ok) throw outcome.failure;
      return { confirmationId: input.confirmationId, result: outcome.result };
    },

    async cancel(principal: unknown, confirmationId: string): Promise<void> {
      assertPrincipal(principal);
      if (principal.audience === "shared") {
        throw new AccessDeniedError(
          "confirmation",
          "personal data is not available in shared channels",
        );
      }
      await db
        .update(confirmations)
        .set({ status: "canceled", resolvedAt: clock() })
        .where(
          and(
            eq(confirmations.id, confirmationId),
            eq(confirmations.ownerId, principal.ownerId),
            eq(confirmations.status, "pending"),
          ),
        );
    },
  };
}

export type ConfirmationService = ReturnType<typeof createConfirmationService>;
