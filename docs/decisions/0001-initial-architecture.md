# 0001: Initial Architecture

Status: accepted 2026-10-13 (Goal 01). This is a decision record, not an
implementation: no application, database, or hosted service exists yet. Items
marked **Deferred** are intentionally left to the named goal.

## Component Decisions

| Component | Decision | Local run (from Goal 02) | Deployment |
| --- | --- | --- | --- |
| Dashboard + API | Next.js (React) with server routes. Version pinned in Goal 02. | `bun run dev` | Railway service `web` |
| Bot + reminder worker | Separate long-running Bun process using discord.js. Independent of the dashboard lifecycle. | `bun run bot:dev` | Railway service `worker` |
| Shared domain | Workspace package holding schema, repositories, and domain services used by dashboard, bot, and later voice. | Imported by both apps | Built into both services |
| Database | MySQL, dedicated Epiphany database and credentials. | Docker container pinned to MySQL 8.4 LTS | Railway MySQL service |
| Schema + migrations | Drizzle ORM with `mysql2`; `drizzle-kit` generates versioned SQL migrations. | `db:generate`, `db:migrate`, `db:status` (Goal 03) | Explicit pre-deploy migration step, one serialized runner |
| Text AI | OpenAI, structured outputs / tool calling. Specific model IDs chosen and verified in Goal 07. | Mock provider in tests; live calls opt-in | Key in Railway runtime secrets |
| Package manager | Bun, single `bun.lock`, frozen installs in CI. | `bun install` | Same |

Rationale and constraints:

- **Next.js** was chosen by the owner. At scaffold time, read the installed
  version's documentation, do not overwrite framework-generated instruction
  blocks in AGENTS.md/CLAUDE.md, and decide whether Next runs on Bun or Node in
  production. Goal 02 must verify that choice instead of assuming it.
- **The bot is not part of the Next.js process.** Reminders and Discord
  connections must keep running with the dashboard closed or restarting.
- **MySQL 8.4 LTS** is the pinned local/CI version: it is a current LTS line with
  premier support to 2029-04-30, and 8.0 reached end of life in April 2026. MySQL
  9.7 is also LTS (premier support to 2031) and may be revisited later. Confirm
  that the Railway MySQL service can run the same major version when
  provisioning; if not, align local/CI to the hosted version before Goal 03.
- **Browsers never hold database credentials.** The dashboard reaches MySQL only
  through server-side code in the shared domain package.
- **discord.js on Bun** needs a compatibility check in Goal 06. Voice library
  compatibility is a separate check in Goal 22.
- **DiscordNPC** (Python) is a concept reference only. Its ideas are adapted to
  TypeScript; no code, data, or credentials are copied. Revisit its voice approach
  in Goal 22.

## Planned Layout

Finalized in Goal 02, shown here for orientation only:

```text
apps/web      Next.js dashboard and API routes
apps/worker   Discord bot and reminder/scheduler process
packages/core Schema, migrations, repositories, domain services
```

## Hosting And Local Setup

- **Host: Railway**, with three services: `web`, `worker`, and MySQL. Runtime
  secrets are set in Railway, not committed files.
- **Local:** Docker runs MySQL 8.4 (Docker 29.1.3 and Bun 1.3.14 are present on
  the development machine). A compose file and ignored `.env` come in Goal 02.
- Railway database templates are unmanaged services: backups, tuning, and
  monitoring remain Epiphany's responsibility. Railway volume backups are on the
  same platform, so they do not satisfy the independent-backup requirement alone.

## Defaults Chosen

### Scope And Time

- Owner-only first release; multi-user support is deferred and would add
  isolation requirements to Goals 03/04.
- Default timezone: **America/Chicago**.
- **Deferred:** day boundaries, quiet hours, and notification frequency
  (Goals 12/15, to be confirmed with the owner); calendar replanning limits beyond the
  automation defaults below (Goals 11/12/14).

### Automation And Confirmation

- Epi may create or move its own work blocks only on explicit scheduling intent.
- Changing or canceling an external appointment or recurring series, deleting
  records, bulk edits, clearing memory, and changing protected time require
  explicit confirmation with a preview of exact targets.
- Increasing notification limits, enabling tracking/listening, or expanding
  provider permissions require explicit consent.
- **Confirmation expiry: 10 minutes**, bound to the exact action, record IDs,
  versions, and owner. An expired or superseded proposal needs fresh confirmation.

### Retention

