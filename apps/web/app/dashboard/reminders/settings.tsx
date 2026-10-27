"use client";

import { useState } from "react";
import { saveBriefingSetting } from "./actions";
import styles from "../planning/settings.module.css";

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
          <p>Choose when your morning briefing is delivered. Times use {timezone}.</p>
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
              Delivery time{" "}
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
