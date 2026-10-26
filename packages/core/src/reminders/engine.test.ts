import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseHandle } from "../db/client";
import { createOwner } from "../db/domain";
import { runMigrations } from "../db/migrate";
import { reminders, tasks } from "../db/schema";
import { createTestDatabase, dbTestsEnabled, type TestDatabase } from "../db/test-support";
import { createServices, issueOwnerPrincipal, type Principal } from "../services";
import { MAX_LATE_INDIVIDUAL, runReminderCycle, type DeliveryResult } from "./engine";
import { DEFAULT_REMINDER_SETTINGS, type ReminderSettings } from "./policy";
import { syncReminders } from "./schedule";
import { SENDING_STALE_MS, claimDue } from "./store";

const migrationsFolder = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));
const TZ = "America/Chicago";
const at = (iso: string) => new Date(iso);
// Due Friday Oct 16 at 5:00 PM Chicago.
const DUE = "2026-10-16T22:00:00.000Z";

describe.skipIf(!dbTestsEnabled)("reminder service against MySQL", () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;
  let ownerId: string;
  let owner: Principal;
  let services: ReturnType<typeof createServices>;
  const sent: string[] = [];
  let outcome: () => DeliveryResult = () => ({ ok: true });
  const delivery = {
    async send(text: string): Promise<DeliveryResult> {
      const result = outcome();
      if (result.ok) sent.push(text);
      return result;
    },
  };

  const settings = (over: Partial<ReminderSettings> = {}): ReminderSettings => ({
    ...DEFAULT_REMINDER_SETTINGS,
    briefingTime: null,
    ...over,
  });
  const sync = (now: string, over: Partial<ReminderSettings> = {}) =>
    syncReminders({ db: handle.db, ownerId, now: at(now), timezone: TZ, settings: settings(over) });
  const cycle = (now: string, over: Partial<ReminderSettings> = {}) =>
    runReminderCycle({
      db: handle.db,
      ownerId,
      now: at(now),
      timezone: TZ,
      settings: settings(over),
      delivery,
    });
  const rows = async () => handle.db.select().from(reminders);

  beforeEach(async () => {
    sent.length = 0;
    outcome = () => ({ ok: true });
    database = await createTestDatabase();
    handle = connectDatabase(database.url);
    await runMigrations(handle.pool, migrationsFolder);
    ownerId = (await createOwner(handle.db, { displayName: "Owner" })).id;
    owner = await issueOwnerPrincipal(handle.db, ownerId, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    services = createServices(handle.db);
  });

  afterEach(async () => {
    await handle.close();
    await database.drop();
    expect(await database.exists()).toBe(false);
  });

  const addTask = (title = "Chemistry lab report", dueAt = DUE) =>
    services.tasks.create(owner, { title, dueAt });

  describe("scheduling", () => {
    it("creates deadline reminders ahead of a task, and creates nothing new on a repeat", async () => {
      await addTask();
      const first = await sync("2026-10-14T15:00:00.000Z");
      expect(first.created).toBe(3);
      const again = await sync("2026-10-14T15:05:00.000Z");
      expect(again.created).toBe(0);
      const all = await rows();
      expect(all).toHaveLength(3);
      expect(all.map((r) => r.dueAt.toISOString()).toSorted()).toEqual([
        "2026-10-15T22:00:00.000Z",
        "2026-10-16T20:00:00.000Z",
        "2026-10-16T21:00:00.000Z",
      ]);
      expect(all[0]?.message).toContain("Chemistry lab report");
    });

    it("treats a date-only deadline as the end of that local day", async () => {
      await services.tasks.create(owner, {
        title: "Worksheet",
        dueAt: "2026-10-16T00:00:00.000Z",
        dueDateOnly: true,
      });
      await sync("2026-10-14T15:00:00.000Z");
      const times = (await rows()).map((r) => r.dueAt.toISOString()).toSorted();
      expect(times).toEqual(["2026-10-15T14:00:00.000Z", "2026-10-16T14:00:00.000Z"]);
      expect((await rows()).map((r) => r.message).join("\n")).toContain("due today");
    });

    it("schedules major deadlines two weeks ahead plus the closer configured reminders", async () => {
      const dueAt = "2026-11-04T23:00:00.000Z";
      await services.tasks.create(owner, { title: "Exam", dueAt, priority: "major" });
      await services.tasks.create(owner, { title: "Minor task", dueAt });

      await sync("2026-10-21T23:00:00.000Z");

      const all = await rows();
      const twoWeekAlerts = all.filter((reminder) => reminder.dedupeKey.includes("lead336h"));
      expect(twoWeekAlerts).toHaveLength(1);
      expect(twoWeekAlerts[0]?.message).toContain('"Exam"');
      expect(all.filter((reminder) => reminder.status === "scheduled")).toHaveLength(9);
    });

    it("replaces the reminders when the deadline moves, and cancels them when the task is done", async () => {
      const task = await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      await services.tasks.update(owner, task.id, { dueAt: "2026-10-20T22:00:00.000Z" });
      const moved = await sync("2026-10-14T15:30:00.000Z");
      expect(moved).toMatchObject({ created: 3, canceled: 3 });
      const all = await rows();
      expect(all.filter((r) => r.status === "scheduled")).toHaveLength(3);
      expect(
        all.filter((r) => r.status === "canceled").every((r) => r.detail === "deadline changed"),
      ).toBe(true);

      await services.tasks.complete(owner, task.id);
      await sync("2026-10-14T16:00:00.000Z");
      expect((await rows()).filter((r) => r.status === "scheduled")).toHaveLength(0);
    });

    it("schedules a reminder and a still-going check for an upcoming event", async () => {
      await services.events.create(owner, {
        title: "Lab",
        startsAt: "2026-10-14T20:00:00.000Z",
        endsAt: "2026-10-14T21:30:00.000Z",
        timezone: TZ,
      });
      expect((await sync("2026-10-14T15:00:00.000Z")).created).toBe(2);
      const all = await rows();
      expect(all.map((r) => r.kind).toSorted()).toEqual(["check_in", "event"]);
      expect(all.find((r) => r.kind === "event")?.dueAt.toISOString()).toBe(
        "2026-10-14T19:30:00.000Z",
      );
    });

    it("sends a same-day meeting reminder and schedules all-day events for the morning", async () => {
      const meeting = await services.events.create(owner, {
        title: "Project review",
        startsAt: "2026-10-14T15:20:00.000Z",
        endsAt: "2026-10-14T16:20:00.000Z",
        timezone: TZ,
      });
      const allDay = await services.events.create(owner, {
        title: "Conference",
        startsAt: "2026-10-15T05:00:00.000Z",
        endsAt: "2026-10-16T05:00:00.000Z",
        timezone: TZ,
        allDay: true,
      });
      await sync("2026-10-14T15:00:00.000Z", { briefingTime: null });
      const scheduled = await rows();
      expect(
        scheduled
          .find((r) => r.subjectId === meeting.id && r.kind === "event")
          ?.dueAt.toISOString(),
      ).toBe("2026-10-14T14:50:00.000Z");
      expect(scheduled.filter((r) => r.subjectId === allDay.id)).toMatchObject([
        { kind: "event", dueAt: at("2026-10-15T14:00:00.000Z") },
      ]);
      expect(scheduled.some((r) => r.subjectId === allDay.id && r.kind === "check_in")).toBe(false);

      const result = await cycle("2026-10-14T15:00:00.000Z", { briefingTime: null });
      expect(result.sent).toBe(1);
      expect(sent[0]).toContain("Project review");
    });
  });

  describe("delivery", () => {
    it("sends the one-hour warning at 60 minutes, once, without inferring completion from silence", async () => {
      const task = await addTask();
      const leads = { deadlineLeadHours: [1] };
      await sync("2026-10-16T20:59:00.000Z", leads);
      expect((await cycle("2026-10-16T20:59:00.000Z", leads)).sent).toBe(0);
      expect((await cycle("2026-10-16T21:00:00.000Z", leads)).sent).toBe(1);
      expect(sent[0]).toContain("due in 1 hour");
      await sync("2026-10-16T21:30:00.000Z", leads);
      await cycle("2026-10-16T22:10:00.000Z", leads);
      expect(sent).toHaveLength(1);
      expect((await services.tasks.get(owner, task.id)).status).toBe("open");
      await services.tasks.complete(owner, task.id);
      await sync("2026-10-16T22:11:00.000Z", leads);
      expect((await services.tasks.get(owner, task.id)).status).toBe("completed");
    });

    it("sends a due reminder exactly once, however often the cycle runs or restarts", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      expect((await cycle("2026-10-15T22:00:30.000Z")).sent).toBe(1);
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("due tomorrow");
      for (let i = 0; i < 3; i++) await cycle("2026-10-15T22:01:00.000Z");
      expect(sent).toHaveLength(1);
      expect((await rows()).filter((r) => r.status === "sent")).toHaveLength(1);
    });

    it("retries a failed send with backoff, and sends it once when delivery recovers", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      outcome = () => ({ ok: false, reason: "error" });
      expect(await cycle("2026-10-15T22:00:30.000Z")).toMatchObject({ retrying: 1, sent: 0 });
      let row = (await rows()).find((r) => r.attempts === 1)!;
      expect(row.status).toBe("scheduled");
      expect(row.nextAttemptAt?.toISOString()).toBe("2026-10-15T22:01:30.000Z");

      expect((await cycle("2026-10-15T22:01:00.000Z")).retrying).toBe(0);
      outcome = () => ({ ok: true });
      expect((await cycle("2026-10-15T22:02:00.000Z")).sent).toBe(1);
      row = (await rows()).find((r) => r.id === row.id)!;
      expect(row.status).toBe("sent");
      expect(row.attempts).toBe(2);
      expect(sent).toHaveLength(1);
    });

    it("gives up after the attempt limit and records why", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      outcome = () => ({ ok: false, reason: "rate_limited", retryAfterMs: 60_000 });
      let now = at("2026-10-15T22:00:30.000Z");
      for (let i = 0; i < 6; i++) {
        await cycle(now.toISOString(), { maxAttempts: 3 });
        now = new Date(now.getTime() + 20 * 60_000);
      }
      const failed = (await rows()).find((r) => r.status === "failed");
      expect(failed?.detail).toContain("gave up after 3 tries");
      expect(sent).toHaveLength(0);
    });

    it("records blocked delivery as a failure that is visible, without retrying", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      outcome = () => ({ ok: false, reason: "blocked" });
      expect((await cycle("2026-10-15T22:00:30.000Z")).failed).toBe(1);
      const failed = (await rows()).find((r) => r.status === "failed");
      expect(failed?.detail).toContain("private Discord channel");
      expect(failed?.attempts).toBe(1);
      await cycle("2026-10-15T22:30:00.000Z");
      expect(failed && (await rows()).find((r) => r.id === failed.id)?.attempts).toBe(1);
    });

    it("never resends a job interrupted mid-send; it is marked unknown instead", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      // A worker claims the job and dies before recording the result.
      const claimed = await claimDue(handle.db, ownerId, at("2026-10-15T22:00:30.000Z"));
      expect(claimed).toHaveLength(1);

      const later = new Date(at("2026-10-15T22:00:30.000Z").getTime() + SENDING_STALE_MS + 1000);
      const report = await cycle(later.toISOString());
      expect(report.unknown).toBe(1);
      expect(sent).toHaveLength(0);
      const row = (await rows()).find((r) => r.id === claimed[0]!.id)!;
      expect(row.status).toBe("unknown");
      expect(row.detail).toContain("not resent");
    });

    it("lets two workers race for a job and only one wins it", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      const results = await Promise.all([
        claimDue(handle.db, ownerId, at("2026-10-15T22:00:30.000Z")),
        claimDue(handle.db, ownerId, at("2026-10-15T22:00:30.000Z")),
        claimDue(handle.db, ownerId, at("2026-10-15T22:00:30.000Z")),
      ]);
      expect(results.flat()).toHaveLength(1);
    });
  });

  describe("what is still worth sending", () => {
    it("skips a reminder for a task finished in the meantime", async () => {
      const task = await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      await services.tasks.complete(owner, task.id);
      const report = await cycle("2026-10-15T22:00:30.000Z");
      expect(report).toMatchObject({ sent: 0, skipped: 1 });
      expect((await rows())[0]?.detail).toBeDefined();
      expect(sent).toHaveLength(0);
    });

    it("skips time-sensitive reminders missed during an outage, instead of replaying them", async () => {
      await services.events.create(owner, {
        title: "Lab",
        startsAt: "2026-10-14T20:00:00.000Z",
        endsAt: "2026-10-14T23:00:00.000Z",
        timezone: TZ,
      });
      await sync("2026-10-14T15:00:00.000Z");
      const report = await cycle("2026-10-14T21:30:00.000Z");
      expect(report.sent).toBe(0);
      expect(report.skipped).toBe(2);
      expect((await rows()).every((r) => r.detail === "stale")).toBe(true);
    });

    it("sends a late but still relevant deadline reminder, marked as late", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      await cycle("2026-10-15T23:30:00.000Z");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toMatch(/^\(a little late\)/);
    });

    it("merges many missed reminders into one summary", async () => {
      for (let i = 0; i < MAX_LATE_INDIVIDUAL + 2; i++) await addTask(`Assignment ${i}`);
      await sync("2026-10-14T15:00:00.000Z");
      const report = await cycle("2026-10-15T23:00:00.000Z");
      expect(sent).toHaveLength(1);
      expect(sent[0]).toContain("missed 5 reminders");
      expect(report.summarized).toBe(5);
      expect((await rows()).filter((r) => r.status === "sent")).toHaveLength(5);
    });
  });

  describe("quiet hours, limits, and pause", () => {
    it("holds a reminder during quiet hours and sends it when they end", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      const quiet = { quietHours: { start: "16:00", end: "23:00" } };
      expect(await cycle("2026-10-15T22:00:30.000Z", quiet)).toMatchObject({
        deferred: 1,
        sent: 0,
      });
      const held = (await rows()).find(
        (r) => r.dueAt.toISOString() === "2026-10-15T22:00:00.000Z",
      )!;
      expect(held.status).toBe("scheduled");
      expect(held.attempts).toBe(0);
      expect(held.nextAttemptAt?.toISOString()).toBe("2026-10-16T04:00:00.000Z");
      expect(sent).toHaveLength(0);
      expect((await cycle("2026-10-16T04:00:30.000Z", quiet)).sent).toBe(1);
    });

    it("stops at the daily limit", async () => {
      for (let i = 0; i < 4; i++) await addTask(`Task ${i}`);
      await sync("2026-10-14T15:00:00.000Z");
      await cycle("2026-10-15T22:00:30.000Z", { dailyLimit: 2 });
      expect(sent).toHaveLength(2);
      expect((await rows()).filter((r) => r.detail === "daily limit")).toHaveLength(2);
    });

    it("sends nothing while accountability is paused", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      expect((await cycle("2026-10-15T22:00:30.000Z", { paused: true })).skipped).toBe(1);
      expect(sent).toHaveLength(0);
    });
  });

  describe("briefings and routines", () => {
    it("schedules a morning briefing each day, once, and composes it when it is sent", async () => {
      expect((await sync("2026-10-14T11:00:00.000Z", { briefingTime: "08:00" })).created).toBe(2);
      expect((await sync("2026-10-14T11:05:00.000Z", { briefingTime: "08:00" })).created).toBe(0);
      const briefings = (await rows()).filter((r) => r.kind === "briefing");
      expect(briefings.map((r) => r.dueAt.toISOString()).toSorted()).toEqual([
        "2026-10-14T13:00:00.000Z",
        "2026-10-15T13:00:00.000Z",
      ]);

      const composed: string[] = [];
      await runReminderCycle({
        db: handle.db,
        ownerId,
        now: at("2026-10-14T13:00:30.000Z"),
        timezone: TZ,
        settings: settings({ briefingTime: "08:00" }),
        delivery,
        compose: async (reminder) => (reminder.kind === "briefing" ? "Fresh briefing text" : null),
        onDelivered: (group) => {
          composed.push(...group.map((r) => r.id));
        },
      });
      expect(sent).toEqual(["Fresh briefing text"]);
      expect(composed).toHaveLength(1);
    });

    it("can turn the briefing off, and drops one that is hours late", async () => {
      expect((await sync("2026-10-14T11:00:00.000Z", { briefingTime: null })).created).toBe(0);
      await sync("2026-10-14T11:00:00.000Z", { briefingTime: "08:00" });
      expect((await cycle("2026-10-14T18:00:00.000Z", { briefingTime: "08:00" })).skipped).toBe(1);
      expect(sent).toHaveLength(0);
    });

    it("makes bedtime, workout, and hourly awareness reminders from the owner's routines", async () => {
      const routines = {
        bedtime: "22:30",
        workout: { days: ["wed" as const, "fri" as const], time: "17:00", label: "gym session" },
        awareness: { from: "09:00", to: "11:00", everyHours: 1 },
      };
      const result = await sync("2026-10-14T11:00:00.000Z", { briefingTime: null, routines });
      // Wed: bedtime + workout + 3 awareness; Thu: bedtime + 3 awareness (not a workout day).
      expect(result.created).toBe(5 + 4);
      const all = await rows();
      expect(all.filter((r) => r.kind === "wind_down")).toHaveLength(2);
      expect(all.find((r) => r.message.includes("gym session"))?.dueAt.toISOString()).toBe(
        "2026-10-14T22:00:00.000Z",
      );
      expect(all.filter((r) => r.dedupeKey.startsWith("routine:awareness"))).toHaveLength(6);
      expect(
        (await sync("2026-10-14T11:10:00.000Z", { briefingTime: null, routines })).created,
      ).toBe(0);
    });

    it("skips missed hourly prompts after an outage instead of replaying every one", async () => {
      const routines = {
        bedtime: null,
        workout: null,
        awareness: { from: "09:00", to: "13:00", everyHours: 1 },
      };
      await sync("2026-10-14T14:00:00.000Z", { briefingTime: null, routines });
      const report = await cycle("2026-10-14T18:00:00.000Z", { briefingTime: null, routines });
      // Only the prompt that is due right now goes out; the four missed ones are dropped.
      expect(sent).toEqual(["Quick check-in: what are you working on right now?"]);
      expect(report.skipped).toBe(4);
    });
  });

  describe("through the services", () => {
    it("lists recent reminders and snoozes one that has not been sent", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      const before = await services.reminders.recent(owner);
      expect(before).toHaveLength(3);
      const target = before.find((r) => r.dueAt.toISOString() === "2026-10-15T22:00:00.000Z")!;

      expect(await services.reminders.snooze(owner, target.id, 90)).toBe(true);
      const moved = (await rows()).find((r) => r.id === target.id)!;
      expect(moved.status).toBe("scheduled");
      expect(moved.dueAt.getTime() - Date.now()).toBeGreaterThan(80 * 60_000);

      await cycle("2026-10-15T22:00:30.000Z");
      expect(sent).toHaveLength(0);

      await handle.db.update(reminders).set({ status: "sent" }).where(eq(reminders.id, target.id));
      expect(await services.reminders.snooze(owner, target.id, 10)).toBe(false);
    });

    it("keeps another owner's reminders out of reach and refuses shared audiences", async () => {
      await addTask();
      await sync("2026-10-14T15:00:00.000Z");
      const [mine] = await services.reminders.recent(owner);
      const other = await createOwner(handle.db, { displayName: "Other" });
      const theirs = await issueOwnerPrincipal(handle.db, other.id, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
      expect(await services.reminders.recent(theirs)).toEqual([]);
      expect(await services.reminders.snooze(theirs, mine!.id, 10)).toBe(false);
      const shared = await issueOwnerPrincipal(handle.db, ownerId, {
        source: "discord",
        audience: "shared",
        initiator: "owner",
      });
      await expect(services.reminders.recent(shared)).rejects.toThrow();
      await expect(services.reminders.snooze(shared, mine!.id, 10)).rejects.toThrow();
    });
  });

  it("is isolated per owner: another owner's tasks never produce reminders here", async () => {
    const other = await createOwner(handle.db, { displayName: "Other" });
    const theirs = await issueOwnerPrincipal(handle.db, other.id, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    await services.tasks.create(theirs, { title: "Theirs", dueAt: DUE });
    await sync("2026-10-14T15:00:00.000Z");
    expect(await rows()).toHaveLength(0);
    expect(await handle.db.select().from(tasks).where(eq(tasks.ownerId, other.id))).toHaveLength(1);
  });

  it("claims and recovers only this owner's reminder jobs", async () => {
    const other = await createOwner(handle.db, { displayName: "Other" });
    const theirs = await issueOwnerPrincipal(handle.db, other.id, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    await services.tasks.create(theirs, { title: "Other's task", dueAt: DUE });
    await syncReminders({
      db: handle.db,
      ownerId: other.id,
      now: at("2026-10-14T15:00:00.000Z"),
      timezone: TZ,
      settings: settings(),
    });
    const otherJobs = (await rows()).filter((row) => row.ownerId === other.id);
    const stale = otherJobs[0]!;
    await handle.db
      .update(reminders)
      .set({
        status: "sending",
        claimedAt: at("2026-10-15T21:57:00.000Z"),
      })
      .where(eq(reminders.id, stale.id));

    await addTask();
    await sync("2026-10-14T15:00:00.000Z");
    await cycle("2026-10-15T22:00:30.000Z");

    const after = (await rows()).filter((row) => row.ownerId === other.id);
    expect(after.find((row) => row.id === stale.id)?.status).toBe("sending");
    expect(after.filter((row) => row.status === "scheduled")).toHaveLength(2);
  });
});
