"use client";

import type { FormEvent } from "react";
import type { DateKey } from "@epiphany/core/planning";
import type { DashboardTask } from "./model";
import styles from "./workspace.module.css";

export type ScheduleComposerKind = "event" | "block";

export function ScheduleComposer({
  kind,
  timezone,
  tasks,
  defaultDate,
  pending,
  onSubmit,
  onCancel,
}: {
  kind: ScheduleComposerKind;
  timezone: string;
  tasks: DashboardTask[];
  defaultDate: DateKey;
  pending: boolean;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onCancel: () => void;
}) {
  const isEvent = kind === "event";
  const openTasks = tasks.filter((task) => task.status === "open");
  return (
    <section className={styles.composer} aria-label={isEvent ? "New event" : "New work block"}>
      <div className={styles.composerHeading}>
        <h2>{isEvent ? "New event" : "Plan a work block"}</h2>
        <button type="button" className={styles.textButton} disabled={pending} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <form onSubmit={onSubmit}>
        <fieldset disabled={pending} className={styles.fields}>
          <label className={styles.fullWidth}>
            {isEvent ? "Title" : "Title (optional)"}
            <input name="title" required={isEvent} maxLength={300} autoFocus />
          </label>
          <label>
            Date ({timezone})
            <input name="date" type="date" required defaultValue={defaultDate} />
          </label>
          {isEvent ? (
            <label>
              Location (optional)
              <input name="location" maxLength={300} />
            </label>
          ) : (
            <label>
              Task (optional)
              <select name="taskId" defaultValue="">
                <option value="">Not tied to a task</option>
                {openTasks.map((task) => (
                  <option key={task.id} value={task.id}>
                    {task.title}
                  </option>
                ))}
              </select>
            </label>
          )}
          <label>
            Starts
            <input name="startTime" type="time" defaultValue="09:00" />
          </label>
          <label>
            Ends
            <input name="endTime" type="time" defaultValue="10:00" />
          </label>
          {isEvent ? (
            <label className={styles.inlineCheck}>
              <input name="allDay" type="checkbox" />
              All day (ignores the times)
            </label>
          ) : null}
          <div className={styles.formFooter}>
            <button className={styles.primaryButton} type="submit">
              {pending ? "Saving..." : isEvent ? "Save event" : "Save work block"}
            </button>
          </div>
        </fieldset>
      </form>
    </section>
  );
}
