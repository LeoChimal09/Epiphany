# Operations

## Services (Railway)

| Service | Start command | Pre-deploy | Public domain |
| --- | --- | --- | --- |
| `web` (dashboard) | `next start apps/web` (the repo default) | `bun run db:migrate` | yes |
| `worker` (Discord bot, reminders, overview sync, calendar sync) | `bun run bot:start` | none | no |
| MySQL | Railway template | n/a | no (private network) |

The web service and the worker do not depend on each other at runtime: the dashboard works with the worker
stopped, and reminders keep going with the dashboard closed. Only the web service runs migrations.

### Variables

Variables are per service; nothing carries over from `web` to `worker`.

| Variable | web | worker |
| --- | :-: | :-: |
| `DATABASE_URL` (reference the MySQL service) | x | x |
| `APP_URL` (the public https URL) | x | |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | x | |
| `OWNER_DISCORD_USER_ID` | x | x |
| `DISCORD_BOT_TOKEN` | | x |
| `OPENAI_API_KEY` (use a separate key per service) | x | x |
| `APP_TIMEZONE` (default America/Chicago) | x | x |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `VOICE_*` (optional, voice) | | x |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` (calendar) | x | x |
| `ENV_BYPASS` | **never set** | **never set** |

## Monitoring

- Both services log one JSON object per line. Watch the worker's Deploy Logs for `discord_ready`,
  `reminder_cycle`, `overview_sync`, and any `*_failed` event.
- Add a Railway alert (or an uptime monitor on the web `/api/health`) for the web service. For the worker,
  set a healthcheck on `WORKER_HEALTH_PORT`'s `/health` and an alert on restarts or crash loops.
- The `check-ins` channel and the dashboard show reminders that did not reach you.

## Backups and restores

- Enable Railway's volume backups for MySQL on a daily schedule (this is what gives the 24 h RPO).
- Run `bun run restore:drill` after the first backup and then monthly, and record the result.
- Keep the deletion ledger from `buildDeletionLedger` next to each backup (docs/release-gate.md).
- Export your data any time with `exportOwnerData` (JSON; credentials are never included).

## Owner onboarding walkthrough

1. Deploy both services and create the Discord application (docs/discord.md).
2. Sign in to the dashboard with Discord (this creates your owner record).
3. If you own the Discord server, Epi creates the private `epiphany` workspace on start and DMs you.
   Otherwise DM Epi: "set up my workspace".
4. Tell Epi what is due, in your own words, in the dashboard chat, `#assistant`, or a DM.
5. Optionally say when you want your briefing, quiet hours, and routines (docs/reminders.md).
6. Optionally connect Google Calendar from the dashboard (docs/calendar.md).
