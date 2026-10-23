import { and, asc, eq, inArray, isNull, ne, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { newId, recordAction, type Actor } from "../db/domain";
import {
  calendarAccounts,
  calendarEventRefs,
  events,
  syncedCalendars,
  tasks,
  workBlocks,
  type CalendarAccountStatus,
  type CalendarRefState,
  type CalendarSyncStatus,
} from "../db/schema";
import { canWrite } from "./google/oauth";

export type CalendarErrorCode =
  | "not_configured"
  | "not_connected"
  | "needs_reauth"
  | "account_mismatch"
  | "no_refresh_token"
  | "invalid";

export class CalendarError extends Error {
  readonly code: CalendarErrorCode;
  constructor(code: CalendarErrorCode, message: string) {
    super(message);
    this.name = "CalendarError";
    this.code = code;
  }
}

// Synced data older than this is shown as stale even if the last attempt succeeded.
export const STALE_AFTER_MS = 20 * 60_000;

export interface CalendarAccountView {
  id: string;
  provider: "google";
  email: string | null;
  status: CalendarAccountStatus;
  canWrite: boolean;
  hasEpiphanyCalendar: boolean;
  lastError: string | null;
  connectedAt: Date;
  disconnectedAt: Date | null;
}

export interface CalendarView {
  id: string;
  accountId: string;
  summary: string;
  kind: "external" | "epiphany";
  selected: boolean;
  isPrimary: boolean;
  timeZone: string | null;
  accessRole: string | null;
  syncStatus: CalendarSyncStatus;
  lastSyncedAt: Date | null;
  lastError: string | null;
}

export interface BlockSyncView {
  workBlockId: string;
  title: string | null;
  startsAt: Date;
  state: CalendarRefState;
  error: string | null;
}

export interface CalendarOverview {
  // The most recent account that is not revoked, or the latest revoked one, never any token.
  account: CalendarAccountView | null;
  calendars: CalendarView[];
  // Planned work blocks that are not (yet) mirrored to the Epiphany calendar.
  blocks: BlockSyncView[];
  conflicts: number;
}

export function derivedSyncStatus(
  calendar: Pick<CalendarView, "syncStatus" | "lastSyncedAt">,
  now: Date,
): CalendarSyncStatus {
  if (calendar.syncStatus === "ok" && calendar.lastSyncedAt) {
    return now.getTime() - calendar.lastSyncedAt.getTime() > STALE_AFTER_MS ? "stale" : "ok";
  }
  return calendar.syncStatus;
}

// Everything the dashboard shows about calendars. Columns are listed explicitly so the encrypted
// tokens are never read into a view.
export async function loadCalendarOverview(
  db: Database,
  ownerId: string,
  now: Date,
): Promise<CalendarOverview> {
  const accounts = await db
    .select({
      id: calendarAccounts.id,
      provider: calendarAccounts.provider,
      email: calendarAccounts.accountEmail,
      status: calendarAccounts.status,
      scopes: calendarAccounts.scopes,
      epiphanyCalendarId: calendarAccounts.epiphanyCalendarId,
      lastError: calendarAccounts.lastError,
      connectedAt: calendarAccounts.connectedAt,
      disconnectedAt: calendarAccounts.disconnectedAt,
    })
    .from(calendarAccounts)
    .where(eq(calendarAccounts.ownerId, ownerId))
    .orderBy(sql`${calendarAccounts.status} = 'revoked'`, sql`${calendarAccounts.connectedAt} DESC`)
    .limit(1);
  const row = accounts[0];
  if (!row) return { account: null, calendars: [], blocks: [], conflicts: 0 };

  const account: CalendarAccountView = {
    id: row.id,
    provider: row.provider,
    email: row.email,
    status: row.status,
    canWrite: canWrite(row.scopes),
    hasEpiphanyCalendar: row.epiphanyCalendarId !== null,
    lastError: row.lastError,
    connectedAt: row.connectedAt,
    disconnectedAt: row.disconnectedAt,
  };
  if (row.status === "revoked") return { account, calendars: [], blocks: [], conflicts: 0 };

  const calendarRows = await db
    .select()
    .from(syncedCalendars)
    .where(and(eq(syncedCalendars.ownerId, ownerId), eq(syncedCalendars.accountId, row.id)))
    .orderBy(sql`${syncedCalendars.kind} = 'epiphany'`, asc(syncedCalendars.summary));
  const calendars: CalendarView[] = calendarRows.map((c) => {
    const view: CalendarView = {
      id: c.id,
      accountId: c.accountId,
      summary: c.summary,
      kind: c.kind,
      selected: c.selected || c.kind === "epiphany",
      isPrimary: c.isPrimary,
      timeZone: c.timeZone,
      accessRole: c.accessRole,
      syncStatus: c.syncStatus,
      lastSyncedAt: c.lastSyncedAt,
      lastError: c.lastError,
    };
    return { ...view, syncStatus: derivedSyncStatus(view, now) };
  });

  const blocks = account.canWrite ? await loadBlockStates(db, ownerId, now) : [];
  const [conflicts] = await db
    .select({ n: sql<number>`COUNT(*)` })
    .from(calendarEventRefs)
    .where(
      and(
        eq(calendarEventRefs.ownerId, ownerId),
        eq(calendarEventRefs.ownership, "epiphany"),
        inArray(calendarEventRefs.syncState, ["conflict", "remote_deleted"]),
      ),
    );
  return { account, calendars, blocks, conflicts: Number(conflicts?.n ?? 0) };
}

const BLOCK_WINDOW_BACK_MS = 24 * 3600_000;
const BLOCK_WINDOW_FORWARD_MS = 60 * 24 * 3600_000;

// Planned blocks around now that are waiting for, or stuck in, sync. Blocks with no reference yet
// are 'pending'; synced ones are left out so the list stays short.
export async function loadBlockStates(
  db: Database,
  ownerId: string,
  now: Date,
  limit = 50,
): Promise<BlockSyncView[]> {
  const rows = await db
    .select({
      id: workBlocks.id,
      title: workBlocks.title,
      taskTitle: tasks.title,
      startsAt: workBlocks.startsAt,
      version: workBlocks.version,
      state: calendarEventRefs.syncState,
      syncedVersion: calendarEventRefs.syncedVersion,
      error: calendarEventRefs.lastError,
    })
    .from(workBlocks)
    .leftJoin(tasks, eq(tasks.id, workBlocks.taskId))
    .leftJoin(calendarEventRefs, eq(calendarEventRefs.workBlockId, workBlocks.id))
    .where(
      and(
        eq(workBlocks.ownerId, ownerId),
        eq(workBlocks.status, "planned"),
        sql`${workBlocks.endsAt} > ${new Date(now.getTime() - BLOCK_WINDOW_BACK_MS)}`,
        sql`${workBlocks.startsAt} < ${new Date(now.getTime() + BLOCK_WINDOW_FORWARD_MS)}`,
      ),
    )
    .orderBy(asc(workBlocks.startsAt))
    .limit(500);

  const out: BlockSyncView[] = [];
  for (const row of rows) {
    let state: CalendarRefState = row.state ?? "pending";
    if (state === "synced" && row.syncedVersion !== row.version) state = "pending";
    if (state === "synced") continue;
    out.push({
      workBlockId: row.id,
      title: row.title ?? row.taskTitle ?? null,
      startsAt: row.startsAt,
      state,
      error: row.error,
    });
    if (out.length >= limit) break;
  }
  return out;
}

// Chooses which discovered calendars are read. Newly chosen calendars start over with a full
// sync; calendars that were turned off stop being read and their imported events are canceled
// (kept, as canceled, so history is intact and turning the calendar back on revives them).
export async function selectCalendars(
  db: Database,
  actor: Actor,
  selectedIds: readonly string[],
): Promise<{ selected: number; deselected: number }> {
  const now = actor.now ?? new Date();
  return db.transaction(async (tx) => {
    const rows = await tx
      .select({
        id: syncedCalendars.id,
        selected: syncedCalendars.selected,
        accountStatus: calendarAccounts.status,
      })
      .from(syncedCalendars)
      .innerJoin(calendarAccounts, eq(calendarAccounts.id, syncedCalendars.accountId))
      .where(and(eq(syncedCalendars.ownerId, actor.ownerId), eq(syncedCalendars.kind, "external")))
      .for("update");
    const known = new Set(rows.map((r) => r.id));
    for (const id of selectedIds) {
      if (!known.has(id)) throw new CalendarError("invalid", "Unknown calendar.");
    }
    const wanted = new Set(selectedIds);
    let selected = 0;
    let deselected = 0;
    for (const row of rows) {
      if (row.accountStatus !== "connected") continue;
      const want = wanted.has(row.id);
      if (want === row.selected) continue;
      if (want) {
        selected++;
        await tx
          .update(syncedCalendars)
          .set({
            selected: true,
            syncToken: null,
            fullSyncedAt: null,
            lastAttemptAt: null,
            syncStatus: "pending",
            lastError: null,
          })
          .where(eq(syncedCalendars.id, row.id));
      } else {
        deselected++;
        await detachImportedEvents(tx, actor.ownerId, row.id, now, "calendar_deselected");
        await tx
          .update(syncedCalendars)
          .set({
            selected: false,
            syncToken: null,
            fullSyncedAt: null,
            syncStatus: "pending",
            lastError: null,
          })
          .where(eq(syncedCalendars.id, row.id));
      }
      await recordAction(tx, actor, {
        action: want ? "calendar.select" : "calendar.deselect",
        entityType: "synced_calendar",
        entityId: row.id,
      });
    }
    return { selected, deselected };
  });
}

type Writer = Database | Parameters<Parameters<Database["transaction"]>[0]>[0];

// Cancels the local copies of events imported from one calendar and marks their references
// detached (etag cleared) so reselecting the calendar revives them without creating duplicates.
// Epiphany-owned references are untouched, and nothing is ever changed at the provider.
export async function detachImportedEvents(
  tx: Writer,
  ownerId: string,
  calendarId: string,
  now: Date,
  reason: string,
): Promise<number> {
  const refs = await tx
    .select({ id: calendarEventRefs.id, eventId: calendarEventRefs.eventId })
    .from(calendarEventRefs)
    .where(
      and(
        eq(calendarEventRefs.ownerId, ownerId),
        eq(calendarEventRefs.calendarId, calendarId),
        eq(calendarEventRefs.ownership, "external"),
      ),
    );
  const eventIds = refs.flatMap((r) => (r.eventId ? [r.eventId] : []));
  if (eventIds.length > 0) {
    await tx
      .update(events)
      .set({ status: "canceled", canceledAt: now, version: sql`${events.version} + 1` })
      .where(
        and(
          eq(events.ownerId, ownerId),
          inArray(events.id, eventIds),
          eq(events.status, "scheduled"),
        ),
      );
  }
  if (refs.length > 0) {
    await tx
      .update(calendarEventRefs)
      .set({ syncState: "detached", etag: null, lastError: reason })
      .where(
        and(
          eq(calendarEventRefs.ownerId, ownerId),
          eq(calendarEventRefs.calendarId, calendarId),
          eq(calendarEventRefs.ownership, "external"),
        ),
      );
  }
  return refs.length;
}

export interface ConnectInput {
  provider: "google";
  providerAccountId: string;
  email: string | null;
  scopes: string;
  accessTokenEnc: string;
  refreshTokenEnc: string;
  accessTokenExpiresAt: Date;
}

// Stores or refreshes the (already encrypted) tokens of an account. Connecting a different Google
// account while one is connected is refused; disconnect first.
export async function saveConnectedAccount(
  db: Database,
  actor: Actor,
  input: Omit<ConnectInput, "accessTokenEnc" | "refreshTokenEnc"> & {
    encrypt: (accountId: string) => { accessTokenEnc: string; refreshTokenEnc: string };
  },
): Promise<string> {
  const now = actor.now ?? new Date();
  return db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(calendarAccounts)
      .where(
        and(
          eq(calendarAccounts.ownerId, actor.ownerId),
          eq(calendarAccounts.provider, input.provider),
        ),
      )
      .for("update");
    const sameAccount = existing.find((a) => a.providerAccountId === input.providerAccountId);
    const other = existing.find(
      (a) => a.providerAccountId !== input.providerAccountId && a.status !== "revoked",
    );
    if (other) {
      throw new CalendarError(
        "account_mismatch",
        "A different Google account is already connected. Disconnect it first.",
      );
    }
    const accountId = sameAccount?.id ?? newId();
    const tokens = input.encrypt(accountId);
    const values = {
      accountEmail: input.email,
      status: "connected" as const,
      scopes: input.scopes,
      accessTokenEnc: tokens.accessTokenEnc,
      refreshTokenEnc: tokens.refreshTokenEnc,
      accessTokenExpiresAt: input.accessTokenExpiresAt,
      lastError: null,
      connectedAt: now,
      disconnectedAt: null,
    };
    if (sameAccount) {
      await tx
        .update(calendarAccounts)
        .set({ ...values, version: sameAccount.version + 1 })
        .where(eq(calendarAccounts.id, accountId));
      await tx
        .update(syncedCalendars)
        .set({ syncToken: null, fullSyncedAt: null, lastAttemptAt: null, syncStatus: "pending" })
        .where(eq(syncedCalendars.accountId, accountId));
    } else {
      await tx.insert(calendarAccounts).values({
        id: accountId,
        ownerId: actor.ownerId,
        provider: input.provider,
        providerAccountId: input.providerAccountId,
        ...values,
      });
    }
    await recordAction(tx, actor, {
      action: "calendar.connect",
      entityType: "calendar_account",
      entityId: accountId,
      after: { provider: input.provider, scopes: input.scopes.split(/\s+/) },
    });
    return accountId;
  });
}

