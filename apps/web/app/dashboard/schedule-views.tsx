"use client";

import {
  CalendarClock,
  CalendarDays,
  CalendarRange,
  CircleCheck,
  Flag,
  MapPin,
  Timer,
  TriangleAlert,
  X,
} from "lucide-react";
import type { DateKey } from "@epiphany/core/planning";
import { countdownLabel, type DashboardTask } from "./model";
import {
  buildDay,
  currentMinute,
  formatClock,
  formatDayLabel,
  formatDuration,
  formatHourLabel,
  hourBounds,
  timelineItems,
  weekDays,
  type DayEntry,
  type DayView,
  type ScheduleData,
  type TimelineItem,
} from "./schedule";
import styles from "./workspace.module.css";

const HOUR_PX = 46;

const removeLabel = (item: TimelineItem) =>
  `${item.kind === "event" ? "Cancel event" : "Remove work block"}: ${item.title}`;

function useDays(
  schedule: ScheduleData,
  tasks: DashboardTask[],
  timezone: string,
  dates: DateKey[],
) {
  const items = timelineItems(schedule);
  const days = dates.map((date) => buildDay(date, items, tasks, timezone));
  return { days, bounds: hourBounds(days) };
}

function EntryBlock({
  entry,
  top,
  timezone,
  pending,
  onRemove,
}: {
  entry: DayEntry;
  top: number;
  timezone: string;
  pending: boolean;
  onRemove: (item: TimelineItem) => void;
}) {
  const { item } = entry;
  const height = Math.max(((entry.endMinute - entry.startMinute) / 60) * HOUR_PX, 20);
  const time = `${formatClock(item.start, timezone)} to ${formatClock(item.end, timezone)}`;
  const kind = item.kind === "event" ? "Event" : "Work block";
  const label = `${kind}: ${item.title}, ${time}${item.conflict ? ", conflict: overlaps another scheduled item" : ""}`;
  return (
    <div
      className={`${styles.slot} ${item.kind === "event" ? styles.slotEvent : styles.slotWork} ${
        item.conflict ? styles.slotConflict : ""
      }`}
      style={{
        top: ((entry.startMinute - top) / 60) * HOUR_PX,
        height,
        left: `calc(${(entry.column / entry.columns) * 100}% + 2px)`,
        width: `calc(${100 / entry.columns}% - 4px)`,
      }}
      title={label}
      aria-label={label}
      role="group"
    >
      <span className={styles.slotTitle}>
        {item.conflict ? (
          <TriangleAlert size={12} aria-hidden="true" />
        ) : item.kind === "event" ? (
          <CalendarClock size={12} aria-hidden="true" />
        ) : (
          <Timer size={12} aria-hidden="true" />
        )}
        {kind}: {item.title}
      </span>
      {item.conflict ? <span className={styles.conflictBadge}>Conflict</span> : null}
      {height >= 38 ? <span className={styles.slotTime}>{time}</span> : null}
      <button
        type="button"
        className={styles.slotRemove}
        disabled={pending}
        aria-label={removeLabel(item)}
        title={removeLabel(item)}
        onClick={() => onRemove(item)}
      >
        <X size={12} aria-hidden="true" />
      </button>
    </div>
  );
}

function DeadlineBlock({
  entry,
  timezone,
  topMinute,
}: {
  entry: DayView["deadlineEntries"][number];
  timezone: string;
  topMinute: number;
}) {
  const { task } = entry;
  if (!task.dueAt || task.dueDateOnly) return null;
  const due = new Date(task.dueAt);
  if (Number.isNaN(due.getTime())) return null;
  const time = formatClock(due.getTime(), timezone);
  const label = `${entry.conflict ? "Nearby deadline conflict. " : ""}Due at ${time}: ${task.title}`;
  return (
    <div
      className={`${styles.slotDeadline} ${entry.conflict ? styles.slotConflict : ""}`}
      style={{
        top: ((entry.dueMinute - topMinute) / 60) * HOUR_PX,
        transform: "translateY(-50%)",
        left: `calc(${(entry.column / entry.columns) * 100}% + 2px)`,
        maxWidth: `calc(${100 / entry.columns}% - 8px)`,
      }}
      title={label}
      aria-label={label}
      role="note"
    >
      <Flag size={12} aria-hidden="true" />
      <span>
        Due {time}: {task.title}
      </span>
      {entry.conflict ? <span className={styles.conflictBadge}>Conflict</span> : null}
    </div>
  );
}

