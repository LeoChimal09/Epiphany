# Operations

## One Railway service, one persistent volume

The owner approved replacing MySQL with local SQLite to reduce Railway RAM usage.
Deploy the repository's `Dockerfile` as **one always-on service, one replica**.
The container includes Node 24 and Bun 1.3.14: Next.js runs on Node, while the
supervisor, migration CLI, and Discord/background worker run on Bun.

1. Attach a Railway persistent volume at **`/data`** and set
   **`DATABASE_URL=file:/data/epiphany.sqlite`** in the service variables.
   The image filesystem is ephemeral; `/app/data` is not production storage.
   The runtime user must be able to write the volume directory and SQLite's
   `-wal`/`-shm` sidecars. The supplied image uses its default root user; custom
   non-root images need matching volume ownership before startup.
2. Use the Dockerfile CMD (`bun scripts/start-app.ts`, also `bun run start`).
   Do not override it with `next start` or `bot:start`.
3. Generate a public domain targeting the web port. Railway provides `PORT`;
   the supervisor binds Next to `0.0.0.0:$PORT` (local default 3000).
   `WORKER_HEALTH_PORT` defaults to 3001 and must differ from `PORT`.
   If Railway assigns 3001 to the web, choose another worker port, e.g. 3002.
   Do not expose the worker health port publicly.
4. Configure the Railway HTTP healthcheck as `/api/health`. Keep one replica;
   disable serverless/app sleeping while the Discord bot and scheduled jobs run.
   Avoid overlapping deployments/writers against the volume. A brief deployment
   outage is preferable to two workers sending duplicate reminders.
5. Configure runtime secrets below. Build with `docker build -t epiphany .`;
   the build needs no real database, `.env`, or provider secrets. The Docker
   context excludes environment files, private storage, and local databases.

The startup supervisor validates a writable file-backed `DATABASE_URL`, the two
ports, and runtime versions before launching anything. It runs the **explicit
versioned migration CLI** (`bun packages/core/src/db/cli.ts migrate`) to completion
with the volume mounted, then starts web and worker. Do not use Railway's
pre-deploy container for these migrations: the service's attached volume must be
available. Migration failure prevents both applications from starting. No schema
push/reset or MySQL-to-SQLite data import runs automatically.

Either application's unexpected exit (even code 0) terminates its sibling and
fails the service so Railway can restart the pair. SIGTERM/SIGINT are forwarded
to both children; the supervisor waits, then force-stops remaining direct
children after 15 seconds. Configure Railway's termination grace period longer
than that timeout. No shell, detached worker, or independently restarted bot is
used. Shutdown during migration also stops the migration process.

### Build fails at `mise install` with a Bun download 504

This is a tool-download failure before dependency installation or application
startup, not a Discord or SQLite error. `libatomic1` installation is unrelated
when the failing step is the GitHub Bun release download.

A log containing `mise install` indicates Railpack is building the service,
not the repository's Dockerfile. Retrying can resolve a transient 504, but the
SQLite deployment should use the Dockerfile:

1. In the intended combined service's Railway settings, select the commit
   containing the SQLite Dockerfile, set the source root to the repository root
   (not `apps/worker`), and select the Dockerfile builder with path `Dockerfile`.
2. Remove old build/start overrides and the old pre-deploy migration command.
   The Dockerfile builds Next.js and its CMD runs the supervised web and worker;
   migrations run at startup with the volume mounted.
3. Before deploying, complete the cutover below: attach `/data`, configure the
   SQLite URL and all web/bot variables, import and verify existing data, and stop
   old writers. Do not deploy both former services as combined services.

The Dockerfile obtains Bun from `oven/bun:1.3.14` rather than the failing mise
GitHub download. Image registries can still have outages. A successful build
does not prove that the persistent volume or imported data is configured.

### Container exits before `process_started`

The supervisor checks configuration before migrations or application startup.
New logs identify the failed check without printing the database URL or credentials:
missing/invalid `DATABASE_URL`, a missing/unwritable parent directory, colliding
ports, or unsupported Bun/Node versions. Earlier builds print only the combined
"Require Bun 1.3.14, Node 24+..." message; that message alone cannot identify the cause.

Check the combined service has `DATABASE_URL=file:/data/epiphany.sqlite` rather
than a reference to MySQL's URL, a volume mounted at `/data`, and different
`PORT`/`WORKER_HEALTH_PORT` values. Keep all existing data and complete the import
before enabling the new writers; do not fix startup by using an empty temporary
database or deleting the old database.

### SQLite placement constraints

The Node web process and Bun worker open the **same file on the same machine**
through the async local `@libsql/client` adapter and shared services. WAL allows
these local connections to coexist; it is not distributed storage or a
multi-machine replication protocol. Do not put this file on a network filesystem,
run separate web/worker Railway services, scale replicas, or start a second
writer against a copied/independent database. Closing a browser has no effect on
the worker, but a process crash restarts both processes by design.

### Variables

All variables now belong to the same Railway service; remove stale service-level
overrides that still point at MySQL.