export interface DisconnectedAccount {
  id: string;
  refreshTokenEnc: string | null;
  accessTokenEnc: string | null;
}

// Ends access immediately: the tokens are wiped and the account marked revoked in one statement
// (the CHECK constraint forbids a revoked account holding tokens), imported events are canceled and
// every calendar's cursor is dropped. Returns the encrypted tokens it removed so the caller can
// revoke them at Google afterwards (best effort).
export async function wipeAccounts(db: Database, actor: Actor): Promise<DisconnectedAccount[]> {
  const now = actor.now ?? new Date();
  return db.transaction(async (tx) => {
    const accounts = await tx
      .select({
        id: calendarAccounts.id,
        refreshTokenEnc: calendarAccounts.refreshTokenEnc,
        accessTokenEnc: calendarAccounts.accessTokenEnc,
      })
      .from(calendarAccounts)
      .where(
        and(eq(calendarAccounts.ownerId, actor.ownerId), ne(calendarAccounts.status, "revoked")),
      )
      .for("update");
    for (const account of accounts) {
      await tx
        .update(calendarAccounts)
        .set({
          status: "revoked",
          accessTokenEnc: null,
          refreshTokenEnc: null,
          accessTokenExpiresAt: null,
          lastError: null,
          disconnectedAt: now,
          version: sql`${calendarAccounts.version} + 1`,
        })
        .where(eq(calendarAccounts.id, account.id));
      const calendars = await tx
        .select({ id: syncedCalendars.id })
        .from(syncedCalendars)
        .where(eq(syncedCalendars.accountId, account.id));
      for (const calendar of calendars) {
        await detachImportedEvents(tx, actor.ownerId, calendar.id, now, "disconnected");
      }
      await tx
        .update(syncedCalendars)
        .set({ syncToken: null, fullSyncedAt: null, syncStatus: "pending", lastError: null })
        .where(eq(syncedCalendars.accountId, account.id));
      await recordAction(tx, actor, {
        action: "calendar.disconnect",
        entityType: "calendar_account",
        entityId: account.id,
      });
    }
    return accounts;
  });
}

export async function hasActiveAccount(db: Database, ownerId: string): Promise<boolean> {
  const rows = await db
    .select({ id: calendarAccounts.id })
    .from(calendarAccounts)
    .where(
      and(
        eq(calendarAccounts.ownerId, ownerId),
        eq(calendarAccounts.status, "connected"),
        isNull(calendarAccounts.disconnectedAt),
      ),
    )
    .limit(1);
  return rows.length > 0;
}
