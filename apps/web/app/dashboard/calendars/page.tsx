import Link from "next/link";
import { verifySession } from "../../../lib/auth/dal";
import { calendarServices, getGoogleDeps } from "../../../lib/google/deps";
import { redirect } from "next/navigation";
import type { BlockSyncView, CalendarOverview, CalendarView } from "@epiphany/core/calendar";
import { resolveCalendarConflict, saveCalendarSelection } from "./actions";
import styles from "./calendars.module.css";

export const dynamic = "force-dynamic";

const NOTICES: Record<string, { text: string; error: boolean }> = {
  connected: {
    text: "Google Calendar connected. The background worker must be running for your calendars to appear after the first sync. Refresh this page after a minute or two.",
    error: false,
  },
  disconnected: {
    text: "Disconnected. Access was revoked at Google and the saved tokens were deleted.",
    error: false,
  },
  disconnected_unrevoked: {
    text: "Disconnected and the saved tokens were deleted, but Google could not be reached to revoke them. Remove Epiphany at myaccount.google.com/permissions to be sure.",
    error: true,
  },
  saved: {
    text: "Calendar choices saved. Newly chosen calendars sync within a minute or two.",
    error: false,
  },
  resolved: { text: "Done. The block will update on the next sync.", error: false },
  denied: { text: "Google sign-in was canceled. Nothing was connected.", error: true },
  invalid: {
    text: "That connection attempt was not valid or expired. Please try again.",
    error: true,
  },
  not_configured: {
    text: "Google Calendar is not set up on this server. Set GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY (see docs/calendar.md), then restart.",
    error: true,
  },
  scope_missing: {
    text: "Google did not grant calendar read access, so nothing was connected. Try again and allow it.",
    error: true,
  },
  other_account: {
    text: "A different Google account is already connected. Disconnect it first.",
    error: true,
  },
  no_offline_access: {
    text: "Google did not allow offline access. Remove Epiphany at myaccount.google.com/permissions, then connect again.",
    error: true,
  },
  failed: { text: "That did not work. Nothing was changed; try again in a moment.", error: true },
};

const SYNC_LABEL: Record<CalendarView["syncStatus"], string> = {
  pending: "Waiting for first sync",
  ok: "Up to date",
  stale: "Out of date",
  error: "Sync problem",
};

const BLOCK_LABEL: Record<BlockSyncView["state"], string> = {
  pending: "Waiting to sync",
  uncertain: "Confirming with Google",
  conflict: "Changed in Google: needs your decision",
  remote_deleted: "Deleted in Google: needs your decision",
  synced: "In sync",
  removed: "Removed",
  detached: "Not mirrored",
};

function formatTime(date: Date | null, timezone: string): string {
  if (!date) return "never";
  return new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    dateStyle: "medium",
    timeStyle: "short",
  }).format(date);
}

function ConnectButtons({ label }: { label: string }) {
  return (
    <div className={styles.actions}>
      <a className={styles.primary} href="/api/google/connect">
        {label}
      </a>
      <a className={styles.secondary} href="/api/google/connect?mode=read">
        Read-only (no Epiphany calendar)
      </a>
    </div>
  );
}

