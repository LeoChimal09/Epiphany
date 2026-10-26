import { and, asc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { newId, recordAction, type Actor } from "../db/domain";
import {
  calendarAccounts,
  calendarEventRefs,
  events,
  owners,
  syncedCalendars,
  tasks,
  workBlocks,
  type CalendarAccount,
  type CalendarEventRef,
  type CalendarRefState,
  type SyncedCalendar,
  type WorkBlock,
} from "../db/schema";
import { addDays, localWallToUtc } from "../planning/time";
import { getAccessToken, markNeedsReauth, runtimeNow, type CalendarRuntime } from "./access";
import {
  createGoogleCalendarClient,
  EPIPHANY_KEY_PROPERTY,
  type GoogleCalendarClient,
  type GoogleEvent,
  type GoogleEventBody,
  type GoogleEventTime,
} from "./google/client";
import {
  GoogleApiError,
  GoogleAuthError,
  GoogleConflictError,
  GoogleGoneError,
  GoogleNotFoundError,
  GooglePreconditionError,
  GoogleRateLimitError,
  GoogleTokenError,
  UncertainWriteError,
} from "./google/errors";
import { canWrite } from "./google/oauth";
import { CalendarError, detachImportedEvents } from "./store";

export const EPIPHANY_CALENDAR_NAME = "Epiphany";
export const DEFAULT_SYNC_INTERVAL_MS = 5 * 60_000;
const FULL_SYNC_PAST_MS = 30 * 24 * 3600_000;
const FULL_SYNC_FUTURE_MS = 180 * 24 * 3600_000;
const FULL_RESYNC_AFTER_MS = 7 * 24 * 3600_000;
const PUSH_WINDOW_BACK_MS = 24 * 3600_000;
const MAX_PUSHES_PER_RUN = 25;
const BLOCK_DESCRIPTION =
  "Planned by Epiphany. Change this block in Epiphany; edits made here are not copied back and will be flagged as a conflict.";

export const syncKeyFor = (blockId: string) => `wb:${blockId}`;
const DEADLINE_SYNC_PREFIX = "deadline:";
const deadlineSyncKeyFor = (taskId: string, version: number) =>
  `${DEADLINE_SYNC_PREFIX}${taskId}:v${version}`;
const deadlineEventIdFor = (taskId: string, version: number) =>
  `epid${taskId.replaceAll("-", "").toLowerCase()}v${version}`;
const deadlineVersionFromKey = (key: string | null) => {
  const match = key?.match(/:v(\d+)$/);
  return match ? Number(match[1]) : null;
};
const taskIdFromDeadlineKey = (key: string | null) => {
  if (!key?.startsWith(DEADLINE_SYNC_PREFIX)) return null;
  return key.slice(DEADLINE_SYNC_PREFIX.length).split(":")[0] ?? null;
};
// Google accepts client-chosen event IDs made of a-v and 0-9. A UUID's hex digits fit, so a block
// always maps to the same event ID: creating it twice cannot produce two events.
export const eventIdFor = (blockId: string) => `epi${blockId.replace(/-/g, "").toLowerCase()}`;

export interface CalendarSyncReport {
  accountId: string;
  status: "skipped" | "ok" | "error" | "needs_reauth";
  imported: number;
  updated: number;
  canceled: number;
  skipped: number;
  pushed: { created: number; updated: number; removed: number };
  conflicts: number;
  uncertain: number;
  errors: string[];
}

function emptyReport(accountId: string): CalendarSyncReport {
  return {
    accountId,
    status: "ok",
    imported: 0,
    updated: 0,
    canceled: 0,
    skipped: 0,
    pushed: { created: 0, updated: 0, removed: 0 },
    conflicts: 0,
    uncertain: 0,
    errors: [],
  };
}

// A short, safe description of a failure for the dashboard and logs: no tokens, URLs, or bodies.
export function describeSyncError(error: unknown): string {
  if (error instanceof CalendarError) return error.message;
  if (error instanceof GoogleApiError || error instanceof GoogleTokenError) return error.message;
  if (error instanceof UncertainWriteError) return error.message;
  return "Unexpected error while syncing Google Calendar.";
}

// Failures that end the whole run for this account instead of just one calendar or block.
function isAbort(error: unknown): boolean {
  return (
    error instanceof CalendarError ||
    error instanceof GoogleAuthError ||
    error instanceof GoogleRateLimitError ||
    error instanceof GoogleTokenError
  );
}

interface Ctx {
  rt: CalendarRuntime;
  client: GoogleCalendarClient;
  account: CalendarAccount;
  ownerTimezone: string;
  now: Date;
  report: CalendarSyncReport;
}

const SYSTEM = (ownerId: string, now: Date): Actor => ({ ownerId, source: "worker", now });

// Syncs one connected account: discovers calendars (and the dedicated Epiphany calendar), reads the
// selected calendars into local events, then mirrors task deadlines and work blocks to the Epiphany
// calendar. Safe to run repeatedly; a second run with no changes writes nothing. Never throws for
// provider problems: they are recorded on the account/calendar and in the returned report.
export async function syncAccount(
  rt: CalendarRuntime,
  accountId: string,
  options: { force?: boolean; intervalMs?: number } = {},
): Promise<CalendarSyncReport> {
  const report = emptyReport(accountId);
  const now = runtimeNow(rt);
  const [account] = await rt.db
    .select()
    .from(calendarAccounts)
    .where(eq(calendarAccounts.id, accountId));
  if (!account || account.status !== "connected") return { ...report, status: "skipped" };

  const [owner] = await rt.db
    .select({ timezone: owners.timezone })
    .from(owners)
    .where(eq(owners.id, account.ownerId));
  const client = createGoogleCalendarClient({
    getAccessToken: (o) => getAccessToken(rt, accountId, o),
    fetch: rt.fetch,
    sleep: rt.sleep,
    random: rt.random,
  });
  const ctx: Ctx = {
    rt,
    client,
    account,
    ownerTimezone: owner?.timezone ?? "America/Chicago",
    now,
    report,
  };

  try {
    const interval = options.intervalMs ?? DEFAULT_SYNC_INTERVAL_MS;
    let calendars = await rt.db
      .select()
      .from(syncedCalendars)
      .where(eq(syncedCalendars.accountId, accountId));
    const tracked = (c: SyncedCalendar) => c.selected || c.kind === "epiphany";
    const due =
      options.force === true ||
      calendars.length === 0 ||
      calendars.some(
        (c) =>
          tracked(c) && (!c.lastAttemptAt || now.getTime() - c.lastAttemptAt.getTime() >= interval),
      );

    if (due) {
      await discoverCalendars(ctx);
      calendars = await rt.db
        .select()
        .from(syncedCalendars)
        .where(eq(syncedCalendars.accountId, accountId));
      for (const calendar of calendars) {
        if (!tracked(calendar)) continue;
        await pullCalendar(ctx, calendar);
      }
    }

    const [fresh] = await rt.db
      .select()
      .from(calendarAccounts)
      .where(eq(calendarAccounts.id, accountId));
    if (fresh?.status === "connected" && canWrite(fresh.scopes)) {
      const writeCtx = { ...ctx, account: fresh };
      await pushWorkBlocks(writeCtx);
      await pushTaskDeadlines(writeCtx);
    }
    if (report.errors.length === 0) {
      await rt.db
        .update(calendarAccounts)
        .set({ lastError: null })
        .where(and(eq(calendarAccounts.id, accountId), eq(calendarAccounts.status, "connected")));
    } else report.status = "error";
  } catch (error) {
    report.status = "error";
    report.errors.push(describeSyncError(error));
    if (error instanceof CalendarError && error.code === "needs_reauth") {
      report.status = "needs_reauth";
    } else if (error instanceof CalendarError) {
      report.status = "skipped";
    } else if (error instanceof GoogleAuthError) {
      await markNeedsReauth(
        rt,
        accountId,
        "Google refused the saved authorization. Connect Google Calendar again.",
      );
      report.status = "needs_reauth";
    } else {
      await rt.db
        .update(calendarAccounts)
        .set({ lastError: describeSyncError(error).slice(0, 300) })
        .where(and(eq(calendarAccounts.id, accountId), eq(calendarAccounts.status, "connected")));
    }
  }
  return report;
}

// Syncs every connected account (the worker's tick).
export async function syncAllAccounts(
  rt: CalendarRuntime,
  options: { force?: boolean; intervalMs?: number } = {},
): Promise<CalendarSyncReport[]> {
  const accounts = await rt.db
    .select({ id: calendarAccounts.id })
    .from(calendarAccounts)
    .where(eq(calendarAccounts.status, "connected"));
  const reports: CalendarSyncReport[] = [];
  for (const account of accounts) reports.push(await syncAccount(rt, account.id, options));
  return reports;
}

// ── Discovery ────────────────────────────────────────────────────────────────────────────

async function discoverCalendars(ctx: Ctx): Promise<void> {
  const { rt, client, account, now } = ctx;
  const list = await client.listCalendars();
  const existing = await rt.db
    .select()
    .from(syncedCalendars)
    .where(eq(syncedCalendars.accountId, account.id));
  const byExternal = new Map(existing.map((c) => [c.externalId, c]));
  const firstDiscovery = existing.length === 0;
  const listed = new Set(list.map((c) => c.id));

  for (const entry of list) {
    const row = byExternal.get(entry.id);
    if (!row) {
      await rt.db
        .insert(syncedCalendars)
        .ignore()
        .values({
          id: newId(),
          ownerId: account.ownerId,
          accountId: account.id,
          externalId: entry.id,
          kind: entry.id === account.epiphanyCalendarId ? "epiphany" : "external",
          summary: entry.summary.slice(0, 300),
          timeZone: entry.timeZone,
          accessRole: entry.accessRole,
          isPrimary: entry.primary,
          // The primary calendar is read by default the first time; the owner can turn it off.
          selected: firstDiscovery && entry.primary && entry.id !== account.epiphanyCalendarId,
        });
    } else if (
      row.summary !== entry.summary.slice(0, 300) ||
      row.timeZone !== entry.timeZone ||
      row.accessRole !== entry.accessRole ||
      row.isPrimary !== entry.primary
    ) {
      await rt.db
        .update(syncedCalendars)
        .set({
          summary: entry.summary.slice(0, 300),
          timeZone: entry.timeZone,
          accessRole: entry.accessRole,
          isPrimary: entry.primary,
        })
        .where(eq(syncedCalendars.id, row.id));
    }
  }

  for (const row of existing) {
    if (listed.has(row.externalId) || row.kind === "epiphany") continue;
    if (row.selected || row.syncStatus !== "error") {
      await rt.db.transaction(async (tx) => {
        await detachImportedEvents(tx, account.ownerId, row.id, now, "calendar_unavailable");
        await tx
          .update(syncedCalendars)
          .set({
            selected: false,
            syncToken: null,
            fullSyncedAt: null,
            syncStatus: "error",
            lastError: "This calendar is no longer available in Google Calendar.",
          })
          .where(eq(syncedCalendars.id, row.id));
      });
    }
  }

  if (canWrite(account.scopes)) await ensureEpiphanyCalendar(ctx, list);
}

async function ensureEpiphanyCalendar(
  ctx: Ctx,
  list: Awaited<ReturnType<GoogleCalendarClient["listCalendars"]>>,
): Promise<void> {
  const { rt, client, account } = ctx;
  let id = account.epiphanyCalendarId;
  let recreated = false;
  if (id && !list.some((c) => c.id === id)) {
    id = null;
    recreated = true;
  }
  if (!id) {
    const found = list.find(
      (c) => c.summary === EPIPHANY_CALENDAR_NAME && c.accessRole === "owner" && !c.primary,
    );
    id =
      found?.id ??
      (
        await client.insertCalendar({
          summary: EPIPHANY_CALENDAR_NAME,
          description: "Work blocks planned by Epiphany. Epiphany only writes to this calendar.",
          timeZone: ctx.ownerTimezone,
        })
      ).id;
    // Compare-and-set so two processes cannot disagree about which calendar is the dedicated one.
    const [result] = await rt.db
      .update(calendarAccounts)
      .set({ epiphanyCalendarId: id })
      .where(
        and(
          eq(calendarAccounts.id, account.id),
          recreated
            ? eq(calendarAccounts.epiphanyCalendarId, account.epiphanyCalendarId ?? "")
            : sql`${calendarAccounts.epiphanyCalendarId} IS NULL`,
        ),
      );
    if (result.affectedRows === 0) {
      const [current] = await rt.db
        .select({ id: calendarAccounts.epiphanyCalendarId })
        .from(calendarAccounts)
        .where(eq(calendarAccounts.id, account.id));
      id = current?.id ?? id;
    }
    ctx.account = { ...account, epiphanyCalendarId: id };
  }

  const rows = await rt.db
    .select()
    .from(syncedCalendars)
    .where(eq(syncedCalendars.accountId, account.id));
  const target = rows.find((r) => r.externalId === id);
  if (recreated) {
    // The old dedicated calendar is gone, and so are its events; their references are stale.
    for (const old of rows.filter((r) => r.kind === "epiphany" && r.externalId !== id)) {
      await rt.db
        .delete(calendarEventRefs)
        .where(
          and(
            eq(calendarEventRefs.calendarId, old.id),
            eq(calendarEventRefs.ownership, "epiphany"),
          ),
        );
      await rt.db
        .update(syncedCalendars)
        .set({ kind: "external", selected: false, syncToken: null })
        .where(eq(syncedCalendars.id, old.id));
    }
  }
  const entry = list.find((c) => c.id === id);
  if (!target) {
    await rt.db
      .insert(syncedCalendars)
      .ignore()
      .values({
        id: newId(),
        ownerId: account.ownerId,
        accountId: account.id,
        externalId: id,
        kind: "epiphany",
        summary: EPIPHANY_CALENDAR_NAME,
        timeZone: entry?.timeZone ?? ctx.ownerTimezone,
        accessRole: entry?.accessRole ?? "owner",
        selected: true,
      });
  } else if (target.kind !== "epiphany") {
    await rt.db
      .update(syncedCalendars)
      .set({ kind: "epiphany", selected: true, syncToken: null, fullSyncedAt: null })
      .where(eq(syncedCalendars.id, target.id));
  }
}

// ── Pull: provider → local events ───────────────────────────────────────────────────────

function validZone(zone: string | null | undefined, fallback: string): string {
  if (zone) {
    try {
      new Intl.DateTimeFormat("en-US", { timeZone: zone });
      return zone;
    } catch {
      // fall through
    }
  }
  return fallback;
}

interface MappedEvent {
  title: string;
  location: string | null;
  startsAt: Date;
  endsAt: Date;
  allDay: boolean;
  timezone: string;
  recurringEventId: string | null;
  originalStartAt: Date | null;
}

function parseTime(time: GoogleEventTime | undefined, zone: string): Date | null {
  if (!time) return null;
  if (time.dateTime) {
    const parsed = new Date(time.dateTime);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  if (time.date && /^\d{4}-\d{2}-\d{2}$/.test(time.date)) {
    try {
      return localWallToUtc(time.date, 0, zone);
    } catch {
      return null;
    }
  }
  return null;
}

export function mapGoogleEvent(
  ev: GoogleEvent,
  calendarZone: string | null,
  ownerZone: string,
): MappedEvent | null {
  const allDay = Boolean(ev.start?.date && !ev.start.dateTime);
  const timezone = validZone(ev.start?.timeZone ?? calendarZone, validZone(ownerZone, "UTC"));
  const startsAt = parseTime(ev.start, timezone);
  let endsAt = parseTime(
    ev.end,
    validZone(ev.end?.timeZone ?? ev.start?.timeZone ?? calendarZone, timezone),
  );
  if (!startsAt) return null;
  if (!endsAt) endsAt = new Date(startsAt.getTime() + (allDay ? 24 * 3600_000 : 3600_000));
  if (endsAt.getTime() < startsAt.getTime()) return null;
  return {
    title: (ev.summary?.trim() || "(No title)").slice(0, 300),
    location: ev.location?.trim() ? ev.location.trim().slice(0, 300) : null,
    startsAt,
    endsAt,
    allDay,
    timezone,
    recurringEventId: ev.recurringEventId ?? null,
    originalStartAt: parseTime(ev.originalStartTime, timezone),
  };
}

async function recordCalendarAttempt(
  rt: CalendarRuntime,
  calendar: SyncedCalendar,
  now: Date,
  outcome: { ok: true; syncToken: string | null; full: boolean } | { ok: false; error: string },
): Promise<void> {
  if (outcome.ok) {
    await rt.db
      .update(syncedCalendars)
      .set({
        syncToken: outcome.syncToken,
        ...(outcome.full ? { fullSyncedAt: now } : {}),
        lastSyncedAt: now,
        lastAttemptAt: now,
        syncStatus: "ok",
        lastError: null,
        version: calendar.version + 1,
      })
      .where(eq(syncedCalendars.id, calendar.id));
  } else {
    await rt.db
      .update(syncedCalendars)
      .set({
        lastAttemptAt: now,
        syncStatus: calendar.lastSyncedAt ? "stale" : "error",
        lastError: outcome.error.slice(0, 300),
        version: calendar.version + 1,
      })
      .where(eq(syncedCalendars.id, calendar.id));
  }
}

async function pullCalendar(ctx: Ctx, calendar: SyncedCalendar): Promise<void> {
  const { rt, client, now, report } = ctx;
  const [stillSelected] = await rt.db
    .select({ selected: syncedCalendars.selected, kind: syncedCalendars.kind })
    .from(syncedCalendars)
    .where(eq(syncedCalendars.id, calendar.id));
  if (!stillSelected || (!stillSelected.selected && stillSelected.kind !== "epiphany")) return;

  const needsFull =
    !calendar.syncToken ||
    !calendar.fullSyncedAt ||
    now.getTime() - calendar.fullSyncedAt.getTime() > FULL_RESYNC_AFTER_MS;
  const timeMin = new Date(now.getTime() - FULL_SYNC_PAST_MS);
  const timeMax = new Date(now.getTime() + FULL_SYNC_FUTURE_MS);
  const window = { timeMin: timeMin.toISOString(), timeMax: timeMax.toISOString() };

  try {
    let full = needsFull;
    let result;
    if (full) {
      result = await client.listAllEvents(calendar.externalId, window);
    } else {
      try {
        result = await client.listAllEvents(calendar.externalId, {
          syncToken: calendar.syncToken!,
        });
      } catch (error) {
        if (!(error instanceof GoogleGoneError)) throw error;
        // The saved position expired: start over with a full read (410 Gone).
        full = true;
        result = await client.listAllEvents(calendar.externalId, window);
      }
    }
    report.skipped += result.skipped;

    const seen = new Set<string>();
    for (const ev of result.events) {
      seen.add(ev.id);
      await applyRemoteEvent(ctx, calendar, ev);
    }
    if (full && calendar.kind === "external") {
      await cancelMissing(ctx, calendar, seen, timeMin, timeMax);
    }
    await recordCalendarAttempt(rt, calendar, now, {
      ok: true,
      syncToken: result.nextSyncToken,
      full,
    });
  } catch (error) {
    const message = describeSyncError(error);
    await recordCalendarAttempt(rt, calendar, now, { ok: false, error: message });
    report.errors.push(message);
    if (isAbort(error)) throw error;
  }
}

async function findRef(
  db: Database,
  calendarId: string,
  externalId: string,
): Promise<CalendarEventRef | undefined> {
  const [ref] = await db
    .select()
    .from(calendarEventRefs)
    .where(
      and(
        eq(calendarEventRefs.calendarId, calendarId),
        eq(calendarEventRefs.externalId, externalId),
      ),
    );
  return ref;
}

async function applyRemoteEvent(
  ctx: Ctx,
  calendar: SyncedCalendar,
  ev: GoogleEvent,
): Promise<void> {
  const { rt, report } = ctx;
  if (ev.id.length > 255) {
    report.skipped++;
    return;
  }
  const ref = await findRef(rt.db, calendar.id, ev.id);
  const ownKey = ev.extendedProperties?.private?.[EPIPHANY_KEY_PROPERTY];

  // Events Epiphany wrote itself are recognized by their private key and never re-imported as
  // new events, so Epiphany's own writes cannot loop back.
  if (ownKey !== undefined || ref?.ownership === "epiphany") {
    if (ref?.ownership === "epiphany") await applyOwnRemote(ctx, ref, ev);
    return;
  }
  if (ev.eventType === "workingLocation") return;
  await importExternal(ctx, calendar, ref, ev);
}

async function importExternal(
  ctx: Ctx,
  calendar: SyncedCalendar,
  ref: CalendarEventRef | undefined,
  ev: GoogleEvent,
): Promise<void> {
  const { rt, now, report, account } = ctx;
  const actor = SYSTEM(account.ownerId, now);

  if (ev.status === "cancelled") {
    if (!ref?.eventId) return;
    const eventId = ref.eventId;
    await rt.db.transaction(async (tx) => {
      const [current] = await tx
        .select()
        .from(events)
        .where(and(eq(events.id, eventId), eq(events.ownerId, account.ownerId)))
        .for("update");
      if (current && current.status === "scheduled") {
        await tx
          .update(events)
          .set({ status: "canceled", canceledAt: now, version: current.version + 1 })
          .where(eq(events.id, eventId));
        await recordAction(tx, actor, {
          action: "calendar.event_cancel",
          entityType: "event",
          entityId: eventId,
          before: { status: "scheduled" },
          after: { status: "canceled", source: "google" },
        });
        report.canceled++;
      }
      await tx
        .update(calendarEventRefs)
        .set({ syncState: "remote_deleted", etag: ev.etag ?? null, lastSyncedAt: now })
        .where(eq(calendarEventRefs.id, ref.id));
    });
    return;
  }

  const mapped = mapGoogleEvent(ev, calendar.timeZone, ctx.ownerTimezone);
  if (!mapped) {
    report.skipped++;
    return;
  }
  const remoteUpdatedAt = ev.updated ? new Date(ev.updated) : null;
  const refFields = {
    etag: ev.etag ?? null,
    remoteUpdatedAt:
      remoteUpdatedAt && !Number.isNaN(remoteUpdatedAt.getTime()) ? remoteUpdatedAt : null,
    recurringEventId: mapped.recurringEventId,
    originalStartAt: mapped.originalStartAt,
    lastSyncedAt: now,
  };

  if (!ref) {
    const eventId = newId();
    try {
      await rt.db.transaction(async (tx) => {
        await tx.insert(events).values({
          id: eventId,
          ownerId: account.ownerId,
          title: mapped.title,
          location: mapped.location,
          startsAt: mapped.startsAt,
          endsAt: mapped.endsAt,
          allDay: mapped.allDay,
          timezone: mapped.timezone,
          status: ev.status === "cancelled" ? "canceled" : "scheduled",
        });
        await tx.insert(calendarEventRefs).values({
          id: newId(),
          ownerId: account.ownerId,
          accountId: account.id,
          calendarId: calendar.id,
          externalId: ev.id,
          ownership: "external",
          eventId,
          syncState: "synced",
          ...refFields,
        });
        await recordAction(tx, actor, {
          action: "calendar.event_import",
          entityType: "event",
          entityId: eventId,
          after: { title: mapped.title, startsAt: mapped.startsAt.toISOString(), source: "google" },
        });
      });
      report.imported++;
    } catch (error) {
      // A concurrent run imported it first: the unique reference stops the duplicate.
      if ((error as { code?: string }).code !== "ER_DUP_ENTRY") throw error;
    }
    return;
  }

  if (!ref.eventId) return;
  const eventId = ref.eventId;
  const revive = ref.syncState === "remote_deleted" || ref.syncState === "detached";
  if (
    ref.etag !== null &&
    ref.etag === (ev.etag ?? null) &&
    !revive &&
    ref.syncState === "synced"
  ) {
    return;
  }
  await rt.db.transaction(async (tx) => {
    const [current] = await tx
      .select()
      .from(events)
      .where(and(eq(events.id, eventId), eq(events.ownerId, account.ownerId)))
      .for("update");
    if (current) {
      const changed =
        current.title !== mapped.title ||
        current.location !== mapped.location ||
        current.startsAt.getTime() !== mapped.startsAt.getTime() ||
        current.endsAt.getTime() !== mapped.endsAt.getTime() ||
        current.allDay !== mapped.allDay ||
        current.timezone !== mapped.timezone;
      const reviving = revive && current.status === "canceled";
      if (changed || reviving) {
        await tx
          .update(events)
          .set({
            title: mapped.title,
            location: mapped.location,
            startsAt: mapped.startsAt,
            endsAt: mapped.endsAt,
            allDay: mapped.allDay,
            timezone: mapped.timezone,
            ...(reviving ? { status: "scheduled" as const, canceledAt: null } : {}),
            version: current.version + 1,
          })
          .where(eq(events.id, eventId));
        await recordAction(tx, actor, {
          action: "calendar.event_update",
          entityType: "event",
          entityId: eventId,
          after: { startsAt: mapped.startsAt.toISOString(), source: "google" },
        });
        report.updated++;
      }
    }
    await tx
      .update(calendarEventRefs)
      .set({ ...refFields, syncState: "synced", lastError: null })
      .where(eq(calendarEventRefs.id, ref.id));
  });
}

// Full syncs list a bounded window; an imported event inside the window that Google no longer
// returns was deleted (or moved away), so its local copy is canceled, never deleted.
async function cancelMissing(
  ctx: Ctx,
  calendar: SyncedCalendar,
  seen: Set<string>,
  timeMin: Date,
  timeMax: Date,
): Promise<void> {
  const { rt, now, report, account } = ctx;
  const rows = await rt.db
    .select({ ref: calendarEventRefs, event: events })
    .from(calendarEventRefs)
    .innerJoin(events, eq(events.id, calendarEventRefs.eventId))
    .where(
      and(
        eq(calendarEventRefs.calendarId, calendar.id),
        eq(calendarEventRefs.ownership, "external"),
        eq(calendarEventRefs.syncState, "synced"),
        eq(events.status, "scheduled"),
        gt(events.startsAt, timeMin),
        sql`${events.startsAt} < ${timeMax}`,
      ),
    );
  for (const { ref, event } of rows) {
    if (seen.has(ref.externalId)) continue;
    await rt.db.transaction(async (tx) => {
      await tx
        .update(events)
        .set({ status: "canceled", canceledAt: now, version: event.version + 1 })
        .where(eq(events.id, event.id));
      await tx
        .update(calendarEventRefs)
        .set({ syncState: "remote_deleted", lastSyncedAt: now })
        .where(eq(calendarEventRefs.id, ref.id));
      await recordAction(tx, SYSTEM(account.ownerId, now), {
        action: "calendar.event_cancel",
        entityType: "event",
        entityId: event.id,
        before: { status: "scheduled" },
        after: { status: "canceled", source: "google", reason: "missing_from_full_sync" },
      });
    });
    report.canceled++;
  }
}

// An event Epiphany owns was seen at the provider. If its version differs from the one Epiphany
// last wrote, someone edited it elsewhere: flag it, never overwrite. If it was deleted there, keep
// the work block and say so.
async function applyOwnRemote(ctx: Ctx, ref: CalendarEventRef, ev: GoogleEvent): Promise<void> {
  const { rt, report, now } = ctx;
  if (["removed", "detached", "conflict", "remote_deleted", "uncertain"].includes(ref.syncState)) {
    return;
  }
  const entityLabel = ref.syncKey?.startsWith("deadline:") ? "task deadline" : "work block";
  if (ev.status === "cancelled") {
    await rt.db
      .update(calendarEventRefs)
      .set({
        syncState: "remote_deleted",
        lastError: `Deleted in Google Calendar. The ${entityLabel} is still active in Epiphany.`,
        lastSyncedAt: now,
      })
      .where(eq(calendarEventRefs.id, ref.id));
    report.conflicts++;
    return;
  }
  if (ref.etag && ev.etag && ev.etag !== ref.etag) {
    await rt.db
      .update(calendarEventRefs)
      .set({
        syncState: "conflict",
        lastError: `Changed in Google Calendar since Epiphany last wrote it. The ${entityLabel} was not overwritten.`,
        lastSyncedAt: now,
      })
      .where(eq(calendarEventRefs.id, ref.id));
    report.conflicts++;
  }
}

// ── Push: work blocks → the Epiphany calendar ───────────────────────────────────────────

// The only gate for writes: Epiphany writes solely to the one calendar it created, and only when
// the owner granted write access. Everything else, including every external event, is read-only.
export function assertOwnWrite(
  account: Pick<CalendarAccount, "epiphanyCalendarId" | "scopes">,
  calendar: Pick<SyncedCalendar, "externalId" | "kind">,
): void {
  if (
    !canWrite(account.scopes) ||
    calendar.kind !== "epiphany" ||
    account.epiphanyCalendarId === null ||
    calendar.externalId !== account.epiphanyCalendarId
  ) {
    throw new CalendarError("invalid", "Epiphany only writes to its own calendar.");
  }
}

function desiredWorkBlockBody(block: WorkBlock, title: string, zone: string): GoogleEventBody {
  return {
    id: eventIdFor(block.id),
    summary: title.slice(0, 300),
    description: BLOCK_DESCRIPTION,
    start: { dateTime: block.startsAt.toISOString(), timeZone: zone },
    end: { dateTime: block.endsAt.toISOString(), timeZone: zone },
    extendedProperties: { private: { [EPIPHANY_KEY_PROPERTY]: syncKeyFor(block.id) } },
  };
}

function desiredDeadlineBody(
  task: {
    id: string;
    title: string;
    dueAt: Date;
    dueDateOnly: boolean;
  },
  zone: string,
  generation: number,
): GoogleEventBody {
  const id = deadlineEventIdFor(task.id, generation);
  const syncKey = deadlineSyncKeyFor(task.id, generation);
  const common = {
    id,
    summary: `Due: ${task.title}`.slice(0, 300),
    description: "Task deadline and estimated work time managed by Epiphany.",
    extendedProperties: { private: { [EPIPHANY_KEY_PROPERTY]: syncKey } },
  };
  if (task.dueDateOnly) {
    const date = task.dueAt.toISOString().slice(0, 10);
    return { ...common, start: { date }, end: { date: addDays(date, 1) } };
  }
  return {
    ...common,
    start: { dateTime: task.dueAt.toISOString(), timeZone: zone },
    end: { dateTime: new Date(task.dueAt.getTime() + 15 * 60_000).toISOString(), timeZone: zone },
  };
}

function sameContent(found: GoogleEvent, desired: GoogleEventBody): boolean {
  const sameTime = (actual: GoogleEvent["start"], expected: GoogleEventBody["start"]) => {
    if (actual?.date && expected.date) return actual.date === expected.date;
    if (actual?.dateTime && expected.dateTime)
      return Date.parse(actual.dateTime) === Date.parse(expected.dateTime);
    return false;
  };
  return (
    (found.summary ?? "") === desired.summary &&
    sameTime(found.start, desired.start) &&
    sameTime(found.end, desired.end)
  );
}

interface PushCtx extends Ctx {
  calendar: SyncedCalendar;
}

async function setRef(
  ctx: PushCtx,
  ref: CalendarEventRef,
  state: CalendarRefState,
  patch: Partial<typeof calendarEventRefs.$inferInsert> = {},
): Promise<void> {
  await ctx.rt.db
    .update(calendarEventRefs)
    .set({ syncState: state, lastSyncedAt: ctx.now, ...patch })
    .where(eq(calendarEventRefs.id, ref.id));
}

async function pushWorkBlocks(ctx: Ctx): Promise<void> {
  const { rt, account, now } = ctx;
  const [calendar] = await rt.db
    .select()
    .from(syncedCalendars)
    .where(
      and(
        eq(syncedCalendars.accountId, account.id),
        eq(syncedCalendars.kind, "epiphany"),
        eq(syncedCalendars.externalId, account.epiphanyCalendarId ?? ""),
      ),
    );
  if (!calendar) return;
  const pctx: PushCtx = { ...ctx, calendar };

  const refs = await rt.db
    .select()
    .from(calendarEventRefs)
    .where(
      and(
        eq(calendarEventRefs.ownerId, account.ownerId),
        eq(calendarEventRefs.calendarId, calendar.id),
        eq(calendarEventRefs.ownership, "epiphany"),
      ),
    );
  const refByBlock = new Map(
    refs.flatMap((r) => (r.workBlockId ? [[r.workBlockId, r] as const] : [])),
  );

  const planned = await rt.db
    .select({ block: workBlocks, taskTitle: tasks.title })
    .from(workBlocks)
    .leftJoin(tasks, eq(tasks.id, workBlocks.taskId))
    .where(
      and(
        eq(workBlocks.ownerId, account.ownerId),
        eq(workBlocks.status, "planned"),
        gt(workBlocks.endsAt, new Date(now.getTime() - PUSH_WINDOW_BACK_MS)),
      ),
    )
    .orderBy(asc(workBlocks.startsAt));

  const removedIds = refs
    .filter((r) => r.workBlockId && ["synced", "pending", "uncertain"].includes(r.syncState))
    .map((r) => r.workBlockId!);
  const removed =
    removedIds.length === 0
      ? []
      : await rt.db
          .select({ block: workBlocks, taskTitle: tasks.title })
          .from(workBlocks)
          .leftJoin(tasks, eq(tasks.id, workBlocks.taskId))
          .where(
            and(
              eq(workBlocks.ownerId, account.ownerId),
              eq(workBlocks.status, "removed"),
              inArray(workBlocks.id, removedIds),
            ),
          );

  let budget = MAX_PUSHES_PER_RUN;
  const work: Array<{
    block: WorkBlock;
    title: string;
    ref: CalendarEventRef | null;
    remove: boolean;
  }> = [];
  for (const { block, taskTitle } of removed) {
    work.push({
      block,
      title: block.title ?? taskTitle ?? "Work block",
      ref: refByBlock.get(block.id) ?? null,
      remove: true,
    });
  }
  for (const { block, taskTitle } of planned) {
    const ref = refByBlock.get(block.id) ?? null;
    if (ref && ["conflict", "remote_deleted", "detached", "removed"].includes(ref.syncState))
      continue;
    const upToDate = ref?.syncState === "synced" && ref.syncedVersion === block.version;
    if (upToDate) continue;
    work.push({ block, title: block.title ?? taskTitle ?? "Work block", ref, remove: false });
  }

  for (const item of work) {
    if (budget-- <= 0) break;
    try {
      await syncBlock(pctx, item.block, item.title, item.ref, item.remove);
    } catch (error) {
      if (isAbort(error)) throw error;
      const message = describeSyncError(error);
      ctx.report.errors.push(message);
      await rt.db
        .update(calendarEventRefs)
        .set({ lastError: message.slice(0, 300) })
        .where(eq(calendarEventRefs.workBlockId, item.block.id));
    }
  }
}

async function ensureRef(
  ctx: PushCtx,
  input: { externalId: string; syncKey: string; workBlockId?: string },
): Promise<CalendarEventRef> {
  await ctx.rt.db
    .insert(calendarEventRefs)
    .ignore()
    .values({
      id: newId(),
      ownerId: ctx.account.ownerId,
      accountId: ctx.account.id,
      calendarId: ctx.calendar.id,
      externalId: input.externalId,
      ownership: "epiphany",
      ...(input.workBlockId ? { workBlockId: input.workBlockId } : {}),
      syncKey: input.syncKey,
      syncState: "pending",
    });
  const [ref] = await ctx.rt.db
    .select()
    .from(calendarEventRefs)
    .where(
      and(
        eq(calendarEventRefs.calendarId, ctx.calendar.id),
        eq(calendarEventRefs.externalId, input.externalId),
      ),
    );
  if (!ref) throw new Error("Calendar reference was not saved.");
  return ref;
}

// Mirrors one owned event without duplicating it, overwriting an edit made elsewhere, or retrying
// an uncertain write blindly.
async function syncOwnedEvent(
  ctx: PushCtx,
  input: {
    externalId: string;
    syncKey: string;
    desired: GoogleEventBody;
    version: number;
    entityLabel: string;
    existing: CalendarEventRef | null;
    removing: boolean;
    workBlockId?: string;
  },
): Promise<void> {
  const { client, calendar, report } = ctx;
  assertOwnWrite(ctx.account, calendar);
  const calendarId = calendar.externalId;

  let reference = input.existing;
  if (!reference) {
    if (input.removing) return;
    reference = await ensureRef(ctx, {
      externalId: input.externalId,
      syncKey: input.syncKey,
      ...(input.workBlockId ? { workBlockId: input.workBlockId } : {}),
    });
  }
  const live = reference;
  const { desired } = input;

  let etag = live.etag;
  const unconfirmed =
    live.syncState === "uncertain" || (live.syncState === "pending" && live.etag === null);
  if (unconfirmed) {
    // An earlier write may or may not have landed: look it up by its private key first.
    const found = await client.findEventByKey(calendarId, input.syncKey);
    if (found && found.status === "cancelled") {
      const message = `Deleted in Google Calendar. The ${input.entityLabel} is still active in Epiphany.`;
      await setRef(ctx, live, input.removing ? "removed" : "remote_deleted", {
        lastError: input.removing ? null : message,
        etag: found.etag ?? live.etag,
      });
      if (!input.removing) {
        report.conflicts++;
        if (input.entityLabel === "task deadline") report.errors.push(message);
      }
      return;
    }
    if (!found) {
      if (live.etag) {
        const message = `Deleted in Google Calendar. The ${input.entityLabel} is still active in Epiphany.`;
        await setRef(ctx, live, input.removing ? "removed" : "remote_deleted", {
          lastError: input.removing ? null : message,
        });
        if (!input.removing) {
          report.conflicts++;
          if (input.entityLabel === "task deadline") report.errors.push(message);
        }
        return;
      }
      if (input.removing) {
        await setRef(ctx, live, "removed", { lastError: null });
        return;
      }
      etag = null;
    } else if (live.etag === null || found.etag === live.etag) {
      etag = found.etag ?? null;
    } else if (!input.removing && sameContent(found, desired)) {
      await setRef(ctx, live, "synced", {
        etag: found.etag ?? null,
        remoteUpdatedAt: found.updated ? new Date(found.updated) : null,
        syncedVersion: input.version,
        lastError: null,
      });
      return;
    } else {
      await setRef(ctx, live, "conflict", {
        lastError:
          "Changed in Google Calendar while a write was unconfirmed. Nothing was overwritten.",
      });
      report.conflicts++;
      return;
    }
  }

  const uncertain = () => {
    report.uncertain++;
    return setRef(ctx, live, "uncertain", {
      lastError: "Waiting to confirm the last change with Google Calendar.",
    });
  };
  const conflict = (message: string) => {
    report.conflicts++;
    if (input.entityLabel === "task deadline") report.errors.push(message);
    return setRef(ctx, live, "conflict", { lastError: message });
  };
  const adopt = (ev: GoogleEvent) =>
    setRef(ctx, live, "synced", {
      etag: ev.etag ?? null,
      remoteUpdatedAt: ev.updated ? new Date(ev.updated) : null,
      syncedVersion: input.version,
      lastError: null,
    });

  if (input.removing) {
    if (!etag) {
      await setRef(ctx, live, "removed", { lastError: null });
      return;
    }
    try {
      await client.deleteEvent(calendarId, live.externalId, etag);
      await setRef(ctx, live, "removed", { lastError: null });
      report.pushed.removed++;
    } catch (error) {
      if (error instanceof GooglePreconditionError) {
        await conflict(`Changed in Google Calendar, so the ${input.entityLabel} was not deleted.`);
      } else if (error instanceof GoogleNotFoundError || error instanceof GoogleGoneError) {
        await setRef(ctx, live, "removed", { lastError: null });
      } else if (error instanceof UncertainWriteError) await uncertain();
      else throw error;
    }
    return;
  }

  if (!etag) {
    try {
      await adopt(await client.insertEvent(calendarId, desired));
      report.pushed.created++;
    } catch (error) {
      if (error instanceof UncertainWriteError || error instanceof GoogleConflictError) {
        // Already exists, or unknown: confirm by key on the next run instead of creating again.
        await uncertain();
      } else throw error;
    }
    return;
  }

  try {
    await adopt(await client.updateEvent(calendarId, live.externalId, desired, etag));
    report.pushed.updated++;
  } catch (error) {
    if (error instanceof GooglePreconditionError) {
      await conflict(
        `Changed in Google Calendar since Epiphany last wrote it. The ${input.entityLabel} was not overwritten.`,
      );
    } else if (error instanceof GoogleNotFoundError || error instanceof GoogleGoneError) {
      report.conflicts++;
      const message = `Deleted in Google Calendar. The ${input.entityLabel} is still active in Epiphany.`;
      if (input.entityLabel === "task deadline") report.errors.push(message);
      await setRef(ctx, live, "remote_deleted", {
        lastError: message,
      });
    } else if (error instanceof UncertainWriteError) await uncertain();
    else throw error;
  }
}

async function syncBlock(
  ctx: PushCtx,
  block: WorkBlock,
  title: string,
  existing: CalendarEventRef | null,
  removing: boolean,
): Promise<void> {
  await syncOwnedEvent(ctx, {
    externalId: eventIdFor(block.id),
    syncKey: syncKeyFor(block.id),
    desired: desiredWorkBlockBody(block, title, ctx.ownerTimezone),
    version: block.version,
    entityLabel: "work block",
    existing,
    removing,
    workBlockId: block.id,
  });
}

async function pushTaskDeadlines(ctx: Ctx): Promise<void> {
  const { rt, account, ownerTimezone } = ctx;
  const [calendar] = await rt.db
    .select()
    .from(syncedCalendars)
    .where(
      and(
        eq(syncedCalendars.accountId, account.id),
        eq(syncedCalendars.kind, "epiphany"),
        eq(syncedCalendars.externalId, account.epiphanyCalendarId ?? ""),
      ),
    );
  if (!calendar) return;

  const pctx: PushCtx = { ...ctx, calendar };
  const [refs, dueTasks] = await Promise.all([
    rt.db
      .select()
      .from(calendarEventRefs)
      .where(
        and(
          eq(calendarEventRefs.ownerId, account.ownerId),
          eq(calendarEventRefs.calendarId, calendar.id),
          eq(calendarEventRefs.ownership, "epiphany"),
        ),
      ),
    rt.db
      .select({
        id: tasks.id,
        title: tasks.title,
        dueAt: tasks.dueAt,
        dueDateOnly: tasks.dueDateOnly,
        status: tasks.status,
        archivedAt: tasks.archivedAt,
        version: tasks.version,
      })
      .from(tasks)
      .where(and(eq(tasks.ownerId, account.ownerId), isNotNull(tasks.dueAt)))
      .orderBy(asc(tasks.dueAt)),
  ]);
  const deadlineRefs = refs.filter((ref) => taskIdFromDeadlineKey(ref.syncKey) !== null);
  const refByTaskId = new Map<string, CalendarEventRef>();
  for (const ref of deadlineRefs) {
    const taskId = taskIdFromDeadlineKey(ref.syncKey);
    if (taskId) refByTaskId.set(taskId, ref);
  }

  const activeTasks = dueTasks.filter(
    (task) => task.status === "open" && task.archivedAt === null && task.dueAt !== null,
  );
  const activeTaskIds = new Set(activeTasks.map((task) => task.id));
  let budget = MAX_PUSHES_PER_RUN;
  for (const task of activeTasks) {
    const dueAt = task.dueAt;
    if (!dueAt) continue;
    let ref = refByTaskId.get(task.id) ?? null;
    if (ref && ["conflict", "remote_deleted", "detached"].includes(ref.syncState)) {
      if (ref.syncState !== "detached")
        ctx.report.errors.push(
          ref.lastError ?? "A task deadline needs your attention in Google Calendar.",
        );
      continue;
    }
    if (ref?.syncState === "removed") {
      const [result] = await rt.db
        .update(calendarEventRefs)
        .set({
          externalId: deadlineEventIdFor(task.id, task.version),
          syncKey: deadlineSyncKeyFor(task.id, task.version),
          syncState: "pending",
          etag: null,
          syncedVersion: null,
          lastError: null,
        })
        .where(eq(calendarEventRefs.id, ref.id));
      if (result.affectedRows === 0) throw new Error("Task deadline reference was not updated.");
      const [reactivated] = await rt.db
        .select()
        .from(calendarEventRefs)
        .where(eq(calendarEventRefs.id, ref.id));
      if (!reactivated) throw new Error("Task deadline reference was not found.");
      ref = reactivated;
    }

    const generation = ref ? (deadlineVersionFromKey(ref.syncKey) ?? task.version) : task.version;
    const desired = desiredDeadlineBody({ ...task, dueAt }, ownerTimezone, generation);
    if (ref?.syncState === "synced" && ref.syncedVersion === task.version) continue;
    if (budget-- <= 0) break;
    try {
      await syncOwnedEvent(pctx, {
        externalId: ref?.externalId ?? desired.id!,
        syncKey: ref?.syncKey ?? deadlineSyncKeyFor(task.id, generation),
        desired,
        version: task.version,
        entityLabel: "task deadline",
        existing: ref,
        removing: false,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      const message = describeSyncError(error);
      ctx.report.errors.push(message);
      if (ref) {
        await rt.db
          .update(calendarEventRefs)
          .set({ lastError: message.slice(0, 300) })
          .where(eq(calendarEventRefs.id, ref.id));
      }
    }
  }

  for (const ref of deadlineRefs) {
    const taskId = taskIdFromDeadlineKey(ref.syncKey);
    if (!taskId || activeTaskIds.has(taskId)) continue;
    if (!["synced", "pending", "uncertain"].includes(ref.syncState)) continue;
    if (budget-- <= 0) break;
    try {
      await syncOwnedEvent(pctx, {
        externalId: ref.externalId,
        syncKey: ref.syncKey!,
        desired: {
          id: ref.externalId,
          summary: "",
          start: { dateTime: ctx.now.toISOString() },
          end: { dateTime: new Date(ctx.now.getTime() + 60_000).toISOString() },
        },
        version: ref.syncedVersion ?? 0,
        entityLabel: "task deadline",
        existing: ref,
        removing: true,
      });
    } catch (error) {
      if (isAbort(error)) throw error;
      const message = describeSyncError(error);
      ctx.report.errors.push(message);
      await rt.db
        .update(calendarEventRefs)
        .set({ lastError: message.slice(0, 300) })
        .where(eq(calendarEventRefs.id, ref.id));
    }
  }
}

// ── Conflict resolution ─────────────────────────────────────────────────────────────────

export type ConflictChoice = "overwrite_google" | "keep_google";

// The owner's explicit decision about a work block whose Google event changed elsewhere.
//   keep_google: stop mirroring this block; the Google event is left exactly as it is.
//   overwrite_google: adopt Google's current version as the base so the next sync writes Epiphany's
//     version over it (still conditional on that version). Not offered when the event was deleted.
export async function resolveBlockConflict(
  rt: CalendarRuntime,
  actor: Actor,
  blockId: string,
  choice: ConflictChoice,
): Promise<"detached" | "pending"> {
  const now = actor.now ?? runtimeNow(rt);
  const [ref] = await rt.db
    .select()
    .from(calendarEventRefs)
    .where(
      and(
        eq(calendarEventRefs.ownerId, actor.ownerId),
        eq(calendarEventRefs.workBlockId, blockId),
        eq(calendarEventRefs.ownership, "epiphany"),
      ),
    );
  if (!ref || (ref.syncState !== "conflict" && ref.syncState !== "remote_deleted")) {
    throw new CalendarError("invalid", "This work block has no calendar conflict to resolve.");
  }
  if (choice === "keep_google") {
    await rt.db
      .update(calendarEventRefs)
      .set({
        syncState: "detached",
        lastSyncedAt: now,
        lastError: "You kept the Google Calendar version; this block is no longer mirrored.",
      })
      .where(eq(calendarEventRefs.id, ref.id));
    return "detached";
  }
  if (ref.syncState === "remote_deleted") {
    throw new CalendarError(
      "invalid",
      "The event was deleted in Google Calendar. Keep that, or plan the block again.",
    );
  }
  const [calendar] = await rt.db
    .select()
    .from(syncedCalendars)
    .where(eq(syncedCalendars.id, ref.calendarId));
  const [account] = await rt.db
    .select()
    .from(calendarAccounts)
    .where(eq(calendarAccounts.id, ref.accountId));
  if (!calendar || !account)
    throw new CalendarError("not_connected", "Google Calendar is not connected.");
  assertOwnWrite(account, calendar);
  const client = createGoogleCalendarClient({
    getAccessToken: (o) => getAccessToken(rt, account.id, o),
    fetch: rt.fetch,
    sleep: rt.sleep,
    random: rt.random,
  });
  const found = await client.getEvent(calendar.externalId, ref.externalId);
  if (found.status === "cancelled") {
    throw new CalendarError("invalid", "The event was deleted in Google Calendar.");
  }
  await rt.db
    .update(calendarEventRefs)
    .set({
      etag: found.etag ?? null,
      syncState: "pending",
      syncedVersion: null,
      lastError: null,
      lastSyncedAt: now,
    })
    .where(eq(calendarEventRefs.id, ref.id));
  return "pending";
}
