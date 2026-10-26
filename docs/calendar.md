# Google Calendar

Goal 11. Epiphany can read the Google calendars you choose and mirror task deadlines, scheduled
events, and planned work blocks to one dedicated **"Epiphany"** calendar. It never writes to your
other calendars.

**Status:** implemented and tested offline against an in-memory Google. It has not been run against
a real Google account yet; the live checks that remain are listed at the end.

## What it does

- **Connect** (Dashboard > account menu > Calendars > "Connect Google Calendar"): Google's consent
  screen, then Epiphany stores encrypted tokens. Choose "Read-only" to skip the write permission
  (no Epiphany calendar, nothing is ever written to Google).
- **Read**: the primary calendar is read by default the first time; tick other calendars on the
  Calendars page. Events become fixed events in Epiphany: timed, all-day (kept on their own calendar
  days), with their own timezone, and every instance of a recurring event stored separately with its
  series ID. Cancelled or deleted events become canceled (kept, never deleted). Window: the past 30 and
  next 180 days, re-read in full weekly.
- **Write**: tasks with due dates, scheduled events, and planned work blocks are created, updated,
  and removed on the "Epiphany" calendar only. Date-only task deadlines become all-day events;
  timed task deadlines become 15-minute markers beginning at the due time. An estimate describes
  effort only; it does not shift a deadline or reserve calendar time. The Dashboard's single **Add
  task** entry point offers an explicit **Task — due date or deadline** versus **Event — start and
  end time** choice. Events can use a start/end range or a start time plus duration; both create the
  same actual calendar interval. Work blocks also occupy their actual start-to-end interval. A task
  without a due date is not exported. Events have stable IDs and
  private keys (`epiphanyKey`), so retries do not create duplicates and Epiphany recognizes its own
  events rather than importing them again.
- **Dashboard timeline**: task deadlines remain compact deadline markers; only events and work
  blocks occupy duration-sized blocks. Overlapping scheduled intervals share side-by-side lanes and
  are highlighted red; the day agenda remains available for reading every item.
- **Conflicts**: if you edit or delete an Epiphany event in Google Calendar, the block is flagged
  ("Changed in Google" / "Deleted in Google") instead of being overwritten, and the Calendars page
  offers "Keep Google's version" (stop mirroring that block) or "Overwrite with Epiphany's" (the next
  sync writes Epiphany's version, still conditional on Google's current version). A deleted event can
  only be kept as is. Deleting a Google event never deletes the work block or its task.
- **Uncertain writes**: if a create or update times out, Epiphany does not retry blindly. The next run
  looks the event up by its private key; only if it is not there is it created again.
- **Visible state**: each calendar shows up to date / out of date (no successful sync in 20 minutes) /
  sync problem with its last error; work blocks that are not yet in Google are listed as waiting,
  confirming, or needing your decision. Expired or revoked access shows "needs to be connected
  again" and nothing syncs until you do.
- **Disconnect**: tokens are deleted and the account is marked revoked first (so nothing can sync,
  even mid-run), then the token is revoked at Google. If Google cannot be reached the page says so;
  you can also remove Epiphany at <https://myaccount.google.com/permissions>. Events imported from
  Google are kept as canceled (hidden); reconnecting revives them without duplicates. Events Epiphany
  already wrote to its own Google calendar stay there until you delete that calendar.

## Owner setup

