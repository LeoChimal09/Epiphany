"use client";

import { useState } from "react";
import { saveBriefingSetting, saveSplitReminderSetting } from "./actions";
import styles from "../planning/settings.module.css";
import workspaceStyles from "../workspace.module.css";

export function SplitReminderFields({ count = null }: { count?: number | null }) {
  const [mode, setMode] = useState(count === null ? "default" : count === 0 ? "off" : "custom");
  return (
    <div className={workspaceStyles.fields}>
      <label>
        Split reminders (optional)
        <select
          name="splitReminderMode"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="default">Use workspace default</option>
          <option value="off">Off for this item</option>
          <option value="custom">Add split reminders for this item</option>
        </select>
      </label>
      {mode === "custom" ? (
        <label>
          Number of extra reminders
          <input
            name="splitReminderCount"
            type="number"
            min={1}
            max={100}
            step={1}
            defaultValue={count && count > 0 ? count : 2}
            required
          />
        </label>
      ) : null}
      <p className={workspaceStyles.fullWidth}>
        Saved with this item. Splits run before the task deadline or event start, within your awake
        window. Original alerts stay unchanged; quiet hours and the daily limit still apply. Events
        default to off unless you choose a count here. A todo needs a deadline before split
        reminders can run.
      </p>
    </div>
  );
}

export function SplitReminderSettings({
  value,
  dailyLimit,
  version,
}: {
  value: { enabled: boolean; count: number };
  dailyLimit: number;
  version?: number;
}) {
  const [enabled, setEnabled] = useState(value.enabled);
  const [count, setCount] = useState(String(value.count));
  const [savedVersion, setSavedVersion] = useState(version);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <details className={styles.section}>
      <summary>Optional split-day reminders</summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          setMessage("");
          try {
            const result = await saveSplitReminderSetting(
              { enabled, count: Number(count) },
              savedVersion,
            );
            setFailed(!result.ok);
            setMessage(result.ok ? "Saved." : result.error);
            if (result.ok) {
              setSavedVersion(result.version);
            }
          } catch {
            setFailed(true);
            setMessage("Could not confirm the save. Reload to check before trying again.");
          } finally {
            setPending(false);
          }
        }}
      >
        <fieldset disabled={pending} className={styles.fields}>
          <p>
            Extra check-ins for each unfinished task on its due day. Your original deadline and
            event alerts stay unchanged.
          </p>
          <p>
            Split the window from your morning briefing (8 AM if off) to the deadline or
            quiet/sleep/bedtime cutoff, whichever is earlier. Two reminders land halfway and
            three-quarters through; larger counts divide that window into more parts. Tasks added
            later start from their creation time.
          </p>
          <p>
            The morning brief is separate. Your daily limit of {dailyLimit} ordinary reminders still
            applies across all tasks and reminders; selecting a larger count does not raise it.
          </p>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />{" "}
            Add split-day reminders
          </label>
          <label>
            Extra reminders per task (1–100){" "}
            <input
              type="number"
              min={1}
              max={100}
              step={1}
              required
              value={count}
              onChange={(event) => setCount(event.target.value)}
            />
          </label>
          <button type="submit">{pending ? "Saving..." : "Save split reminder settings"}</button>
        </fieldset>
        {message ? <p role={failed ? "alert" : "status"}>{message}</p> : null}
      </form>
    </details>
  );
}

export function BriefingSettings({
  briefingTime,
  timezone,
  version,
}: {
  briefingTime: string | null;
  timezone: string;
  version?: number;
}) {
  const [enabled, setEnabled] = useState(briefingTime !== null);
  const [time, setTime] = useState(briefingTime ?? "08:00");
  const [savedVersion, setSavedVersion] = useState(version);
  const [message, setMessage] = useState("");
  const [pending, setPending] = useState(false);
  const [failed, setFailed] = useState(false);

  return (
    <details className={styles.section}>
      <summary>Morning briefing</summary>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          setPending(true);
          setMessage("");
          try {
            const result = await saveBriefingSetting(enabled ? time : null, savedVersion);
            setFailed(!result.ok);
            setMessage(result.ok ? "Saved." : result.error);
            if (result.ok) setSavedVersion(result.version);
          } catch {
            setFailed(true);
            setMessage("Could not confirm the save. Reload to check before trying again.");
          } finally {
            setPending(false);
          }
        }}
      >
        <fieldset disabled={pending} className={styles.fields}>
          <p>Choose when your morning briefing arrives. Times use {timezone}.</p>
          <p>
            A saved change updates pending briefings. If today&apos;s was already sent, it starts
            tomorrow.
          </p>
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => setEnabled(event.target.checked)}
            />{" "}
            Send morning briefing
          </label>
          {enabled ? (
            <label>
              Delivery time (AM/PM){" "}
              <input
                type="time"
                required
                value={time}
                onChange={(event) => setTime(event.target.value)}
              />
            </label>
          ) : null}
          <button type="submit">{pending ? "Saving..." : "Save briefing settings"}</button>
        </fieldset>
        {message ? <p role={failed ? "alert" : "status"}>{message}</p> : null}
      </form>
    </details>
  );
}
