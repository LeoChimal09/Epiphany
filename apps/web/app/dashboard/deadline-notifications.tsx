"use client";

import { useId, useState } from "react";
import { Bell, Check } from "lucide-react";
import {
  deadlineNotifications,
  formatDate,
  type DashboardTask,
  type DeadlineNotification,
} from "./model";
import styles from "./workspace.module.css";

const PAGE_SIZE = 5;

export function DeadlineNotifications({
  tasks,
  timezone,
  now,
  pending,
  truncated,
  onComplete,
  onOpen,
  onHistory,
}: {
  tasks: DashboardTask[];
  timezone: string;
  now: Date;
  pending: boolean;
  truncated: boolean;
  onComplete: (id: string) => void;
  onOpen: (task: DashboardTask) => void;
  onHistory: () => void;
}) {
  const [requestedPage, setRequestedPage] = useState(0);
  const popoverId = useId();
  const notifications = deadlineNotifications(tasks, timezone, now);
  const pages = Math.max(1, Math.ceil(notifications.length / PAGE_SIZE));
  const page = Math.min(requestedPage, pages - 1);
  const items = notifications.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);
  return (
    <div className={styles.notificationBell}>
      <button
        type="button"
        className={styles.notificationButton}
        popoverTarget={popoverId}
        aria-label={`Notifications: ${notifications.length}${truncated ? "+" : ""} deadlines need attention`}
      >
        <Bell size={20} aria-hidden="true" />
        {notifications.length > 0 || truncated ? (
          <span className={styles.notificationBadge} aria-hidden="true">
            {notifications.length}
            {truncated ? "+" : ""}
          </span>
        ) : null}
      </button>
      <section
        id={popoverId}
        popover="auto"
        className={styles.notifications}
        aria-label="Deadline notifications"
        aria-busy={pending}
      >
        <h2 className={styles.sectionHeading}>
          <Bell size={17} aria-hidden="true" /> Notifications
          <span className={styles.count}>
            {notifications.length}
            {truncated ? "+" : ""}
          </span>
        </h2>
        <button
          type="button"
          className={styles.textButton}
          popoverTarget={popoverId}
          popoverTargetAction="hide"
        >
          Close notifications
        </button>
        <p className={styles.limitNotice}>
          Timed deadlines appear within one hour, then stay overdue until you explicitly mark them
          done. No response never means completed.
        </p>
        <DeadlineNotificationItems
          items={items}
          timezone={timezone}
          pending={pending}
          onComplete={onComplete}
          onOpen={onOpen}
        />
        {pages > 1 ? (
          <nav className={styles.rowActions} aria-label="Notification pages">
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending || page === 0}
              onClick={() => setRequestedPage(page - 1)}
            >
              Previous notifications
            </button>
            <span role="status">
              Page {page + 1} of {pages}
            </span>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending || page === pages - 1}
              onClick={() => setRequestedPage(page + 1)}
            >
              Next notifications
            </button>
          </nav>
        ) : null}
        <p className={styles.limitNotice}>
          Updates while this dashboard is open. Background Discord DMs require the reminder worker
          running and DMs enabled; quiet hours, pause and daily limits still apply.
        </p>
        {truncated ? (
          <p className={styles.limitNotice}>
            Only loaded tasks are checked (first 100 open tasks). Older or additional tasks may have
            deadlines too.{" "}
            <button
              type="button"
              className={styles.textButton}
              disabled={pending}
              onClick={onHistory}
            >
              Browse all task history
            </button>
          </p>
        ) : null}
      </section>
    </div>
  );
}

export function DeadlineNotificationItems({
  items,
  timezone,
  pending,
  onComplete,
  onOpen,
}: {
  items: DeadlineNotification[];
  timezone: string;
  pending: boolean;
  onComplete: (id: string) => void;
  onOpen: (task: DashboardTask) => void;
}) {
  if (!items.length)
    return <p className={styles.limitNotice}>No deadlines need attention right now.</p>;
  return (
    <ul className={styles.taskList}>
      {items.map(({ task, kind, label }) => (
        <li key={task.id} className={styles.task}>
          <div className={styles.taskContent}>
            <h3>{task.title}</h3>
            <div className={styles.taskMeta}>
              <span className={kind === "overdue" ? styles.overdue : styles.countdown}>
                {label}
              </span>
              <span>{formatDate(task.dueAt, timezone, task.dueDateOnly)}</span>
            </div>
          </div>
          <div className={styles.rowActions}>
            <button
              type="button"
              className={styles.secondaryButton}
              disabled={pending}
              aria-label={`View task ${task.title}`}
              onClick={() => onOpen(task)}
            >
              View task
            </button>
            <button
              type="button"
              className={styles.primaryButton}
              disabled={pending}
              aria-label={`Mark done: ${task.title}`}
              onClick={() => onComplete(task.id)}
            >
              <Check size={14} aria-hidden="true" /> Mark done
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
}