function Panel({ overview, timezone }: { overview: CalendarOverview; timezone: string }) {
  const { account } = overview;
  const active = account && account.status !== "revoked";
  if (!account || !active) {
    return (
      <section className={styles.card}>
        <h2>Connect Google Calendar</h2>
        <p className={styles.muted}>
          Epiphany reads the calendars you choose so it knows when you are busy. It writes only to
          its own &quot;Epiphany&quot; calendar, never to your other calendars. You can disconnect
          at any time.
        </p>
        <ConnectButtons label="Connect Google Calendar" />
      </section>
    );
  }

  const external = overview.calendars.filter((c) => c.kind === "external");
  const dedicated = overview.calendars.find((c) => c.kind === "epiphany");
  return (
    <>
      <section className={styles.card}>
        <h2>Google Calendar</h2>
        <p>
          <span className={account.status === "connected" ? styles.good : styles.bad}>
            {account.status === "connected" ? "Connected" : "Needs to be connected again"}
          </span>
          {account.email ? <span className={styles.muted}> · {account.email}</span> : null}
        </p>
        <p className={styles.muted}>
          {account.canWrite
            ? "Read and write: work blocks go to the Epiphany calendar only."
            : "Read-only: nothing is written to Google."}
        </p>
        {account.canWrite ? (
          <p className={styles.muted}>
            Tasks with due dates are added to the Epiphany calendar as deadline events (all-day if
            no due time was set). Scheduled work blocks appear separately as work sessions.
          </p>
        ) : null}
        {account.status === "needs_reauth" ? (
          <>
            <p className={styles.alert} role="alert">
              {account.lastError ?? "Google access expired or was revoked."} Calendar data is not
              being updated until you connect again.
            </p>
            <ConnectButtons label="Connect again" />
          </>
        ) : account.lastError ? (
          <p className={styles.alert} role="alert">
            Last sync problem: {account.lastError}
          </p>
        ) : null}
      </section>

      {account.status === "connected" ? (
        <section className={styles.card}>
          <h2>Calendars Epiphany reads</h2>
          {external.length === 0 ? (
            <div className={styles.muted}>
              <p>Waiting for the first sync to list your calendars.</p>
              <p>
                Sync runs in the background worker, not the website server. For local testing, run{" "}
                <code>bun run bot:start</code> from the project root in a separate terminal (this
                also starts Discord and reminders). On Railway, keep the worker service running.
                Both services need the same database and Google credentials, including
                TOKEN_ENCRYPTION_KEY.
              </p>
              <p>Refresh this page after a minute or two to check the sync status.</p>
            </div>
          ) : (
            <form action={saveCalendarSelection}>
              <ul className={styles.list}>
                {external.map((calendar) => (
                  <li key={calendar.id}>
                    <label className={styles.row}>
                      <input
                        type="checkbox"
                        name="calendar"
                        value={calendar.id}
                        defaultChecked={calendar.selected}
                      />
                      <span>
                        <strong>{calendar.summary}</strong>
                        {calendar.isPrimary ? (
                          <span className={styles.muted}> (primary)</span>
                        ) : null}
                        {calendar.selected ? (
                          <span
                            className={calendar.syncStatus === "ok" ? styles.good : styles.warn}
                          >
                            {" "}
                            · {SYNC_LABEL[calendar.syncStatus]}
                            <span className={styles.muted}>
                              {" "}
                              (last synced {formatTime(calendar.lastSyncedAt, timezone)})
                            </span>
                          </span>
                        ) : null}
                        {calendar.lastError ? (
                          <span className={styles.errorText}> {calendar.lastError}</span>
                        ) : null}
                      </span>
                    </label>
                  </li>
                ))}
              </ul>
              <button type="submit" className={styles.primary}>
                Save choices
              </button>
            </form>
          )}
          {dedicated ? (
            <p className={styles.muted}>
              Epiphany calendar: {SYNC_LABEL[dedicated.syncStatus].toLowerCase()} (last synced{" "}
              {formatTime(dedicated.lastSyncedAt, timezone)}).
              {dedicated.lastError ? ` ${dedicated.lastError}` : ""}
            </p>
          ) : account.canWrite ? (
            <p className={styles.muted}>The Epiphany calendar is created on the first sync.</p>
          ) : null}
        </section>
      ) : null}

      {account.canWrite && overview.blocks.length > 0 ? (
        <section className={styles.card}>
          <h2>Work blocks waiting to sync</h2>
          <ul className={styles.list}>
            {overview.blocks.map((block) => (
              <li key={block.workBlockId} className={styles.blockRow}>
                <span>
                  <strong>{block.title ?? "Work block"}</strong>
                  <span className={styles.muted}> · {formatTime(block.startsAt, timezone)}</span>
                  <br />
                  <span
                    className={
                      block.state === "conflict" || block.state === "remote_deleted"
                        ? styles.bad
                        : styles.warn
                    }
                  >
                    {BLOCK_LABEL[block.state]}
                  </span>
                  {block.error ? <span className={styles.muted}> {block.error}</span> : null}
                </span>
                {block.state === "conflict" || block.state === "remote_deleted" ? (
                  <form action={resolveCalendarConflict} className={styles.actions}>
                    <input type="hidden" name="blockId" value={block.workBlockId} />
                    <button name="choice" value="keep_google" className={styles.secondary}>
                      Keep Google&apos;s version
                    </button>
                    {block.state === "conflict" ? (
                      <button name="choice" value="overwrite_google" className={styles.secondary}>
                        Overwrite with Epiphany&apos;s
                      </button>
                    ) : null}
                  </form>
                ) : null}
              </li>
            ))}
          </ul>
        </section>
      ) : null}

      <section className={styles.card}>
        <h2>Disconnect</h2>
        <p className={styles.muted}>
          Revokes Epiphany&apos;s access at Google, deletes the saved tokens, and stops all calendar
          syncing. Events imported from Google are hidden (kept as canceled). Events Epiphany
          already put on its own Google calendar stay there until you delete them.
        </p>
        <form action="/api/google/disconnect" method="post">
          <button type="submit" className={styles.danger}>
            Disconnect Google Calendar
          </button>
        </form>
      </section>
    </>
  );
}

export default async function CalendarsPage({
  searchParams,
}: {
  searchParams: Promise<{ notice?: string }>;
}) {
  const principal = await verifySession();
  const deps = getGoogleDeps();
  if (!deps) redirect("/login");
  const { notice } = await searchParams;
  const message = notice ? NOTICES[notice] : undefined;

  let overview: CalendarOverview | null = null;
  try {
    overview = await calendarServices(deps).calendar.overview(principal);
  } catch {
    console.error(JSON.stringify({ service: "dashboard", event: "calendar_overview_failed" }));
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <Link href="/dashboard" className={styles.back}>
          ← Dashboard
        </Link>
        <h1>Calendars</h1>
      </header>
      {message ? (
        <p className={message.error ? styles.alert : styles.success} role="status">
          {message.text}
        </p>
      ) : null}
      {!deps.calendar && notice !== "not_configured" ? (
        <p className={styles.alert} role="status">
          {NOTICES.not_configured!.text}
        </p>
      ) : null}
      {overview ? (
        <Panel overview={overview} timezone={deps.auth.config.timezone} />
      ) : (
        <p className={styles.alert} role="alert">
          Calendar status could not be loaded. Try again in a moment.
        </p>
      )}
    </main>
  );
}
