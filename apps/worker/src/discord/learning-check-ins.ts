import {
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

export async function availableForLearningCheckIn(
  services: Services,
  principal: Principal,
  now: Date,
  timezone: string,
) {
  const rows = await services.preferences.list(principal);
  const confirmed = (key: string) =>
    rows.find((row) => row.key === key && row.status === "confirmed")?.value;
  if (
    confirmed("tracking.enabled") !== true ||
    confirmed("tracking.paused") === true ||
    confirmed("tracking.check_ins") !== true
  )
    return false;
  const reminders = parseReminderSettings(rows, now);
  if (
    reminders.paused ||
    inQuietHours(now, timezone, reminders.quietHours) ||
    inQuietHours(new Date(now.getTime() + 30 * 60_000), timezone, reminders.quietHours)
  )
    return false;
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
  if (events.length === range.limit || workBlocks.length === range.limit) return false;
  if (recent.some((row) => row.sentAt && now.getTime() - row.sentAt.getTime() < 60 * 60_000))
    return false;
  const preferences = parsePlanningPreferences(rows, timezone);
  // Calendar freedom is only a conservative proxy, never a presence/surveillance signal.
  const availability = computeAvailability({
    range: { from: day, to: day },
    events,
    workBlocks,
    preferences: { ...preferences, minBlockMinutes: 30 },
    notBefore: now,
  });
  return availability.windows.some(
    (window) =>
      window.start.getTime() <= now.getTime() &&
      window.end.getTime() >= now.getTime() + 30 * 60_000,
  );
}

export async function scheduleLearningCheckIn(
  services: Services,
  principal: Principal,
  now: Date,
  timezone: string,
) {
  const last = await services.preferences.get(principal, "learning.last_question");
  const day = dateKeyOf(now, timezone);
  if (!learningQuestionDue(last?.value, now, day)) return;
  const next = nextLearningQuestion(last?.value);
  if (!next || !(await availableForLearningCheckIn(services, principal, now, timezone))) return;
  // Reserve before queuing. A failed/uncertain delivery never causes repeated topic retries.
  await services.preferences.set(principal, {
    key: "learning.last_question",
    value: { day, at: now.toISOString(), asked: next.asked },
    status: "confirmed",
    ...(last ? { expectedVersion: last.version } : {}),
  });
  await services.reminders.create(principal, {
    kind: "check_in",
    at: now,
    message: `${LEARNING_CHECK_IN_PREFIX}${next.question} No rush to answer. I'll ask before remembering a preference.`,
  });
}