| Class | Default |
| --- | --- |
| Assignment/history metadata, saved notes, preferences | Kept until the owner deletes them; no age-based purging |
| Conversation transcripts and short-term context | 90 days |
| Behavioral observations (opt-in) | 180 days |
| Operational logs (redacted) | 30 days |
| Backups | 30 days; a deleted record's backup copies expire within 30 days |
| Raw voice audio | Discarded after processing; exceptions decided before Goals 20/21 |
| Generated audio, audio transcripts | **Deferred** to Goals 20/21 |

- Deletion removes live records and derived memory/search entries together. A
  deletion ledger prevents restored backups from reintroducing deleted data.
  Backups and any provider-side copies cannot be erased immediately; disclose that.
- Export scope (default, owner may revise): all owner records including tasks,
  events, work blocks, notes, preferences, memory, action history, and calendar
  references, in machine-readable form. Secrets and OAuth tokens are excluded.

### Backups And Recovery

- **Daily** encrypted logical backups, stored outside the Railway database
  volume and outside the Railway platform, retained 30 days.
- **RPO 24 hours, RTO 4 hours.** Restore tested monthly into an isolated
  database, never over live data; verify the export is usable.
- The encryption key recovery procedure is documented before the first release.
- Feasibility and measured restoration are verified in Goal 19.

### AI Budget

- Text AI: **$10/month**, warning at **80%**, new optional AI calls stopped at
  **100%**, resetting on the 1st of each month in America/Chicago.
- Per-request caps: **8,000 input tokens and 1,000 output tokens**.
- Reserve estimated cost before dispatch, count retries, and also set a
  provider-side limit where OpenAI offers one. Never silently switch providers
  to bypass the cap. The cap does not cover hosting, database, or storage costs.
- Voice budgets are **Deferred** to Goals 20/21.

## Deferred Decisions

| Decision | Resolved in |
| --- | --- |
| ~~Dashboard authentication method~~ **Decided 2026-10-13 (Goal 04): Discord OAuth, allowed only for the owner's Discord user ID.** Library and session storage chosen in Goal 04. | Goal 04 |
| OpenAI model IDs and prompt/eval setup | Goal 07 |
| Calendar conflict resolution and recurrence handling details | Goals 11/12 |
| Outage grace periods, retry bounds, catch-up limits | Goals 11/15 |
| Off-platform backup storage provider | Before Goal 19; ideally Goal 03 |
| Speech-to-text and TTS providers and budgets | Goals 20/21 |
| Microsoft/school calendar permission | Goal 23 |

## Goal 02 Findings

- Next.js runs on Node (`next dev/build/start`); the worker runs on Bun. Both read one
  root `.env`; `next.config.ts` forces `@next/env` to reload it because Next has
  already cached its own `apps/web` load.
- `typescript` is pinned to 6.x: typescript-eslint does not yet support TypeScript 7.
- Next.js writes a managed `apps/web/AGENTS.md` during `next dev`; it is kept.
- The worker's health server uses `node:http` so it runs and tests under Bun or Node.

## Goal 04 Findings

- Sign-in uses Discord OAuth through the `arctic` library (authorization code with state and PKCE,
  `identify` scope). Better Auth and Auth.js were not used: their multi-user tables do not fit a
  single-owner model or the migration workflow.
- Sessions are Epiphany's own `sessions` table: random tokens, SHA-256 hashed at rest, 7-day
  lifetime. No signing secret is needed, so `AUTH_SECRET` was removed from `.env.example`.
- The access model is described in [security](../security.md).
- The owner's network inspects HTTPS to Discord (TLS-intercepting proxy), so server-side Discord calls
  fail certificate verification from the development machine. `ENV_BYPASS=dev` (development on
  localhost only) was added so development does not depend on it. The Discord bot (Goal 06) will need
  the same proxy question resolved.

## Required Accounts And External Blockers

None of these exist yet. Each blocks the goal listed.

| Needed | Blocks |
| --- | --- |
| Railway account/project (and confirmation of the MySQL version it offers) | Deployment; MySQL version alignment before Goal 03 |
| Discord application, bot token, test server, and owner Discord ID | Goal 06 (Message Content intent must be enabled) |
| OpenAI API key with a project-level spending limit | Goal 07 |
| Google Cloud project with Calendar API and OAuth client; a test calendar | Goal 11 |
| Off-platform backup storage and encryption key custody | Goal 19 |
| Speech provider accounts | Goals 20/21 |
| Microsoft tenant policy check | Goal 23 |

## Verification For This Record

Documentation-only. Checked: referenced goal numbers exist in GOALS.md and the
values above match the owner's selections on 2026-10-13. Export scope and the
exact component layout are drafts the owner did not explicitly choose. The
MySQL support dates come from endoflife.date and the MySQL announcements; the
Railway MySQL version is **not yet verified**.
