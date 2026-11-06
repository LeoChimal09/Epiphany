"use client";

import { useState } from "react";
import { BellRing, Sunrise } from "lucide-react";
import { saveBriefingSetting, saveSplitReminderSetting } from "./actions";
import { clockSummary, DefaultEditor } from "../planning/default-editor";
import workspaceStyles from "../workspace.module.css";

export function SplitReminderFields({
  count = null,
  itemType = "task",
}: {
  count?: number | null;
  itemType?: "task" | "todo" | "event";
}) {
  const [mode, setMode] = useState(count === null ? "default" : count === 0 ? "off" : "custom");
  if (itemType === "todo") {
    return (
      <p className={workspaceStyles.fullWidth}>
        Todos have no deadline, so split reminders do not apply.
      </p>
    );
  }
  return (
    <div className={workspaceStyles.fields}>
      <label>
        Split reminders (optional)
        <select
          name="splitReminderMode"
          value={mode}
          onChange={(event) => setMode(event.target.value)}
        >
          <option value="default">
            {itemType === "event" ? "Off (event default)" : "Use workspace default"}
          </option>
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
        window. Original alerts stay unchanged; quiet hours and the daily limit still apply.
        {itemType === "event" ? " Events default to off unless you choose a count here." : ""}
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
  return (
    <DefaultEditor
      title="Extra task reminders"
      icon={BellRing}
      value={{ enabled, count: Number(count) }}
      summary={(saved) =>
        saved.enabled ? `${saved.count} extra per task · on due day` : "Off · original alerts only"
      }
      onReset={(saved) => {
        setEnabled(saved.enabled);
        setCount(String(saved.count));
      }}
      onSave={async (draft) => {
        const result = await saveSplitReminderSetting(draft, savedVersion);
        if (result.ok) {
          setSavedVersion(result.version);
        }
        return result;
      }}
    >
      <p>
        Before deadlines, within awake hours. Original alerts stay unchanged. Individual task
        choices override this default; daily limit: {dailyLimit}.
      </p>
      <label>
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => setEnabled(event.target.checked)}
        />{" "}
        Add split-day reminders
      </label>
      {enabled ? (
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
      ) : null}
    </DefaultEditor>
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
  return (
    <DefaultEditor
      title="Morning briefing"
      icon={Sunrise}
      value={enabled ? time : null}
      summary={(saved) => (saved ? `Daily at ${clockSummary(saved)}` : "Off")}
      onReset={(saved) => {
        setEnabled(saved !== null);
        setTime(saved ?? "08:00");
      }}
      onSave={async (draft) => {
        const result = await saveBriefingSetting(draft, savedVersion);
        if (result.ok) setSavedVersion(result.version);
        return result;
      }}
    >
      <p>
        Times use {timezone}. Overrides quiet hours, not pauses or the daily limit. Updates pending
        briefings; if today&apos;s was sent, starts tomorrow.
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
    </DefaultEditor>
  );
}
