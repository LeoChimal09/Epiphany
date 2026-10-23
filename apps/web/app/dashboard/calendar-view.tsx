"use client";

import { useEffect, useState } from "react";
import { addDays } from "@epiphany/core/planning";
import { loadDashboardSchedule } from "./actions";
import type { DashboardTask } from "./model";
import {
  buildDay,
  formatDayLabel,
  formatWeekRange,
  monthDays,
  shiftMonth,
  timelineItems,
  weekStartOf,
  type ScheduleData,
  type TimelineItem,
} from "./schedule";
import { TodayView, WeekView } from "./schedule-views";
import { AvailabilityPanel } from "./planning-panel";
import styles from "./workspace.module.css";

type CalendarMode = "day" | "week" | "month";

export async function loadCalendarSchedule(
  from: string,
  weeks: number,
  initialSchedule: ScheduleData,
): Promise<ScheduleData> {
  const results = await Promise.all(
    Array.from({ length: weeks }, (_, index) => {
      const week = addDays(from, index * 7);
      return week === initialSchedule.weekStart
        ? Promise.resolve({ ok: true as const, schedule: initialSchedule })
        : loadDashboardSchedule(week);
    }),
  );
  const events = new Map<string, ScheduleData["events"][number]>();
  const blocks = new Map<string, ScheduleData["blocks"][number]>();
  let truncated = false;
  for (const result of results) {
    if (!result.ok) throw new Error(result.error);
    for (const event of result.schedule.events) events.set(event.id, event);
    for (const block of result.schedule.blocks) blocks.set(block.id, block);
    truncated ||= result.schedule.truncated;
  }
  return {
    weekStart: from,
    events: [...events.values()],
    blocks: [...blocks.values()],
    truncated,
    planningPreferences: results[0]?.ok ? results[0].schedule.planningPreferences : undefined,
    syncWarning:
      results.flatMap((result) =>
        result.ok && result.schedule.syncWarning ? [result.schedule.syncWarning] : [],
      )[0] ?? null,
  };
}

export function CalendarView({
  initialSchedule,
  initialMode,
  tasks,
  tasksTruncated = false,
  timezone,
  today,
  initialDate = today,
  now,
  pending,
  onComplete,
  onRemove,
}: {
  initialSchedule: ScheduleData;
  initialMode: CalendarMode;
  initialDate?: string;
  tasks: DashboardTask[];
  tasksTruncated?: boolean;
  timezone: string;
  today: string;
  now: Date;
  pending: boolean;
  onComplete: (id: string) => void;
  onRemove: (item: TimelineItem) => void;
}) {
  const [mode, setMode] = useState(initialMode);
  const [date, setDate] = useState(initialDate);
  const [loaded, setLoaded] = useState<{
    key: string;
    schedule: ScheduleData;
  } | null>(() =>
    initialMode !== "month" && weekStartOf(initialDate) === initialSchedule.weekStart
      ? { key: `${initialSchedule.weekStart}:1`, schedule: initialSchedule }
      : null,
  );
  const [error, setError] = useState<{ key: string; text: string } | null>(null);
  const [retry, setRetry] = useState(0);
  const dates = mode === "month" ? monthDays(date) : [];
  const from = mode === "month" ? dates[0]! : weekStartOf(date);
  const weeks = mode === "month" ? dates.length / 7 : 1;
  const key = `${from}:${weeks}`;

  useEffect(() => {
    let cancelled = false;
    async function load() {
      try {
        const schedule = await loadCalendarSchedule(from, weeks, initialSchedule);
        if (cancelled) return;
        setError(null);
        setLoaded({ key, schedule });
      } catch (failure) {
        if (!cancelled)
          setError({
            key,
            text: failure instanceof Error ? failure.message : "The calendar could not be loaded.",
          });
      }
    }
    void load();
    return () => {
      cancelled = true;
    };
  }, [from, weeks, key, initialSchedule, retry]);

  const schedule = loaded?.key === key ? loaded.schedule : null;
  const label =
    mode === "day"
      ? formatDayLabel(date, "long")
      : mode === "week"
        ? formatWeekRange(from)
        : new Intl.DateTimeFormat("en-US", {
            month: "long",
            year: "numeric",
            timeZone: "UTC",
          }).format(new Date(`${date}T12:00:00Z`));
  const move = (direction: number) =>
    setDate(
      mode === "month"
        ? shiftMonth(date, direction)
        : addDays(date, direction * (mode === "week" ? 7 : 1)),
    );

  return (
    <div>
      <div className={styles.weekNav}>
        <div className={styles.rowActions} role="group" aria-label="Calendar view">
          {(["day", "week", "month"] as const).map((value) => (
            <button
              key={value}
              type="button"
              className={styles.secondaryButton}
              aria-pressed={mode === value}
              onClick={() => setMode(value)}
            >
              {value === "day" ? "Day" : value === "week" ? "Week" : "Month"}
            </button>
          ))}
        </div>
        <button
          type="button"
          className={styles.secondaryButton}
          aria-label={`Previous ${mode}`}
          onClick={() => move(-1)}
        >
          Previous
        </button>
        <h2 aria-live="polite">{label}</h2>
        <button
          type="button"
          className={styles.secondaryButton}
          aria-label={`Next ${mode}`}
          onClick={() => move(1)}
        >
          Next
        </button>
        <button type="button" className={styles.secondaryButton} onClick={() => setDate(today)}>
          Today
        </button>
      </div>
      {error?.key === key ? (
        <p className={styles.errorNotice} role="alert">
          {error.text}{" "}
          <button
            type="button"
            className={styles.secondaryButton}
            onClick={() => setRetry((value) => value + 1)}
          >
            Retry
          </button>
        </p>
      ) : !schedule ? (
        <p role="status">Loading calendar...</p>
      ) : (
        <>
          {schedule.truncated ? (
            <p className={styles.limitNotice}>
              Some calendar items exceed the display limit. Open a day or week to narrow the range.
            </p>
          ) : null}
          <AvailabilityPanel
            schedule={schedule}
            tasks={tasks}
            tasksTruncated={tasksTruncated}
            timezone={timezone}
            from={mode === "day" ? date : from}
            to={mode === "day" ? date : addDays(from, weeks * 7 - 1)}
            now={now}
          />
          {mode === "month" ? (
            <MonthView
              schedule={schedule}
              tasks={tasks}
              timezone={timezone}
              date={date}
              today={today}
              onSelect={(day) => {
                setDate(day);
                setMode("day");
              }}
            />
          ) : mode === "day" ? (
            <TodayView
              schedule={schedule}
              tasks={tasks}
              timezone={timezone}
              today={today}
              date={date}
              now={now}
              pending={pending}
              onComplete={onComplete}
              onRemove={onRemove}
            />
          ) : (
            <WeekView
              schedule={schedule}
              tasks={tasks}
              timezone={timezone}
              today={today}
              now={now}
              pending={pending}
              onComplete={onComplete}
              onRemove={onRemove}
            />
          )}
        </>
      )}
    </div>
  );
}

