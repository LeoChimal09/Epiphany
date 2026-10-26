import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  completeTask,
  connectDatabase,
  createOwner,
  createTask,
  createWorkBlock,
  removeWorkBlock,
} from "../db";
import type { DatabaseHandle } from "../db/client";
import { runMigrations } from "../db/migrate";
import {
  createTestDatabase,
  dbTestsEnabled,
  MIGRATIONS_FOLDER,
  type TestDatabase,
} from "../db/test-support";
import { connectAccount, disconnectAccounts, getAccessToken, type CalendarRuntime } from "./access";
import { FakeGoogle } from "./fake-google";
import { scopesFor, type CalendarAccessMode } from "./google/oauth";
import { selectCalendars, loadCalendarOverview, CalendarError } from "./store";
import { assertOwnWrite, eventIdFor, resolveBlockConflict, syncAccount, syncKeyFor } from "./sync";

const OWNER_CAL = "owner@example.test";
const T0 = new Date("2026-10-20T15:00:00.000Z");

interface Harness {
  handle: DatabaseHandle;
  google: FakeGoogle;
  clock: { current: Date };
  rt: CalendarRuntime;
  ownerId: string;
  accountId: string;
  actor: () => { ownerId: string; source: "dashboard"; now: Date };
  query: (sql: string, params?: unknown[]) => Promise<Array<Record<string, unknown>>>;
  connect: (ownerId: string, mode?: CalendarAccessMode, sub?: string) => Promise<string>;
  syncOnce: (options?: { force?: boolean }) => ReturnType<typeof syncAccount>;
}

// One disposable database per file (migrating is the slow part); tables are emptied before each
// test. Only tables of the throwaway database are touched.
let shared: { database: TestDatabase; handle: DatabaseHandle } | undefined;

const WIPE = [
  "calendar_event_refs",
  "synced_calendars",
  "calendar_accounts",
  "work_blocks",
  "tasks",
  "events",
  "action_history",
  "categories",
  "owners",
];

async function harness(mode: CalendarAccessMode = "readwrite"): Promise<Harness> {
  const { handle } = shared!;
  for (const table of WIPE) await handle.pool.query(`DELETE FROM \`${table}\``);
  const owner = await createOwner(handle.db, {
    displayName: "Owner",
    discordUserId: "100000000000000001",
  });
  const google = new FakeGoogle();
  const clock = { current: new Date(T0) };
  const rt: CalendarRuntime = {
    db: handle.db,
    tokenKey: randomBytes(32),
    clientId: "client-id",
    clientSecret: "placeholder-client-secret",
    fetch: google.fetch,
    now: () => clock.current,
    sleep: async () => undefined,
    random: () => 0.5,
  };
  const actorFor = (ownerId: string) => ({
    ownerId,
    source: "dashboard" as const,
    now: clock.current,
  });
  const connect = async (
    ownerId: string,
    m: CalendarAccessMode = "readwrite",
    sub = "google-sub-1",
  ) => {
    const token = `initial-${sub}`;
    google.validAccessTokens.add(token);
    return connectAccount(rt, actorFor(ownerId), {
      providerAccountId: sub,
      email: "owner@example.test",
      scopes: scopesFor(m),
      accessToken: token,
      refreshToken: `refresh-${sub}`,
      accessTokenExpiresAt: new Date(clock.current.getTime() + 3600_000),
    });
  };
  const accountId = await connect(owner.id, mode);
  return {
    handle,
    google,
    clock,
    rt,
    ownerId: owner.id,
    accountId,
    actor: () => actorFor(owner.id),
    query: async (sql, params = []) =>
      (await handle.pool.query(sql, params))[0] as Array<Record<string, unknown>>,
    connect,
    syncOnce: (options) => syncAccount(rt, accountId, options),
  };
}

const timed = (start: string, end: string) => ({
  start: { dateTime: start, timeZone: "America/Chicago" },
  end: { dateTime: end, timeZone: "America/Chicago" },
});

