import {
  askedLearningQuestions,
  LEARNING_CHECK_IN_PREFIX,
  learningQuestionDue,
  nextLearningQuestion,
} from "@epiphany/core/assistant";
import {
  addDays,
  computeAvailability,
  dateKeyOf,
  localWallToUtc,
  parsePlanningPreferences,
} from "@epiphany/core/planning";
import { inQuietHours, parseReminderSettings } from "@epiphany/core/reminders";
import type { Principal, Services } from "@epiphany/core/services";

export type LearningCheckInStatus =
  | "queued"
  | "asked_recently"
  | "all_topics_asked"
  | "not_allowed"
  | "paused"
  | "quiet_hours"
  | "calendar_too_full"
  | "recent_reminder"
  | "no_free_30_minutes";

export async function availableForLearningCheckIn(
  services: Services,
  principal: Principal,
  now: Date,
  timezone: string,
) {
  return (await learningCheckInBlocker(services, principal, now, timezone)) === null;
}

// Why a learning question cannot be asked right now, or null when it can.
export async function learningCheckInBlocker(
  services: Services,
  principal: Principal,
  now: Date,
  timezone: string,
): Promise<Exclude<
  LearningCheckInStatus,
  "queued" | "asked_recently" | "all_topics_asked"
> | null> {
  const rows = await services.preferences.list(principal);
  const confirmed = (key: string) =>
    rows.find((row) => row.key === key && row.status === "confirmed")?.value;
  if (confirmed("tracking.enabled") !== true || confirmed("tracking.check_ins") !== true)
    return "not_allowed";
  const reminders = parseReminderSettings(rows, now);
  if (confirmed("tracking.paused") === true || reminders.paused) return "paused";
  if (
    inQuietHours(now, timezone, reminders.quietHours) ||
    inQuietHours(new Date(now.getTime() + 30 * 60_000), timezone, reminders.quietHours)
  )
    return "quiet_hours";
  const day = dateKeyOf(now, timezone);
  const range = {
    from: localWallToUtc(day, 0, timezone),
    to: localWallToUtc(addDays(day, 1), 0, timezone),
    limit: 500,
  };
  const [events, workBlocks, recent] = await Promise.all([
    services.events.list(principal, range),
    services.workBlocks.list(principal, range),
    services.reminders.recent(principal, 100),
  ]);
  if (events.length === range.limit || workBlocks.length === range.limit)
    return "calendar_too_full";
  if (recent.some((row) => row.sentAt && now.getTime() - row.sentAt.getTime() < 60 * 60_000))
    return "recent_reminder";
  const preferences = parsePlanningPreferences(rows, timezone);
  // Calendar freedom is only a conservative proxy, never a presence/surveillance signal.
  const availability = computeAvailability({
    range: { from: day, to: day },
    events,
    workBlocks,
    preferences: { ...preferences, minBlockMinutes: 30 },
    notBefore: now,
  });
  const free = availability.windows.some(
    (window) =>
      window.start.getTime() <= now.getTime() &&
      window.end.getTime() >= now.getTime() + 30 * 60_000,
  );
  return free ? null : "no_free_30_minutes";
}

// Writes a question from the owner's records; null falls back to the fixed topic list.
export type ComposeLearningQuestion = (recentQuestions: string[]) => Promise<string | null>;

function recentQuestions(value: unknown): string[] {
  const recent = (value as { recent?: unknown } | null | undefined)?.recent;
  return Array.isArray(recent)
    ? recent.filter((item): item is string => typeof item === "string").slice(-5)
    : [];
}

export async function scheduleLearningCheckIn(
  services: Services,
  principal: Principal,
  now: Date,
  timezone: string,
  compose?: ComposeLearningQuestion,
): Promise<LearningCheckInStatus> {
  const last = await services.preferences.get(principal, "learning.last_question");
  const day = dateKeyOf(now, timezone);
  if (!learningQuestionDue(last?.value, now, day)) return "asked_recently";
  const next = nextLearningQuestion(last?.value);
  if (!next && !compose) return "all_topics_asked";
  const blocker = await learningCheckInBlocker(services, principal, now, timezone);
  if (blocker) return blocker;
  const recent = recentQuestions(last?.value);
  const written = compose ? await compose(recent).catch(() => null) : null;
  const question = written ?? next?.question;
  if (!question) return "all_topics_asked";
  // Reserve before queuing. A failed/uncertain delivery never causes repeated topic retries.
  await services.preferences.set(principal, {
    key: "learning.last_question",
    value: {
      day,
      at: now.toISOString(),
      asked: written || !next ? askedLearningQuestions(last?.value) : next.asked,
      recent: [...recent, question].slice(-5),
    },
    status: "confirmed",
    ...(last ? { expectedVersion: last.version } : {}),
  });
  await services.reminders.create(principal, {
    kind: "check_in",
    at: now,
    message: `${LEARNING_CHECK_IN_PREFIX}${question} No rush to answer. I'll ask before remembering a preference.`,
  });
  return "queued";
}