function DayChips({
  day,
  pending,
  onRemove,
}: {
  day: DayView;
  pending: boolean;
  onRemove: (item: TimelineItem) => void;
}) {
  const headerDeadlines = day.deadlines.filter((task) => task.dueDateOnly || !task.dueAt);
  return (
    <div className={styles.dayChips}>
      {day.allDay.slice(0, 2).map((item) => (
        <span key={item.key} className={styles.chipAllDay} title={item.title}>
          <span className={styles.chipText}>{item.title}</span>
          <button
            type="button"
            className={styles.chipRemove}
            disabled={pending}
            aria-label={removeLabel(item)}
            onClick={() => onRemove(item)}
          >
            <X size={10} aria-hidden="true" />
          </button>
        </span>
      ))}
      {headerDeadlines.slice(0, 2).map((task) => (
        <span key={task.id} className={styles.chipDue} title={`Due: ${task.title}`}>
          <Flag size={10} aria-hidden="true" />
          {task.title}
        </span>
      ))}
      {day.allDay.length + headerDeadlines.length > 4 ? (
        <span className={styles.chipMore}>
          +{day.allDay.length + headerDeadlines.length - 4} more
        </span>
      ) : null}
    </div>
  );
}

function TimeGrid({
  days,
  bounds,
  timezone,
  today,
  now,
  pending,
  onRemove,
}: {
  days: DayView[];
  bounds: { start: number; end: number };
  timezone: string;
  today: DateKey;
  now: Date;
  pending: boolean;
  onRemove: (item: TimelineItem) => void;
}) {
  const hours = Array.from(
    { length: bounds.end - bounds.start },
    (_, index) => bounds.start + index,
  );
  const columns = `3.4rem repeat(${days.length}, minmax(0, 1fr))`;
  const topMinute = bounds.start * 60;
  const gridHeight = hours.length * HOUR_PX;
  return (
    <div className={styles.grid} role="table" aria-label="Schedule">
      <div className={styles.gridHead} style={{ gridTemplateColumns: columns }} role="row">
        <span role="columnheader" />
        {days.map((day) => (
          <div
            key={day.date}
            role="columnheader"
            className={`${styles.gridHeadCell} ${day.date === today ? styles.gridToday : ""}`}
          >
            <span className={styles.gridDayName}>{formatDayLabel(day.date)}</span>
            {day.date <= today ? (
              <span className={styles.calendarDayStatus}>
                {day.date < today ? "Past" : "Today"}
              </span>
            ) : null}
            <DayChips day={day} pending={pending} onRemove={onRemove} />
          </div>
        ))}
      </div>
      <div className={styles.gridBody} style={{ gridTemplateColumns: columns }} role="row">
        <div className={styles.hourAxis} style={{ height: gridHeight }} aria-hidden="true">
          {hours.map((hour) => (
            <span key={hour} style={{ height: HOUR_PX }}>
              {formatHourLabel(hour)}
            </span>
          ))}
        </div>
        {days.map((day) => {
          const nowMinute = currentMinute(timezone, day.date, now);
          return (
            <div
              key={day.date}
              role="cell"
              className={`${styles.dayColumn} ${day.date === today ? styles.gridToday : ""}`}
              style={{
                height: gridHeight,
                backgroundSize: `100% ${HOUR_PX}px`,
              }}
            >
              {day.entries.map((entry) => (
                <EntryBlock
                  key={entry.item.key + day.date}
                  entry={entry}
                  top={topMinute}
                  timezone={timezone}
                  pending={pending}
                  onRemove={onRemove}
                />
              ))}
              {day.deadlineEntries.map((entry) => (
                <DeadlineBlock
                  key={`deadline:${entry.task.id}`}
                  entry={entry}
                  timezone={timezone}
                  topMinute={topMinute}
                />
              ))}
              {nowMinute !== null && nowMinute >= topMinute && nowMinute <= bounds.end * 60 ? (
                <span
                  className={styles.nowLine}
                  style={{ top: ((nowMinute - topMinute) / 60) * HOUR_PX }}
                  aria-label="Current time"
                />
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}

function DaySummary({ day }: { day: DayView }) {
  return (
    <ul className={styles.daySummary} aria-label="Day summary">
      <li>
        <CalendarClock size={14} aria-hidden="true" />
        {day.entries.filter((entry) => entry.item.kind === "event").length} events
      </li>
      <li>
        <Timer size={14} aria-hidden="true" />
        {day.plannedMinutes > 0
          ? `${formatDuration(day.plannedMinutes)} planned`
          : "No work planned"}
      </li>
      <li>
        <Flag size={14} aria-hidden="true" />
        {day.deadlines.length} due
        {day.dueEffortMinutes > 0 ? ` (${formatDuration(day.dueEffortMinutes)} of work)` : ""}
      </li>
      {day.conflictCount > 0 ? (
        <li className={styles.summaryConflict}>
          <TriangleAlert size={14} aria-hidden="true" />
          {day.conflictCount} overlapping
        </li>
      ) : null}
    </ul>
  );
}

function RemoveButton({
  item,
  pending,
  onRemove,
}: {
  item: TimelineItem;
  pending: boolean;
  onRemove: (item: TimelineItem) => void;
}) {
  return (
    <button
      type="button"
      className={styles.itemAction}
      disabled={pending}
      aria-label={removeLabel(item)}
      onClick={() => onRemove(item)}
    >
      <X size={12} aria-hidden="true" />
      {item.kind === "event" ? "Cancel" : "Remove"}
    </button>
  );
}

function AgendaList({
  day,
  timezone,
  now,
  pending,
  onComplete,
  onRemove,
}: {
  day: DayView;
  timezone: string;
  now: Date;
  pending: boolean;
  onComplete: (id: string) => void;
  onRemove: (item: TimelineItem) => void;
}) {
  const empty =
    day.entries.length + day.allDay.length + day.deadlines.length + day.completed.length === 0;
  return (
    <div className={styles.agenda}>
      {day.allDay.length > 0 ? (
        <section>
          <h3 className={styles.agendaHeading}>
            <CalendarDays size={14} aria-hidden="true" /> All day
          </h3>
          <ul className={styles.agendaList}>
            {day.allDay.map((item) => (
              <li key={item.key}>
                {item.title}
                <RemoveButton item={item} pending={pending} onRemove={onRemove} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {day.entries.length > 0 ? (
        <section>
          <h3 className={styles.agendaHeading}>
            <CalendarClock size={14} aria-hidden="true" /> Schedule
          </h3>
          <ul className={styles.agendaList}>
            {day.entries.map(({ item }) => (
              <li key={item.key} className={item.conflict ? styles.agendaConflict : undefined}>
                <span className={styles.agendaTime}>
                  {formatClock(item.start, timezone)} to {formatClock(item.end, timezone)}
                </span>
                <span>
                  {item.kind === "work" ? <Timer size={13} aria-hidden="true" /> : null}
                  {item.title}
                  {item.location ? (
                    <span className={styles.agendaMeta}>
                      <MapPin size={11} aria-hidden="true" /> {item.location}
                    </span>
                  ) : null}
                  {item.conflict ? (
                    <span className={styles.agendaWarn}>
                      <TriangleAlert size={12} aria-hidden="true" /> Overlaps another item
                    </span>
                  ) : null}
                </span>
                <RemoveButton item={item} pending={pending} onRemove={onRemove} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {day.deadlines.length > 0 ? (
        <section>
          <h3 className={styles.agendaHeading}>
            <Flag size={14} aria-hidden="true" /> Due
          </h3>
          <ul className={styles.agendaList}>
            {day.deadlines.map((task) => (
              <li key={task.id}>
                <button
                  type="button"
                  className={`${styles.secondaryButton} ${styles.agendaComplete}`}
                  disabled={pending}
                  aria-label={`Complete ${task.title}`}
                  onClick={() => onComplete(task.id)}
                >
                  Mark done
                </button>
                <span>
                  {task.title}
                  <span className={styles.agendaMeta}>
                    {!task.dueDateOnly && task.dueAt
                      ? `Due at ${formatClock(new Date(task.dueAt).getTime(), timezone)} · `
                      : ""}
                    {countdownLabel(task.dueAt, timezone, task.dueDateOnly, now)}
                    {task.estimatedMinutes ? ` · ${formatDuration(task.estimatedMinutes)}` : ""}
                  </span>
                </span>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {day.completed.length > 0 ? (
        <section>
          <h3 className={styles.agendaHeading}>
            <CircleCheck size={14} aria-hidden="true" /> Completed
          </h3>
          <ul className={styles.agendaList}>
            {day.completed.map((task) => (
              <li key={task.id} className={styles.agendaDone}>
                {task.title}
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {empty ? <p className={styles.agendaEmpty}>Nothing scheduled, due, or finished.</p> : null}
    </div>
  );
}

interface ScheduleViewProps {
  schedule: ScheduleData;
  tasks: DashboardTask[];
  timezone: string;
  today: DateKey;
  now: Date;
  pending: boolean;
  onComplete: (id: string) => void;
  onRemove: (item: TimelineItem) => void;
  date?: DateKey;
}

export function TodayView({
  schedule,
  tasks,
  timezone,
  today,
  now,
  pending,
  onComplete,
  onRemove,
  date = today,
}: ScheduleViewProps) {
  const { days, bounds } = useDays(schedule, tasks, timezone, [date]);
  const day = days[0]!;
  return (
    <div className={styles.todayLayout}>
      <div className={styles.todayMain}>
        <DaySummary day={day} />
        <TimeGrid
          days={days}
          bounds={bounds}
          timezone={timezone}
          today={today}
          now={now}
          pending={pending}
          onRemove={onRemove}
        />
      </div>
      <aside className={styles.todayAside} aria-label={`${formatDayLabel(date, "long")} details`}>
        <AgendaList
          day={day}
          timezone={timezone}
          now={now}
          pending={pending}
          onComplete={onComplete}
          onRemove={onRemove}
        />
      </aside>
    </div>
  );
}

export function WeekView({
  schedule,
  tasks,
  timezone,
  today,
  now,
  pending,
  onComplete,
  onRemove,
}: ScheduleViewProps) {
  const { days, bounds } = useDays(schedule, tasks, timezone, weekDays(schedule.weekStart));
  return (
    <div>
      <div className={styles.weekGrid}>
        <TimeGrid
          days={days}
          bounds={bounds}
          timezone={timezone}
          today={today}
          now={now}
          pending={pending}
          onRemove={onRemove}
        />
      </div>
      <div className={styles.weekAgenda}>
        {days.map((day) => (
          <section
            key={day.date}
            className={`${styles.weekDayCard} ${day.date === today ? styles.gridToday : ""}`}
          >
            <h3 className={styles.weekDayTitle}>
              <CalendarRange size={14} aria-hidden="true" />
              {formatDayLabel(day.date, "long")}
            </h3>
            <DaySummary day={day} />
            <AgendaList
              day={day}
              timezone={timezone}
              now={now}
              pending={pending}
              onComplete={onComplete}
              onRemove={onRemove}
            />
          </section>
        ))}
      </div>
    </div>
  );
}