| Variable | Purpose |
| --- | --- |
| `DATABASE_URL` | `file:/data/epiphany.sqlite`, required |
| `PORT`, `WORKER_HEALTH_PORT` | Public web listener and distinct internal health listener |
| `APP_URL` | Public HTTPS dashboard URL |
| `DISCORD_CLIENT_ID`, `DISCORD_CLIENT_SECRET` | Owner dashboard OAuth |
| `OWNER_DISCORD_USER_ID`, `DISCORD_BOT_TOKEN` | Owner identity and Discord worker |
| `OPENAI_API_KEY` | Optional AI; use a dedicated Epiphany project/key and spending limit |
| `APP_TIMEZONE` | Default America/Chicago |
| `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `TOKEN_ENCRYPTION_KEY` | Optional calendar |
| `ELEVENLABS_API_KEY`, `ELEVENLABS_VOICE_ID`, `VOICE_*` | Optional voice |
| `ENV_BYPASS` | **Never set in production** |

## Cutover from the existing MySQL deployment

This is an operator procedure, not an already completed deployment.

1. Confirm backup/restore access, export a consistent MySQL backup, and retain
   the old MySQL service/data untouched. Record migration status and a source
   row-count baseline; keep credentials in operator secrets, not logs or git.
2. Stop/disable the **old web and worker**, their scheduled jobs, and any other
   old writers before taking the final source snapshot/import. Prevent their
   automatic redeployment/restart. Do not leave an old bot running alongside
   the new service.
3. With the new service stopped, use the reviewed SQLite migration/import
   procedure in [database.md](database.md). Migration startup only establishes
   schema: it does **not** copy existing MySQL records. Do not point a SQLite
   client at MySQL, overwrite an existing destination, or assume a successful
   empty startup proves data preservation.
4. Check imported counts and representative tasks, notes, preferences,
   confirmations, sessions, reminders, and calendar references in the persistent
   destination. Then start the one new service. Verify owner sign-in, a
   disposable persisted write/read, Discord connection and one reminder, and
   persistence across a service restart. Confirm there is only one bot worker.
5. Keep MySQL read-only/stopped for the rollback window; retire it only with
   explicit owner approval after the new system and independent backups pass
   acceptance. This change does not delete or alter the old database.

**Rollback caveat:** stopping the new service and restoring the old deployment
can recover the frozen MySQL snapshot, but **loses SQLite-only writes** unless
they are exported and reconciled first. There is no automatic reverse importer,
dual write, or lossless live rollback. Preserve a consistent SQLite backup and
its deletion ledger before reverting; never restart both writer deployments.

## Monitoring and readiness

- The supervisor emits JSON `process_started`, `migrations_complete`,
  `process_exited`, and failure/shutdown events. `process_started` means spawned,
  **not ready**; a migration failure or child exit is a failed deployment.
- Web `/api/health` and worker `/health` currently validate configuration only:
  `database: "not_checked"` is intentional. A 200 is **not proof** of database
  connectivity, Discord login, reminder delivery, or calendar availability.
  The Docker HEALTHCHECK probes both HTTP listeners; Railway's web-only probe
  does not replace checking worker logs and end-to-end acceptance.
- Watch `discord_ready`, `reminder_cycle`, `overview_sync`, `*_failed`, restarts,
  volume capacity, and database/backup errors. A worker can run health-only
  without a bot token; that is not a connected Discord bot.
- The `check-ins` channel and dashboard show failed reminder delivery. Use an
  uptime monitor/alert for the web endpoint and alerts for crash loops.

## Backups and restores

A persistent volume is **not a backup**. Railway volume snapshots alone do not
meet the independent-backup policy. Retain the chosen daily encrypted off-platform
backups for 30 days (target RPO 24 hours, RTO 4 hours), with encryption-key recovery
and a deletion ledger alongside each backup.

For SQLite, use a consistent SQLite backup API/online backup command, or stop
**both** processes before taking a filesystem copy. Do not copy just the main
`.sqlite` file while WAL writers are active: committed records may still be in
`-wal`. Do not delete sidecars manually to "repair" a live database. Railway
snapshots may be supplemental, not a substitute for verified consistent exports.

Restore into a separate isolated directory/volume, verify database integrity,
owner records, usable export and deletion-ledger application, then test both
runtimes before any approved production replacement. Run the current documented
restore drill only when it explicitly supports the SQLite backup format;
historical MySQL drill results do not verify SQLite recovery. Record an actual
SQLite restore after cutover and monthly thereafter. No hosted restore, backup
automation, or live Railway acceptance is implied by these instructions.

## Owner onboarding walkthrough

1. Deploy the single service and create the Discord application ([Discord setup](discord.md)).
2. Sign in to the dashboard with Discord (this creates your owner record).
3. If you own the Discord server, Epi creates the private `epiphany` workspace on start and DMs you.
   Otherwise DM Epi: "set up my workspace".
4. Tell Epi what is due in the dashboard chat, `#assistant`, or a DM.
5. Optionally configure briefing, quiet hours, routines, and [Google Calendar](calendar.md).
