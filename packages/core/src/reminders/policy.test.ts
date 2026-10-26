import { describe, expect, it } from "vitest";
import type { Preference } from "../db/schema";
import {
  DEFAULT_REMINDER_SETTINGS,
  decideDelivery,
  inQuietHours,
  parseReminderSettings,
  quietHoursEnd,
  retryDelayMs,
  type DecisionInput,
} from "./policy";

const TZ = "America/Chicago";
const at = (iso: string) => new Date(iso);
const pref = (key: string, value: unknown, status: "proposed" | "confirmed" = "confirmed") =>
  ({ key, value, status }) as unknown as Preference;

const base = (over: Partial<DecisionInput> = {}): DecisionInput => ({
  reminder: {
    kind: "task_deadline",
    urgency: "normal",
    dueAt: at("2026-10-14T15:00:00.000Z"),
    hasSubject: true,
  },
  now: at("2026-10-14T15:00:30.000Z"),
  timezone: TZ,
  settings: DEFAULT_REMINDER_SETTINGS,
  subjectActive: true,
  sentToday: 0,
  ...over,
});

describe("reminder settings", () => {
  it("uses defaults, and ignores proposed or invalid values", () => {
    expect(parseReminderSettings([])).toEqual(DEFAULT_REMINDER_SETTINGS);
    const settings = parseReminderSettings([
      pref("reminders.daily_limit", 5),
      pref("reminders.grace_minutes", 999_999),
      pref("reminders.quiet_hours", { start: "25:00", end: "07:00" }),
      pref("reminders.paused", "yes"),
      pref("reminders.event_lead_minutes", 10, "proposed"),
    ]);
    expect(settings.dailyLimit).toBe(5);
    expect(settings.graceMinutes).toBe(DEFAULT_REMINDER_SETTINGS.graceMinutes);
    expect(settings.quietHours).toEqual({ start: "22:00", end: "07:00" });
    expect(settings.paused).toBe(false);
    expect(settings.eventLeadMinutes).toBe(30);
  });

  it("reads quiet hours, leads, and pause from confirmed preferences", () => {
    const settings = parseReminderSettings([
      pref("reminders.quiet_hours", { start: "22:00", end: "07:00" }),
      pref("reminders.deadline_lead_hours", [2, 48, 2, 24]),
      pref("reminders.paused", true),
    ]);
    expect(settings.quietHours).toEqual({ start: "22:00", end: "07:00" });
    expect(settings.deadlineLeadHours).toEqual([48, 24, 2]);
    expect(settings.paused).toBe(true);
  });

  it("uses local overnight quiet hours unless the owner explicitly turns them off", () => {
    expect(parseReminderSettings([]).quietHours).toEqual({ start: "22:00", end: "07:00" });
    expect(parseReminderSettings([pref("reminders.quiet_hours", null)]).quietHours).toBeNull();
  });

  it("includes a one-hour warning by default but does not override the owner's chosen leads", () => {
    expect(parseReminderSettings([]).deadlineLeadHours).toEqual([1]);
    expect(parseReminderSettings([]).majorDeadlineLeadHours).toEqual([24, 2, 1]);
    expect(
      parseReminderSettings([pref("reminders.deadline_lead_hours", [1])]).deadlineLeadHours,
    ).toEqual([1]);
    expect(
      parseReminderSettings([pref("reminders.deadline_lead_hours", [1])]).majorDeadlineLeadHours,
    ).toEqual([1]);
    expect(
      parseReminderSettings([pref("reminders.deadline_lead_hours", [24, 2])]).deadlineLeadHours,
    ).toEqual([24, 2]);
  });
});

describe("briefing, routines, and timed pauses", () => {
  const now = at("2026-10-14T15:00:00.000Z");
  it("reads the briefing time, which can be switched off", () => {
    expect(parseReminderSettings([]).briefingTime).toBe("08:00");
    expect(parseReminderSettings([pref("reminders.briefing_time", "07:15")]).briefingTime).toBe(
      "07:15",
    );
    expect(parseReminderSettings([pref("reminders.briefing_time", null)]).briefingTime).toBeNull();
    expect(parseReminderSettings([pref("reminders.briefing_time", "7am")]).briefingTime).toBe(
      "08:00",
    );
  });

  it("reads routines and ignores malformed ones", () => {
    const settings = parseReminderSettings([
      pref("routine.bedtime", { time: "22:30" }),
      pref("routine.workout", { days: ["mon", "funday", "fri"], time: "17:00", label: "run" }),
      pref("routine.awareness", { from: "09:00", to: "21:00", everyHours: 2 }),
    ]);
    expect(settings.routines).toEqual({
      bedtime: "22:30",
      workout: { days: ["mon", "fri"], time: "17:00", label: "run" },
      awareness: { from: "09:00", to: "21:00", everyHours: 2 },
    });
    const bad = parseReminderSettings([
      pref("routine.bedtime", { time: "late" }),
      pref("routine.workout", { days: ["noday"], time: "17:00" }),
      pref("routine.awareness", { from: "21:00", to: "09:00" }),
    ]);
    expect(bad.routines).toEqual({ bedtime: null, workout: null, awareness: null });
  });

  it("pauses until a time that passes by itself", () => {
    const future = pref("reminders.paused_until", "2026-10-14T17:00:00.000Z");
    expect(parseReminderSettings([future], now).paused).toBe(true);
    expect(parseReminderSettings([future], at("2026-10-14T17:00:01.000Z")).paused).toBe(false);
  });
});