export function MonthView({
  schedule,
  tasks,
  timezone,
  date,
  today,
  onSelect,
}: {
  schedule: ScheduleData;
  tasks: DashboardTask[];
  timezone: string;
  date: string;
  today: string;
  onSelect: (date: string) => void;
}) {
  const dates = monthDays(date);
  const items = timelineItems(schedule);
  return (
    <div className={styles.monthScroll}>
      <div className={styles.monthGrid} aria-label="Month calendar">
        {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((day) => (
          <strong key={day}>{day}</strong>
        ))}
        {dates.map((day) => {
          const past = day < today;
          const current = day === today;
          const content = buildDay(day, items, tasks, timezone);
          const entries = [
            ...content.allDay.map((event) => `Event: ${event.title}`),
            ...content.deadlines.map((task) => `Due: ${task.title}`),
            ...content.entries.map(
              (entry) =>
                `${entry.item.kind === "work" ? "Work" : "Event"}: ${entry.item.title}${entry.item.conflict ? " (overlap)" : ""}`,
            ),
          ];
          return (
            <button
              key={day}
              type="button"
              className={`${styles.monthDay} ${past ? styles.monthPast : ""} ${current ? styles.monthToday : ""}`}
              aria-current={current ? "date" : undefined}
              aria-label={`${formatDayLabel(day, "long")}, ${entries.length} items${past ? ", past day" : current ? ", today" : ""}`}
              onClick={() => {
                onSelect(day);
              }}
            >
              <span className={styles.monthDayHeading}>
                <span
                  className={
                    day.slice(0, 7) === date.slice(0, 7) ? styles.monthDate : styles.monthOutside
                  }
                >
                  {Number(day.slice(-2))}
                </span>
                {past || current ? (
                  <span className={styles.calendarDayStatus}>{past ? "Past" : "Today"}</span>
                ) : null}
              </span>
              {entries.slice(0, 3).map((entry, index) => (
                <span className={styles.monthEntry} key={index} title={entry}>
                  {entry}
                </span>
              ))}
              {entries.length > 3 ? <span>+{entries.length - 3} more</span> : null}
            </button>
          );
        })}
      </div>
    </div>
  );
}