1. **Google Cloud console** (<https://console.cloud.google.com/>): create or pick a project.
2. **APIs & Services > Library**: enable **Google Calendar API**.
3. **APIs & Services > OAuth consent screen** (Google Auth platform): app type **External**, add an app
   name and your email. Leave it in **Testing** and add your own Google account under **Test users**.
   (Testing mode shows an "unverified app" warning and expires refresh tokens after 7 days; for
   lasting use, publish the app to production, which for personal use of sensitive scopes still shows
   the warning but does not expire the token, or reconnect weekly.)
4. **Data access / Scopes**: add `.../auth/calendar.readonly`, `.../auth/calendar.app.created`, `openid`,
   and `email`. (Epiphany asks for nothing broader; it cannot edit calendars it did not create.)
5. **Credentials > Create credentials > OAuth client ID**: type **Web application**. Under
   **Authorized redirect URIs** add exactly `<APP_URL>/api/google/callback`, for example
   `https://your-dashboard.example.com/api/google/callback`, and for local development
   `http://localhost:3000/api/google/callback`. Copy the client ID and secret.
6. Generate the encryption key: `openssl rand -base64 32`. Keep a copy somewhere safe, outside Railway.
7. Set these variables (`.env` locally, **service variables on Railway** for both the dashboard and the
   worker service; the worker needs all three too):

   | Variable                | Value                                                         |
   | ----------------------- | ------------------------------------------------------------- |
   | `GOOGLE_CLIENT_ID`      | OAuth client ID                                               |
   | `GOOGLE_CLIENT_SECRET`  | OAuth client secret                                           |
   | `TOKEN_ENCRYPTION_KEY`  | the base64 key from step 6 (44 characters)                    |
   | `APP_URL`               | already set for sign-in; the redirect URI is built from it    |

8. Restart/redeploy. Run the migration (`bun run db:migrate`, or let your deploy do it): `0008_google_calendar`.
9. Open Dashboard > account menu > **Calendars** > **Connect Google Calendar**. After consent, calendars
   appear within a minute or two (the worker checks for changes every 15 seconds and reads each external
   calendar every 5 minutes).

For local testing, `bun run dev` starts only the website. Run `bun run bot:start` in a separate
terminal from the project root for background calendar sync (it also starts Discord and reminders).
On Railway, the separate worker service must be running with the same database and Google
configuration as the website. Refresh the Calendars page to see the first sync; connecting alone
does not import events or create the dedicated calendar. Open tasks with due dates sync during the
worker's next pass; tasks without due dates cannot be placed on a calendar automatically.

If any of the three variables is missing or invalid the Calendars page says so and nothing else is
affected (the dashboard and Discord keep working); the server log names the variable, never the value.
Setting only some of them is reported; setting none keeps calendars off silently.

## Limits

- One Google account per owner. Microsoft/Outlook is a later goal.
- Polling, not push: changes in Google show up within about 5 minutes. Task deadlines and work blocks
  changed in Epiphany are written to Google on the worker's next pass, usually within 15 seconds.
- External events are read-only in Epiphany; changing an external appointment or a recurring series
  from Epiphany is not implemented.
- `workingLocation` entries are not imported. Events with an ID over 255 characters are skipped.
- Losing or changing `TOKEN_ENCRYPTION_KEY` makes saved tokens unreadable; reconnect.
- Google rate limits (429, `rateLimitExceeded`) are retried with backoff up to 4 times, then the run
  stops and the next one continues; other failures are recorded on the calendar and shown.
- The dedicated calendar is found by name ("Epiphany", owned by you) if the saved ID is missing; if you
  delete it in Google, a new one is created and its blocks are written again.

## How it is built

`packages/core/src/calendar/`: `crypto.ts` (AES-256-GCM), `google/` (REST client, OAuth refresh and
revoke), `store.ts` (status, selection, disconnect), `access.ts` (token refresh, connect, disconnect),
`sync.ts` (pull, push, reconcile, conflicts), `fake-google.ts` (test-only in-memory Google). Services:
`createServices(...).calendar` (permissions `calendar.read`, `calendar.connect` (needs consent),
`calendar.disconnect`, `calendar.select`, `calendar.resolve_conflict`). Routes: `/api/google/connect`
(GET), `/api/google/callback` (GET), `/api/google/disconnect` (POST, same-origin). The worker runs
`apps/worker/src/calendar-runner.ts`. Tables are described in [database](database.md); token handling in
[security](security.md).

## Verification

Offline (done): see the Goal 11 note in [GOALS.md](../GOALS.md). Mutation checks (a deliberate break
made tests fail, then was reverted): removing `If-Match` on updates (3 tests failed); letting writes go to any calendar (1); disabling the own-event loop guard (4); not detecting an external edit (2); skipping reconciliation of uncertain writes (2); leaving tokens in place on disconnect (4); not comparing the OAuth `state` (1); not handling 410 Gone (1); not marking `invalid_grant` as needing reconnection (1); not requiring owner consent to connect (1); not binding the token context in the encryption (1).

**Not verifiable without a real Google account (remaining before checking off Goal 11):**

1. The consent screen and token exchange with real credentials (including the unverified-app warning).
2. Your events appear after the first sync; the "Epiphany" calendar is created once and reused.
3. A test work block appears on the Epiphany calendar, updates in place, and is removed without duplicates.
4. An edit made in the Google Calendar app shows as a conflict and is not overwritten.
5. Disconnect: Epiphany disappears from <https://myaccount.google.com/permissions> and syncing stops;
   revoking it there instead shows "needs to be connected again" on the next sync.
6. Google-side behavior the fake cannot prove: `calendarList` access under `calendar.app.created`,
   client-chosen event IDs, and whether an event deleted in Google can be restored by Epiphany.

Use a test calendar for these checks.
