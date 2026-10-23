import type { DashboardTask } from "./model";
import { formatDuration, type ScheduleData } from "./schedule";
import { preparationHints, scheduleAvailability } from "./planning-model";
import styles from "./workspace.module.css";

export function AvailabilityPanel({
  schedule,
  tasks,
  tasksTruncated,
  timezone,
  from,
  to,
  now,
}: {
  schedule: ScheduleData;
  tasks: DashboardTask[];
  tasksTruncated?: boolean;
  timezone: string;
  from: string;
  to: string;
  now: Date;
}) {
  const windows = scheduleAvailability(schedule, from, to, now);
  const format = (date: Date) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: timezone,
      weekday: "short",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }).format(date);
  const hints =
    windows === null ? [] : preparationHints(tasks, schedule, windows, timezone, from, to, now);
  return (
    <details className={styles.planningPanel}>
      <summary>
        Availability and preparation
        {windows === null
          ? " unavailable"
          : ` | ${formatDuration(windows.reduce((sum, w) => sum + w.minutes, 0))} usable`}
        {schedule.syncWarning ? " (tentative: calendar sync needs attention)" : ""}
      </summary>
      <p>
        <a href="/dashboard/planning">Scheduling preferences</a> | {timezone}. Empty calendar time
        outside preferred hours, sleep, meals, protected time, event buffers, or booked work is not
        offered. Availability uses saved data; check connected calendar sync status before relying
        on it.
      </p>
      {schedule.syncWarning ? (
        <p className={styles.errorNotice} role="status">
          {schedule.syncWarning} Availability is tentative.{" "}
          <a href="/dashboard/calendars">Check calendar sync</a>. Status is from the last load;
          refresh for updates.
        </p>
      ) : null}
      {windows === null ? (
        <p role="status">
          Availability cannot be calculated from incomplete calendar data. Reload or narrow the
          range.
        </p>
      ) : (
        <>
          <h3>Available windows</h3>
          {windows.length ? (
            <ul>
              {windows.slice(0, 14).map((window) => (
                <li key={window.start.toISOString()}>
                  {format(window.start)} to {format(window.end)} ({formatDuration(window.minutes)})
                </li>
              ))}
            </ul>
          ) : (
            <p>No usable time remaining in this range under your scheduling preferences.</p>
          )}
          {windows.length > 14 ? (
            <p>Showing 14 of {windows.length} windows. Open a day or week for detail.</p>
          ) : null}
          <h3>Preparation milestones</h3>
          {tasksTruncated ? (
            <p role="status">
              Task loading reached its limit. Some deadlines are missing from these suggestions;
              check Task history and your full task list.
            </p>
          ) : null}
          <p>
            Suggestions only, not booked time. Each task is checked separately; suggestions can
            share the same free time. Estimates are total task effort. Only loaded deadlines and
            work blocks in this range are included. Tasks without a duration use a 30-minute
            assumption.
          </p>
          {hints.length ? (
            <ul>
              {hints.map((hint) => (
                <li key={hint.taskId}>
                  <strong>{hint.title}</strong>:{" "}
                  {hint.assumedDuration ? "(Assuming 30 minutes) " : ""}
                  {hint.state === "overdue"
                    ? "Overdue - mark done or replan."
                    : hint.state === "conflict"
                      ? "Review conflicting work blocks or scheduling preferences before relying on preparation timing."
                      : hint.state === "covered"
                        ? "Estimated effort covered by upcoming work blocks in this range."
                        : hint.state === "insufficient"
                          ? `Not enough usable time in this range before the deadline for ${formatDuration(hint.remainingMinutes)} of unplanned effort.`
                          : `Start preparation by ${format(hint.startBy)} to fit ${formatDuration(hint.remainingMinutes)} of unplanned effort before the deadline in this range; split across windows if needed.`}
                </li>
              ))}
            </ul>
          ) : (
            <p>No open task deadlines in this range.</p>
          )}
          {hints.length === 10 ? (
            <p>Showing the first 10 deadlines. Narrow the range for more detail.</p>
          ) : null}
        </>
      )}
    </details>
  );
}