describe.skipIf(!dbTestsEnabled)("Google Calendar sync", () => {
  let h: Harness;
  beforeAll(async () => {
    const database = await createTestDatabase();
    const handle = connectDatabase(database.url);
    await runMigrations(handle.pool, MIGRATIONS_FOLDER);
    shared = { database, handle };
  });
  afterAll(async () => {
    if (!shared) return;
    await shared.handle.close();
    await shared.database.drop();
    if (await shared.database.exists()) throw new Error("test database was not dropped");
  });
  beforeEach(async () => {
    h = await harness();
  });

  const events = () => h.query("SELECT * FROM events ORDER BY starts_at, title");
  const refs = () => h.query("SELECT * FROM calendar_event_refs ORDER BY external_id");
  const epiphanyCalendar = () => h.google.findCalendarBySummary("Epiphany")!;
  const selectAll = async () => {
    const calendars = await h.query("SELECT id FROM synced_calendars WHERE kind = 'external'");
    await selectCalendars(
      h.handle.db,
      h.actor(),
      calendars.map((c) => String(c.id)),
    );
  };

  describe("connecting and tokens", () => {
    it("stores only ciphertext and decrypts through the access path", async () => {
      const [account] = await h.query("SELECT * FROM calendar_accounts");
      expect(account!.status).toBe("connected");
      expect(String(account!.access_token_enc)).toMatch(/^v1\./);
      expect(JSON.stringify(account)).not.toContain("refresh-google-sub-1");
      expect(JSON.stringify(account)).not.toContain("initial-google-sub-1");
      expect(await getAccessToken(h.rt, h.accountId)).toBe("initial-google-sub-1");
    });

    it("refuses tokens that were copied to another account row", async () => {
      const other = await createOwner(h.handle.db, { displayName: "Other" });
      const otherAccount = await h.connect(other.id, "read", "google-sub-2");
      const [mine] = await h.query("SELECT access_token_enc FROM calendar_accounts WHERE id = ?", [
        h.accountId,
      ]);
      await h.query("UPDATE calendar_accounts SET access_token_enc = ? WHERE id = ?", [
        mine!.access_token_enc,
        otherAccount,
      ]);
      await expect(getAccessToken(h.rt, otherAccount)).rejects.toThrow(/decrypted/);
    });

    it("refreshes an expired access token", async () => {
      h.clock.current = new Date(T0.getTime() + 2 * 3600_000);
      const token = await getAccessToken(h.rt, h.accountId);
      expect(token).toMatch(/^access-/);
      expect(h.google.refreshCount).toBe(1);
      expect(await getAccessToken(h.rt, h.accountId)).toBe(token);
      expect(h.google.refreshCount).toBe(1);
    });

    it("needs a refresh token", async () => {
      await expect(
        connectAccount(h.rt, h.actor(), {
          providerAccountId: "sub-x",
          email: null,
          scopes: scopesFor("read"),
          accessToken: "a",
          refreshToken: null,
          accessTokenExpiresAt: T0,
        }),
      ).rejects.toMatchObject({ code: "no_refresh_token" });
    });

    it("refuses a second, different Google account while one is connected", async () => {
      await expect(h.connect(h.ownerId, "read", "google-sub-other")).rejects.toMatchObject({
        code: "account_mismatch",
      });
    });
  });

  describe("pulling events", () => {
    it("discovers calendars, reads the primary by default, and creates the Epiphany calendar once", async () => {
      const report = await h.syncOnce();
      expect(report.status).toBe("ok");
      const calendars = await h.query(
        "SELECT summary, kind, selected FROM synced_calendars ORDER BY summary",
      );
      expect(calendars).toEqual([
        { summary: "Epiphany", kind: "epiphany", selected: 1 },
        { summary: "Owner", kind: "external", selected: 1 },
      ]);
      await h.syncOnce({ force: true });
      await h.syncOnce({ force: true });
      expect(
        h.google.calls.filter((c) => c.method === "POST" && c.path === "/calendars"),
      ).toHaveLength(1);
      expect([...h.google.calendars.values()].filter((c) => c.summary === "Epiphany")).toHaveLength(
        1,
      );
    });

    it("reuses an existing Epiphany calendar instead of creating another", async () => {
      h.google.addCalendar({ id: "existing-epiphany", summary: "Epiphany" });
      await h.syncOnce();
      expect(h.google.calls.some((c) => c.method === "POST" && c.path === "/calendars")).toBe(
        false,
      );
      const [account] = await h.query("SELECT epiphany_calendar_id FROM calendar_accounts");
      expect(account!.epiphany_calendar_id).toBe("existing-epiphany");
    });

    it("imports timed, all-day, timezone, and recurring events idempotently", async () => {
      h.google.addEvent(OWNER_CAL, {
        id: "timed1",
        summary: "Chemistry lab",
        location: "Room 4",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:30:00-05:00"),
      });
      h.google.addEvent(OWNER_CAL, {
        id: "allday1",
        summary: "Fall break",
        start: { date: "2026-10-23" },
        end: { date: "2026-10-25" },
      });
      h.google.addEvent(OWNER_CAL, {
        id: "paris1",
        summary: "Call",
        start: { dateTime: "2026-10-22T16:00:00+02:00", timeZone: "Europe/Paris" },
        end: { dateTime: "2026-10-22T17:00:00+02:00", timeZone: "Europe/Paris" },
      });
      for (const day of [26, 27, 28]) {
        h.google.addEvent(OWNER_CAL, {
          id: `series1_202610${day}T150000Z`,
          summary: "Standup",
          recurringEventId: "series1",
          originalStartTime: { dateTime: `2026-10-${day}T10:00:00-05:00` },
          ...timed(`2026-10-${day}T10:00:00-05:00`, `2026-10-${day}T10:15:00-05:00`),
        });
      }
      h.google.addEvent(OWNER_CAL, {
        id: "series1_20261029T150000Z",
        summary: "Standup",
        recurringEventId: "series1",
        status: "cancelled",
        originalStartTime: { dateTime: "2026-10-29T10:00:00-05:00" },
      });

      const first = await h.syncOnce();
      expect(first.imported).toBe(6);
      const rows = await events();
      expect(rows).toHaveLength(6);
      const byTitle = (t: string) => rows.filter((r) => r.title === t);
      expect(byTitle("Chemistry lab")[0]).toMatchObject({
        all_day: 0,
        location: "Room 4",
        timezone: "America/Chicago",
        status: "scheduled",
      });
      expect((byTitle("Chemistry lab")[0]!.starts_at as Date).toISOString()).toBe(
        "2026-10-21T19:00:00.000Z",
      );
      expect(byTitle("Fall break")[0]).toMatchObject({ all_day: 1, timezone: "America/Chicago" });
      expect((byTitle("Fall break")[0]!.starts_at as Date).toISOString()).toBe(
        "2026-10-23T05:00:00.000Z",
      );
      expect((byTitle("Fall break")[0]!.ends_at as Date).toISOString()).toBe(
        "2026-10-25T05:00:00.000Z",
      );
      expect(byTitle("Call")[0]).toMatchObject({ timezone: "Europe/Paris" });
      expect(byTitle("Standup")).toHaveLength(3);

      const standupRefs = (await refs()).filter((r) => r.recurring_event_id === "series1");
      expect(standupRefs).toHaveLength(3);
      expect(
        standupRefs.every((r) => r.original_start_at !== null && r.ownership === "external"),
      ).toBe(true);

      const snapshot = JSON.stringify([
        await events(),
        await refs(),
        await h.query("SELECT id FROM action_history"),
      ]);
      const second = await h.syncOnce({ force: true });
      expect(second).toMatchObject({ imported: 0, updated: 0, canceled: 0 });
      expect(
        JSON.stringify([
          await events(),
          await refs(),
          await h.query("SELECT id FROM action_history"),
        ]),
      ).toBe(snapshot);
    });

    it("applies incremental changes: edits update, deletions cancel, and nothing duplicates", async () => {
      h.google.addEvent(OWNER_CAL, {
        id: "e1",
        summary: "Seminar",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      h.google.addEvent(OWNER_CAL, {
        id: "e2",
        summary: "Dentist",
        ...timed("2026-10-22T14:00:00-05:00", "2026-10-22T15:00:00-05:00"),
      });
      await h.syncOnce();
      h.google.editEvent(OWNER_CAL, "e1", {
        summary: "Seminar (moved)",
        ...timed("2026-10-21T16:00:00-05:00", "2026-10-21T17:00:00-05:00"),
      });
      h.google.removeEvent(OWNER_CAL, "e2");
      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      h.google.clearCalls();
      const report = await h.syncOnce();
      expect(
        h.google.calls.find((c) => c.path.endsWith("/events") && c.query.syncToken),
      ).toBeTruthy();
      expect(report).toMatchObject({ imported: 0, updated: 1, canceled: 1 });
      const rows = await events();
      expect(rows).toHaveLength(2);
      expect(rows.find((r) => r.title === "Seminar (moved)")).toBeTruthy();
      expect(rows.find((r) => r.title === "Dentist")).toMatchObject({ status: "canceled" });
    });

    it("starts over with a full sync on 410 Gone without duplicating events", async () => {
      h.google.addEvent(OWNER_CAL, {
        id: "e1",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      await h.syncOnce();
      h.google.expireSyncTokens();
      h.google.addEvent(OWNER_CAL, {
        id: "e3",
        ...timed("2026-10-23T14:00:00-05:00", "2026-10-23T15:00:00-05:00"),
      });
      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      const report = await h.syncOnce();
      expect(report.status).toBe("ok");
      expect(report.imported).toBe(1);
      expect(await events()).toHaveLength(2);
    });

    it("pages through large calendars", async () => {
      h.google.pageSize = 3;
      for (let i = 0; i < 8; i++) {
        h.google.addEvent(OWNER_CAL, {
          id: `p${i}`,
          ...timed(
            `2026-10-2${i % 8}T14:00:00-05:00`.replace("20-", "21-"),
            "2026-10-29T15:00:00-05:00",
          ),
        });
      }
      expect((await h.syncOnce()).imported).toBe(8);
    });

    it("cancels events that disappeared from a full listing, and revives them when they return", async () => {
      const gone = h.google.addEvent(OWNER_CAL, {
        id: "g1",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      await h.syncOnce();
      h.google.calendars.get(OWNER_CAL)!.events.delete(gone.id);
      await h.syncOnce({ force: true });
      h.clock.current = new Date(T0.getTime() + 8 * 24 * 3600_000);
      await h.syncOnce({ force: true });
      expect((await events())[0]).toMatchObject({ status: "canceled" });
      h.google.addEvent(OWNER_CAL, {
        id: "g1",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      h.clock.current = new Date(T0.getTime() + 9 * 24 * 3600_000);
      await h.syncOnce({ force: true });
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "scheduled" });
    });

    it("records a provider outage visibly, keeps old data, and recovers", async () => {
      h.google.addEvent(OWNER_CAL, {
        id: "e1",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      await h.syncOnce();
      h.google.fail((c) => c.path === "/users/me/calendarList", { status: 500 }, 4);
      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      const down = await h.syncOnce();
      expect(down.status).toBe("error");
      let overview = await loadCalendarOverview(h.handle.db, h.ownerId, h.clock.current);
      expect(overview.account!.status).toBe("connected");
      expect(overview.account!.lastError).toMatch(/500|Google/);
      expect(await events()).toHaveLength(1);

      h.google.clearCalls();
      h.clock.current = new Date(T0.getTime() + 12 * 60_000);
      expect((await h.syncOnce({ force: true })).status).toBe("ok");
      overview = await loadCalendarOverview(h.handle.db, h.ownerId, h.clock.current);
      expect(overview.account!.lastError).toBeNull();
    });

    it("shows data older than 20 minutes as stale, and a failing calendar as stale or error", async () => {
      await h.syncOnce();
      let overview = await loadCalendarOverview(h.handle.db, h.ownerId, h.clock.current);
      expect(overview.calendars.find((c) => c.kind === "external")!.syncStatus).toBe("ok");
      overview = await loadCalendarOverview(
        h.handle.db,
        h.ownerId,
        new Date(T0.getTime() + 30 * 60_000),
      );
      expect(overview.calendars.find((c) => c.kind === "external")!.syncStatus).toBe("stale");

      h.google.fail((c) => c.path.endsWith("/events"), { status: 500 }, 20);
      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      const report = await h.syncOnce();
      expect(report.errors.length).toBeGreaterThan(0);
      overview = await loadCalendarOverview(h.handle.db, h.ownerId, h.clock.current);
      const external = overview.calendars.find((c) => c.kind === "external")!;
      expect(external.syncStatus).toBe("stale");
      expect(external.lastError).toBeTruthy();
    });

    it("stops reading a deselected calendar (events canceled, not deleted) and revives on reselect", async () => {
      h.google.addEvent(OWNER_CAL, {
        id: "e1",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      await h.syncOnce();
      await selectCalendars(h.handle.db, h.actor(), []);
      expect((await events())[0]).toMatchObject({ status: "canceled" });
      h.google.clearCalls();
      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      await h.syncOnce();
      expect(
        h.google.calls.filter(
          (c) => c.path === `/calendars/${encodeURIComponent(OWNER_CAL)}/events`,
        ),
      ).toHaveLength(0);

      await selectAll();
      h.clock.current = new Date(T0.getTime() + 12 * 60_000);
      await h.syncOnce();
      const rows = await events();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ status: "scheduled" });
      expect(await refs()).toHaveLength(1);
    });
  });

  describe("pushing work blocks", () => {
    const makeBlock = (
      title = "Study chemistry",
      start = "2026-10-21T20:00:00.000Z",
      end = "2026-10-21T21:00:00.000Z",
    ) =>
      createWorkBlock(h.handle.db, h.actor(), {
        title,
        startsAt: new Date(start),
        endsAt: new Date(end),
      });

    it("creates, updates, and removes the Epiphany event without duplicates", async () => {
      const block = await makeBlock();
      await h.syncOnce();
      const calendar = epiphanyCalendar();
      expect(calendar.events.size).toBe(1);
      const event = calendar.events.get(eventIdFor(block.id))!;
      expect(event).toMatchObject({ summary: "Study chemistry", status: "confirmed" });
      expect(event.extendedProperties?.private?.epiphanyKey).toBe(syncKeyFor(block.id));

      h.google.clearCalls();
      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      await h.syncOnce();
      await h.syncOnce({ force: true });
      expect(h.google.writes()).toHaveLength(0);
      expect(calendar.events.size).toBe(1);

      await h.query(
        "UPDATE work_blocks SET title = 'Study chemistry (chapter 5)', version = version + 1 WHERE id = ?",
        [block.id],
      );
      h.clock.current = new Date(T0.getTime() + 12 * 60_000);
      const updated = await h.syncOnce();
      expect(updated.pushed.updated).toBe(1);
      expect(calendar.events.size).toBe(1);
      expect(calendar.events.get(eventIdFor(block.id))!.summary).toBe(
        "Study chemistry (chapter 5)",
      );
      expect(h.google.writes().at(-1)!.ifMatch).toBeTruthy();

      await removeWorkBlock(h.handle.db, h.actor(), block.id);
      h.clock.current = new Date(T0.getTime() + 18 * 60_000);
      const removed = await h.syncOnce();
      expect(removed.pushed.removed).toBe(1);
      expect(calendar.events.get(eventIdFor(block.id))!.status).toBe("cancelled");
      expect((await refs())[0]).toMatchObject({ sync_state: "removed" });
      h.google.clearCalls();
      await h.syncOnce({ force: true });
      expect(h.google.writes()).toHaveLength(0);
    });

    it("writes only to the dedicated Epiphany calendar, never to the owner's calendars", async () => {
      h.google.addEvent(OWNER_CAL, {
        id: "e1",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      const before = JSON.stringify([...h.google.calendars.get(OWNER_CAL)!.events.values()]);
      await makeBlock();
      await h.syncOnce();
      await h.syncOnce({ force: true });
      const epiphanyId = epiphanyCalendar().id;
      for (const call of h.google.writes()) {
        expect(
          call.path.startsWith(`/calendars/${encodeURIComponent(epiphanyId)}/events`) ||
            call.path === "/calendars",
        ).toBe(true);
      }
      expect(JSON.stringify([...h.google.calendars.get(OWNER_CAL)!.events.values()])).toBe(before);
    });

    it("never imports its own events back (no sync loop)", async () => {
      await makeBlock();
      await h.syncOnce();
      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      const second = await h.syncOnce({ force: true });
      expect(second.imported).toBe(0);
      expect(await events()).toHaveLength(0);

      // A copy that carries Epiphany's key in another calendar is not imported either.
      h.google.addEvent(OWNER_CAL, {
        id: "copy",
        extendedProperties: { private: { epiphanyKey: "wb:something" } },
        ...timed("2026-10-21T20:00:00Z", "2026-10-21T21:00:00Z"),
      });
      h.clock.current = new Date(T0.getTime() + 12 * 60_000);
      await h.syncOnce({ force: true });
      expect(await events()).toHaveLength(0);
    });

    it("does not write at all with read-only access", async () => {
      h = await harness("read");
      await makeBlock();
      await h.syncOnce();
      expect(h.google.writes()).toHaveLength(0);
      expect(h.google.findCalendarBySummary("Epiphany")).toBeUndefined();
    });

    it("refuses to write anywhere except the dedicated calendar", () => {
      const account = { epiphanyCalendarId: "epi-cal", scopes: scopesFor("readwrite").join(" ") };
      expect(() =>
        assertOwnWrite(account, { externalId: "epi-cal", kind: "epiphany" }),
      ).not.toThrow();
      expect(() =>
        assertOwnWrite(account, { externalId: "owner@example.test", kind: "external" }),
      ).toThrow(CalendarError);
      expect(() => assertOwnWrite(account, { externalId: "other", kind: "epiphany" })).toThrow(
        CalendarError,
      );
      expect(() =>
        assertOwnWrite(
          { ...account, scopes: scopesFor("read").join(" ") },
          { externalId: "epi-cal", kind: "epiphany" },
        ),
      ).toThrow(CalendarError);
      expect(() =>
        assertOwnWrite(
          { ...account, epiphanyCalendarId: null },
          { externalId: "x", kind: "epiphany" },
        ),
      ).toThrow(CalendarError);
    });

    describe("conflicts", () => {
      it("flags a concurrent external edit as a conflict and never overwrites it", async () => {
        const block = await makeBlock();
        await h.syncOnce();
        const calendar = epiphanyCalendar();
        h.google.editEvent(calendar.id, eventIdFor(block.id), {
          summary: "Moved by the owner in Google",
          ...timed("2026-10-22T20:00:00Z", "2026-10-22T21:00:00Z"),
        });
        await h.query(
          "UPDATE work_blocks SET title = 'Epiphany changed it too', version = version + 1 WHERE id = ?",
          [block.id],
        );

        h.clock.current = new Date(T0.getTime() + 6 * 60_000);
        h.google.clearCalls();
        const report = await h.syncOnce();
        expect(report.conflicts).toBe(1);
        expect(h.google.writes()).toHaveLength(0);
        expect(calendar.events.get(eventIdFor(block.id))!.summary).toBe(
          "Moved by the owner in Google",
        );
        expect((await refs())[0]).toMatchObject({ sync_state: "conflict" });

        const overview = await loadCalendarOverview(h.handle.db, h.ownerId, h.clock.current);
        expect(overview.conflicts).toBe(1);
        expect(overview.blocks[0]).toMatchObject({ workBlockId: block.id, state: "conflict" });

        // It stays a conflict on later runs.
        h.clock.current = new Date(T0.getTime() + 12 * 60_000);
        await h.syncOnce({ force: true });
        expect(h.google.writes()).toHaveLength(0);
      });

      it("treats a 412 at write time (edit between read and write) as a conflict too", async () => {
        const block = await makeBlock();
        await h.syncOnce();
        const calendar = epiphanyCalendar();
        h.google.editEvent(calendar.id, eventIdFor(block.id), {
          summary: "Edited right before the write",
        });
        await h.query(
          "UPDATE work_blocks SET title = 'New title', version = version + 1 WHERE id = ?",
          [block.id],
        );
        h.clock.current = new Date(T0.getTime() + 1_000);
        const report = await h.syncOnce();
        expect(report.conflicts).toBe(1);
        expect(calendar.events.get(eventIdFor(block.id))!.summary).toBe(
          "Edited right before the write",
        );
        expect((await refs())[0]).toMatchObject({ sync_state: "conflict" });
      });

      it("keeps a block that was deleted in Google, and says so", async () => {
        const block = await makeBlock();
        await h.syncOnce();
        h.google.removeEvent(epiphanyCalendar().id, eventIdFor(block.id));
        h.clock.current = new Date(T0.getTime() + 6 * 60_000);
        await h.syncOnce();
        expect((await refs())[0]).toMatchObject({ sync_state: "remote_deleted" });
        expect(await h.query("SELECT status FROM work_blocks WHERE id = ?", [block.id])).toEqual([
          { status: "planned" },
        ]);
        h.clock.current = new Date(T0.getTime() + 12 * 60_000);
        h.google.clearCalls();
        await h.syncOnce({ force: true });
        expect(h.google.writes()).toHaveLength(0);
      });

      it("resolves a conflict only on the owner's explicit choice", async () => {
        const block = await makeBlock();
        await h.syncOnce();
        const calendar = epiphanyCalendar();
        h.google.editEvent(calendar.id, eventIdFor(block.id), { summary: "Edited in Google" });
        h.clock.current = new Date(T0.getTime() + 6 * 60_000);
        await h.syncOnce();
        await expect(
          resolveBlockConflict(h.rt, h.actor(), block.id, "overwrite_google"),
        ).resolves.toBe("pending");
        h.clock.current = new Date(T0.getTime() + 12 * 60_000);
        await h.syncOnce();
        expect(calendar.events.get(eventIdFor(block.id))!.summary).toBe("Study chemistry");
        expect((await refs())[0]).toMatchObject({ sync_state: "synced" });

        h.google.editEvent(calendar.id, eventIdFor(block.id), { summary: "Edited again" });
        h.clock.current = new Date(T0.getTime() + 18 * 60_000);
        await h.syncOnce();
        await expect(resolveBlockConflict(h.rt, h.actor(), block.id, "keep_google")).resolves.toBe(
          "detached",
        );
        h.google.clearCalls();
        h.clock.current = new Date(T0.getTime() + 24 * 60_000);
        await h.syncOnce({ force: true });
        expect(h.google.writes()).toHaveLength(0);
        expect(calendar.events.get(eventIdFor(block.id))!.summary).toBe("Edited again");
        await expect(
          resolveBlockConflict(h.rt, h.actor(), block.id, "keep_google"),
        ).rejects.toMatchObject({ code: "invalid" });
      });
    });

    describe("uncertain writes", () => {
      it("reconciles a create that timed out after it landed: found by key, not created twice", async () => {
        const block = await makeBlock();
        h.google.fail(
          (c) => c.method === "POST" && c.path.endsWith("/events"),
          "timeout-after-apply",
        );
        const first = await h.syncOnce();
        expect(first.uncertain).toBe(1);
        expect((await refs())[0]).toMatchObject({ sync_state: "uncertain" });
        const calendar = epiphanyCalendar();
        expect(calendar.events.size).toBe(1);

        h.google.clearCalls();
        h.clock.current = new Date(T0.getTime() + 6 * 60_000);
        await h.syncOnce();
        const inserts = h.google.calls.filter(
          (c) => c.method === "POST" && c.path.endsWith("/events"),
        );
        expect(inserts).toHaveLength(0);
        expect(
          h.google.calls.some(
            (c) => c.query.privateExtendedProperty === `epiphanyKey=${syncKeyFor(block.id)}`,
          ),
        ).toBe(true);
        expect(calendar.events.size).toBe(1);
        expect((await refs())[0]).toMatchObject({ sync_state: "synced" });
        expect((await refs())[0]!.etag).toBe(calendar.events.get(eventIdFor(block.id))!.etag);
      });

      it("creates exactly once after a create that never landed", async () => {
        await makeBlock();
        h.google.fail(
          (c) => c.method === "POST" && c.path.endsWith("/events"),
          "timeout-before-apply",
        );
        await h.syncOnce();
        const calendar = epiphanyCalendar();
        expect(calendar.events.size).toBe(0);
        h.clock.current = new Date(T0.getTime() + 6 * 60_000);
        await h.syncOnce();
        await h.syncOnce({ force: true });
        expect(calendar.events.size).toBe(1);
        expect((await refs())[0]).toMatchObject({ sync_state: "synced" });
      });

      it("reconciles an update that timed out after it landed without a false conflict", async () => {
        const block = await makeBlock();
        await h.syncOnce();
        const calendar = epiphanyCalendar();
        await h.query(
          "UPDATE work_blocks SET title = 'Retitled', version = version + 1 WHERE id = ?",
          [block.id],
        );
        h.google.fail((c) => c.method === "PUT", "timeout-after-apply");
        h.clock.current = new Date(T0.getTime() + 6 * 60_000);
        await h.syncOnce();
        expect((await refs())[0]).toMatchObject({ sync_state: "uncertain" });
        expect(calendar.events.get(eventIdFor(block.id))!.summary).toBe("Retitled");

        h.google.clearCalls();
        h.clock.current = new Date(T0.getTime() + 12 * 60_000);
        const report = await h.syncOnce();
        expect(report.conflicts).toBe(0);
        expect(h.google.writes()).toHaveLength(0);
        expect((await refs())[0]).toMatchObject({ sync_state: "synced" });
      });

      it("retries an update that timed out before it landed, once, with the right ETag", async () => {
        const block = await makeBlock();
        await h.syncOnce();
        const calendar = epiphanyCalendar();
        await h.query(
          "UPDATE work_blocks SET title = 'Retitled', version = version + 1 WHERE id = ?",
          [block.id],
        );
        h.google.fail((c) => c.method === "PUT", "timeout-before-apply");
        h.clock.current = new Date(T0.getTime() + 6 * 60_000);
        await h.syncOnce();
        h.clock.current = new Date(T0.getTime() + 12 * 60_000);
        await h.syncOnce();
        expect(calendar.events.get(eventIdFor(block.id))!.summary).toBe("Retitled");
        expect(h.google.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
        expect((await refs())[0]).toMatchObject({ sync_state: "synced" });
      });

      it("shows blocks that have not synced as pending", async () => {
        const block = await makeBlock();
        const overview = await loadCalendarOverview(h.handle.db, h.ownerId, h.clock.current);
        expect(overview.blocks).toEqual([
          expect.objectContaining({ workBlockId: block.id, state: "pending" }),
        ]);
        await h.syncOnce();
        expect(
          (await loadCalendarOverview(h.handle.db, h.ownerId, h.clock.current)).blocks,
        ).toEqual([]);
      });
    });
  });

  describe("pushing task deadlines", () => {
    const makeTask = (title: string, dueAt: Date, dueDateOnly = false) =>
      createTask(h.handle.db, h.actor(), { title, dueAt, dueDateOnly });

    it("exports date-only and timed deadlines once, and updates the existing events", async () => {
      const allDay = await makeTask(
        "Submit lab report",
        new Date("2026-10-23T00:00:00.000Z"),
        true,
      );
      const timedTask = await makeTask("Call the dentist", new Date("2026-10-23T21:00:00.000Z"));

      const first = await h.syncOnce();
      const calendar = epiphanyCalendar();
      expect(first.pushed.created).toBe(2);
      const allDayEvent = [...calendar.events.values()].find(
        (event) => event.summary === "Due: Submit lab report",
      )!;
      const timedEvent = [...calendar.events.values()].find(
        (event) => event.summary === "Due: Call the dentist",
      )!;
      expect(allDayEvent).toMatchObject({
        start: { date: "2026-10-23" },
        end: { date: "2026-10-24" },
      });
      expect(timedEvent).toMatchObject({
        start: { dateTime: "2026-10-23T21:00:00.000Z", timeZone: "America/Chicago" },
        end: { dateTime: "2026-10-23T21:15:00.000Z", timeZone: "America/Chicago" },
      });
      expect(allDayEvent.extendedProperties?.private?.epiphanyKey).toMatch(
        new RegExp(`^deadline:${allDay.id}:v`),
      );

      h.google.clearCalls();
      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      expect((await h.syncOnce({ force: true })).pushed.created).toBe(0);
      expect(h.google.writes()).toHaveLength(0);
      expect(calendar.events.size).toBe(2);

      await h.query(
        "UPDATE tasks SET title = 'Call dentist office', due_at = ?, version = version + 1 WHERE id = ?",
        ["2026-10-23 22:00:00.000", timedTask.id],
      );
      h.clock.current = new Date(T0.getTime() + 12 * 60_000);
      const updated = await h.syncOnce();
      expect(updated.pushed.updated).toBe(1);
      expect(calendar.events.size).toBe(2);
      expect(calendar.events.get(timedEvent.id)).toMatchObject({
        summary: "Due: Call dentist office",
        start: { dateTime: "2026-10-23T22:00:00.000Z" },
      });
      expect(h.google.writes().at(-1)!.ifMatch).toBeTruthy();
    });

    it("uses an estimated duration for the task's calendar time, ending at its deadline", async () => {
      const task = await createTask(h.handle.db, h.actor(), {
        title: "Study for chemistry",
        dueAt: new Date("2026-10-23T21:00:00.000Z"),
        estimatedMinutes: 360,
      });

      expect((await h.syncOnce()).pushed.created).toBe(1);
      const event = [...epiphanyCalendar().events.values()].find(
        (item) => item.summary === "Due: Study for chemistry",
      )!;
      expect(event).toMatchObject({
        start: { dateTime: "2026-10-23T15:00:00.000Z", timeZone: "America/Chicago" },
        end: { dateTime: "2026-10-23T21:00:00.000Z", timeZone: "America/Chicago" },
      });
      expect(task.estimatedMinutes).toBe(360);
    });

    it("removes deadlines when completed and creates a fresh event if the deadline is restored", async () => {
      const task = await makeTask("Return library book", new Date("2026-10-24T15:00:00.000Z"));
      await h.syncOnce();
      const calendar = epiphanyCalendar();
      const original = [...calendar.events.values()].find(
        (event) => event.summary === "Due: Return library book",
      )!;

      await completeTask(h.handle.db, h.actor(), task.id);
      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      expect((await h.syncOnce()).pushed.removed).toBe(1);
      expect(calendar.events.get(original.id)!.status).toBe("cancelled");

      await h.query(
        "UPDATE tasks SET status = 'open', completed_at = NULL, remaining_minutes = 30, version = version + 1 WHERE id = ?",
        [task.id],
      );
      h.clock.current = new Date(T0.getTime() + 12 * 60_000);
      expect((await h.syncOnce()).pushed.created).toBe(1);
      const live = [...calendar.events.values()].filter(
        (event) => event.summary === "Due: Return library book" && event.status !== "cancelled",
      );
      expect(live).toHaveLength(1);
      expect(live[0]!.id).not.toBe(original.id);
    });

    it("reconciles an uncertain deadline create without making a duplicate", async () => {
      await makeTask("Pay the bill", new Date("2026-10-24T15:00:00.000Z"));
      h.google.fail(
        (call) => call.method === "POST" && call.path.endsWith("/events"),
        "timeout-after-apply",
      );
      const first = await h.syncOnce();
      expect(first.uncertain).toBe(1);
      expect(epiphanyCalendar().events.size).toBe(1);

      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      const retry = await h.syncOnce();
      expect(retry.uncertain).toBe(0);
      expect(retry.pushed.updated).toBe(1);
      expect(epiphanyCalendar().events.size).toBe(1);
      expect((await refs()).filter((ref) => String(ref.sync_key).startsWith("deadline:"))).toEqual([
        expect.objectContaining({ sync_state: "synced" }),
      ]);
    });

    it("surfaces Google edits as conflicts instead of overwriting them", async () => {
      const task = await makeTask("Renew library card", new Date("2026-10-24T15:00:00.000Z"));
      await h.syncOnce();
      const calendar = epiphanyCalendar();
      const deadline = [...calendar.events.values()][0]!;
      h.google.editEvent(calendar.id, deadline.id, { summary: "Edited in Google" });
      await h.query(
        "UPDATE tasks SET title = 'Renew library card online', version = version + 1 WHERE id = ?",
        [task.id],
      );

      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      const report = await h.syncOnce();
      expect(report.conflicts).toBe(1);
      expect(report.errors).toEqual([
        "Changed in Google Calendar since Epiphany last wrote it. The task deadline was not overwritten.",
      ]);
      expect(calendar.events.get(deadline.id)!.summary).toBe("Edited in Google");
      expect((await refs())[0]).toMatchObject({ sync_state: "conflict" });
    });

    it("writes a task deadline only to its owner's dedicated calendar", async () => {
      await makeTask("Private deadline", new Date("2026-10-24T15:00:00.000Z"));
      const before = JSON.stringify([...h.google.calendars.get(OWNER_CAL)!.events.values()]);
      await h.syncOnce();
      expect(epiphanyCalendar().events.size).toBe(1);
      expect(JSON.stringify([...h.google.calendars.get(OWNER_CAL)!.events.values()])).toBe(before);
      expect(
        h.google
          .writes()
          .every(
            (call) =>
              call.path.startsWith(
                `/calendars/${encodeURIComponent(epiphanyCalendar().id)}/events`,
              ) || call.path === "/calendars",
          ),
      ).toBe(true);
    });

    it("does not export tasks without a due date", async () => {
      await createTask(h.handle.db, h.actor(), { title: "Unscheduled personal task" });
      const report = await h.syncOnce();
      expect(report.pushed.created).toBe(0);
      expect(epiphanyCalendar().events.size).toBe(0);
    });
  });

  describe("disconnect and revoked access", () => {
    it("deletes tokens, revokes at Google, cancels imported events, and blocks all later access", async () => {
      h.google.addEvent(OWNER_CAL, {
        id: "e1",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      await h.syncOnce();
      const result = await disconnectAccounts(h.rt, h.actor());
      expect(result).toEqual({ disconnected: 1, revokedAtGoogle: true });
      expect(h.google.revokedTokens).toEqual(["refresh-google-sub-1"]);

      const [account] = await h.query("SELECT * FROM calendar_accounts");
      expect(account).toMatchObject({
        status: "revoked",
        access_token_enc: null,
        refresh_token_enc: null,
      });
      expect(account!.disconnected_at).toBeTruthy();
      expect((await events())[0]).toMatchObject({ status: "canceled" });
      const [calendar] = await h.query(
        "SELECT sync_token FROM synced_calendars WHERE kind = 'external'",
      );
      expect(calendar!.sync_token).toBeNull();

      h.google.clearCalls();
      expect((await h.syncOnce({ force: true })).status).toBe("skipped");
      await expect(getAccessToken(h.rt, h.accountId)).rejects.toMatchObject({
        code: "not_connected",
      });
      expect(h.google.calls).toHaveLength(0);
    });

    it("keeps the account unusable even if Google cannot be reached to revoke", async () => {
      h.rt.fetch = (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      const result = await disconnectAccounts(h.rt, h.actor());
      expect(result).toEqual({ disconnected: 1, revokedAtGoogle: false });
      const [account] = await h.query(
        "SELECT status, access_token_enc, refresh_token_enc FROM calendar_accounts",
      );
      expect(account).toEqual({
        status: "revoked",
        access_token_enc: null,
        refresh_token_enc: null,
      });
    });

    it("the database itself refuses a revoked or re-authorization account that holds tokens", async () => {
      await expect(h.query("UPDATE calendar_accounts SET status = 'revoked'")).rejects.toThrow(
        /check/i,
      );
      await expect(h.query("UPDATE calendar_accounts SET status = 'needs_reauth'")).rejects.toThrow(
        /check/i,
      );
    });

    it("stops mid-sync when disconnected during the run", async () => {
      h.google.addEvent(OWNER_CAL, {
        id: "e1",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      const original = h.google.fetch;
      let disconnected = false;
      h.rt.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
        const response = await original(input, init);
        if (!disconnected && String(input).includes("calendarList")) {
          disconnected = true;
          await disconnectAccounts({ ...h.rt, fetch: original }, h.actor());
        }
        return response;
      }) as typeof fetch;
      h.google.clearCalls();
      const report = await h.syncOnce();
      expect(report.status).toBe("skipped");
      expect(h.google.calls.filter((c) => c.path.includes("/events"))).toHaveLength(0);
      expect(await events()).toHaveLength(0);
    });

    it("marks revoked or expired authorization as needing reconnection, visibly, and stops calling Google", async () => {
      await h.syncOnce();
      h.google.refreshInvalidGrant = true;
      h.clock.current = new Date(T0.getTime() + 2 * 3600_000);
      const report = await h.syncOnce({ force: true });
      expect(report.status).toBe("needs_reauth");

      const [account] = await h.query(
        "SELECT status, access_token_enc, refresh_token_enc, last_error FROM calendar_accounts",
      );
      expect(account).toMatchObject({
        status: "needs_reauth",
        access_token_enc: null,
        refresh_token_enc: null,
      });
      expect(String(account!.last_error)).toMatch(/connect/i);
      const overview = await loadCalendarOverview(h.handle.db, h.ownerId, h.clock.current);
      expect(overview.account).toMatchObject({ status: "needs_reauth" });

      h.google.clearCalls();
      expect((await h.syncOnce({ force: true })).status).toBe("skipped");
      expect(h.google.calls).toHaveLength(0);

      // Reconnecting repairs it and keeps the existing calendars and references (no duplicates).
      h.google.refreshInvalidGrant = false;
      h.google.addEvent(OWNER_CAL, {
        id: "e1",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      await h.connect(h.ownerId, "readwrite");
      expect((await h.query("SELECT id FROM calendar_accounts")).length).toBe(1);
      expect((await h.syncOnce()).status).toBe("ok");
      expect((await h.syncOnce({ force: true })).imported).toBe(0);
      expect(await events()).toHaveLength(1);
    });

    it("treats a token Google rejects even after a refresh as needing reconnection", async () => {
      await h.syncOnce();
      h.google.validAccessTokens.clear();
      h.google.fail((c) => c.path === "/users/me/calendarList", { status: 401 }, 5);
      h.clock.current = new Date(T0.getTime() + 6 * 60_000);
      const report = await h.syncOnce({ force: true });
      expect(report.status).toBe("needs_reauth");
    });
  });

  describe("owner isolation", () => {
    it("keeps another owner's calendars, events, and connection apart", async () => {
      const other = await createOwner(h.handle.db, { displayName: "Other" });
      const otherGoogle = new FakeGoogle();
      const otherRt: CalendarRuntime = { ...h.rt, fetch: otherGoogle.fetch };
      otherGoogle.validAccessTokens.add("other-token");
      const otherAccount = await connectAccount(
        otherRt,
        { ownerId: other.id, source: "dashboard", now: T0 },
        {
          providerAccountId: "other-sub",
          email: null,
          scopes: scopesFor("readwrite"),
          accessToken: "other-token",
          refreshToken: "other-refresh",
          accessTokenExpiresAt: new Date(T0.getTime() + 3600_000),
        },
      );
      otherGoogle.addEvent(OWNER_CAL, {
        id: "theirs",
        summary: "Private to the other owner",
        ...timed("2026-10-21T14:00:00-05:00", "2026-10-21T15:00:00-05:00"),
      });
      await createTask(
        h.handle.db,
        { ownerId: other.id, source: "dashboard", now: T0 },
        { title: "Other owner's deadline", dueAt: new Date("2026-10-24T15:00:00.000Z") },
      );
      await createTask(h.handle.db, h.actor(), {
        title: "My deadline",
        dueAt: new Date("2026-10-24T16:00:00.000Z"),
      });
      await syncAccount(otherRt, otherAccount);
      await h.syncOnce();
      expect(
        [...otherGoogle.findCalendarBySummary("Epiphany")!.events.values()].map(
          (event) => event.summary,
        ),
      ).toContain("Due: Other owner's deadline");
      expect(
        [...h.google.findCalendarBySummary("Epiphany")!.events.values()].map(
          (event) => event.summary,
        ),
      ).toContain("Due: My deadline");
      expect(
        [...h.google.findCalendarBySummary("Epiphany")!.events.values()].map(
          (event) => event.summary,
        ),
      ).not.toContain("Due: Other owner's deadline");

      expect(await h.query("SELECT id FROM events WHERE owner_id = ?", [h.ownerId])).toHaveLength(
        0,
      );
      expect(await h.query("SELECT id FROM events WHERE owner_id = ?", [other.id])).toHaveLength(1);
      const mine = await loadCalendarOverview(h.handle.db, h.ownerId, T0);
      const theirs = await loadCalendarOverview(h.handle.db, other.id, T0);
      expect(mine.account!.id).toBe(h.accountId);
      expect(theirs.account!.id).toBe(otherAccount);
      const theirCalendarIds = theirs.calendars.map((c) => c.id);
      await expect(selectCalendars(h.handle.db, h.actor(), theirCalendarIds)).rejects.toMatchObject(
        { code: "invalid" },
      );

      await disconnectAccounts(h.rt, h.actor());
      expect((await loadCalendarOverview(h.handle.db, other.id, T0)).account!.status).toBe(
        "connected",
      );
      expect(await getAccessToken(otherRt, otherAccount)).toBe("other-token");
    });
  });
});