describe("quiet hours", () => {
  const quiet = { start: "22:00", end: "07:00" };
  it("covers the span across midnight in the owner's timezone", () => {
    expect(inQuietHours(at("2026-10-15T03:30:00.000Z"), TZ, quiet)).toBe(true); // 10:30 PM
    expect(inQuietHours(at("2026-10-15T08:00:00.000Z"), TZ, quiet)).toBe(true); // 3:00 AM
    expect(inQuietHours(at("2026-10-15T13:00:00.000Z"), TZ, quiet)).toBe(false); // 8:00 AM
    expect(inQuietHours(at("2026-10-15T20:00:00.000Z"), TZ, null)).toBe(false);
  });

  it("finds the next end, whether before or after midnight", () => {
    expect(quietHoursEnd(at("2026-10-15T03:30:00.000Z"), TZ, quiet).toISOString()).toBe(
      "2026-10-15T12:00:00.000Z",
    );
    expect(quietHoursEnd(at("2026-10-15T08:00:00.000Z"), TZ, quiet).toISOString()).toBe(
      "2026-10-15T12:00:00.000Z",
    );
    const noon = at("2026-10-15T17:00:00.000Z");
    expect(quietHoursEnd(noon, TZ, quiet)).toBe(noon);
  });

  it("handles a same-day window", () => {
    expect(inQuietHours(at("2026-10-14T19:00:00.000Z"), TZ, { start: "13:00", end: "15:00" })).toBe(
      true,
    );
    expect(inQuietHours(at("2026-10-14T21:00:00.000Z"), TZ, { start: "13:00", end: "15:00" })).toBe(
      false,
    );
  });
});

describe("deciding whether to send", () => {
  it("sends a due reminder, and marks one that is a little late", () => {
    expect(decideDelivery(base())).toEqual({ action: "send", late: false });
    expect(decideDelivery(base({ now: at("2026-10-14T15:20:00.000Z") }))).toEqual({
      action: "send",
      late: true,
    });
  });

  it("skips when paused, or when the task or event no longer needs it", () => {
    expect(
      decideDelivery(base({ settings: { ...DEFAULT_REMINDER_SETTINGS, paused: true } })),
    ).toEqual({ action: "skip", reason: "paused" });
    expect(decideDelivery(base({ subjectActive: false }))).toEqual({
      action: "skip",
      reason: "obsolete",
    });
  });

  it("drops a time-sensitive reminder after its grace period, but keeps a deadline reminder for a day", () => {
    const check = base({
      reminder: {
        kind: "check_in",
        urgency: "normal",
        dueAt: at("2026-10-14T15:00:00.000Z"),
        hasSubject: false,
      },
      now: at("2026-10-14T15:45:00.000Z"),
    });
    expect(decideDelivery(check)).toEqual({ action: "skip", reason: "stale" });
    expect(
      decideDelivery(
        base({
          now: at("2026-10-15T10:00:00.000Z"),
          settings: { ...DEFAULT_REMINDER_SETTINGS, quietHours: null },
        }),
      ),
    ).toMatchObject({ action: "send" });
    expect(decideDelivery(base({ now: at("2026-10-15T16:00:00.000Z") }))).toEqual({
      action: "skip",
      reason: "stale",
    });
  });

  it("holds ordinary reminders during quiet hours until they end, but lets urgent ones through", () => {
    const settings = { ...DEFAULT_REMINDER_SETTINGS, quietHours: { start: "22:00", end: "07:00" } };
    const night = base({
      settings,
      reminder: {
        kind: "task_deadline",
        urgency: "normal",
        dueAt: at("2026-10-15T04:00:00.000Z"),
        hasSubject: true,
      },
      now: at("2026-10-15T04:00:00.000Z"),
    });
    expect(decideDelivery(night)).toEqual({
      action: "defer",
      until: at("2026-10-15T12:00:00.000Z"),
    });
    expect(
      decideDelivery({ ...night, reminder: { ...night.reminder, urgency: "high" } }),
    ).toMatchObject({ action: "send" });
  });

  it("drops, instead of delaying, a time-sensitive reminder that quiet hours would make useless", () => {
    const settings = { ...DEFAULT_REMINDER_SETTINGS, quietHours: { start: "22:00", end: "07:00" } };
    const result = decideDelivery(
      base({
        settings,
        reminder: {
          kind: "check_in",
          urgency: "normal",
          dueAt: at("2026-10-15T04:00:00.000Z"),
          hasSubject: false,
        },
        now: at("2026-10-15T04:00:00.000Z"),
      }),
    );
    expect(result).toEqual({ action: "skip", reason: "stale" });
  });

  it("enforces the daily limit on ordinary reminders only", () => {
    const limited = base({ sentToday: DEFAULT_REMINDER_SETTINGS.dailyLimit });
    expect(decideDelivery(limited)).toEqual({ action: "skip", reason: "daily_limit" });
    expect(
      decideDelivery({ ...limited, reminder: { ...limited.reminder, urgency: "high" } }),
    ).toMatchObject({ action: "send" });
  });
});

describe("retry backoff", () => {
  it("grows with attempts, caps, and honors a longer rate-limit wait", () => {
    const s = DEFAULT_REMINDER_SETTINGS;
    expect(retryDelayMs(1, s)).toBe(60_000);
    expect(retryDelayMs(2, s)).toBe(5 * 60_000);
    expect(retryDelayMs(9, s)).toBe(15 * 60_000);
    expect(retryDelayMs(1, s, 10 * 60_000)).toBe(10 * 60_000);
  });
});
