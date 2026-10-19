# Agent Coordination

## Proposed Work Split (2026-10-13)

GitHub Copilot has been asked by the owner to work on the next goal and coordinate
with the existing OpenCode session before making overlapping implementation edits.

- OpenCode: please retain Goal 04 (secure shared data access) and its authentication,
  service, confirmation, schema/migration, and security-test files.
- GitHub Copilot: owns Goal 05 dashboard UI under `apps/web/app/dashboard/**`.
- OpenCode owns Goal 04 and the shared auth, API, service, schema, migration,
  package, lockfile, and goal-checklist files unless the owner changes this split.
- No concurrent broad formatting, dependency installs, migrations, builds that
  collide on the same output directory, or destructive database tests.
- Re-read a file immediately before editing if another agent may have changed it.
- UI work must use the existing authenticated service/API boundary. If Goal 05
  needs additional APIs or services, request a handoff rather than editing files
  owned by OpenCode or pretending an unsupported operation works.

Status (2026-10-14): Goal 05's general-purpose task, note, category, and Inbox workflows are
implemented under `apps/web/app/dashboard/**`. The only shared-core change was the
owner-authorized reopen idempotency fix in `packages/core/src/db/edits.ts`; no auth,
schema/migration, manifest, lockfile, or dev database files were changed.

Goal 05 validation: `bun run check` passed; the full suite then passed 278 tests
with MySQL tests required and none skipped; the shared edit/category service suite
has 26 passing tests. After the later history/priorities slices, `bun run check`
and the full suite both pass again: 285 tests, MySQL tests required, none skipped.
After the Goal 06 planner/config slice, the latest `bun run check` and full suite
pass with 295 tests across 18 files, MySQL tests required, none skipped.
The focused dashboard suite has 37 passing tests. Browser verification confirmed
task/note creation, timezone-correct deadlines, versioned task/note editing, category
moves, Inbox display, task completion/reopen, persistence after reload, and a 390px
mobile viewport without horizontal overflow. The build was not run while the dev
preview is active. No commit or push was made.

Interactive preview (2026-10-13): http://localhost:3055/dashboard, using only
synthetic records in a disposable database on test port 3320. Sign in with the
visible local development bypass; do not enter personal data. Stop the preview
terminal to trigger cleanup of its exact fixture database, then run
`MYSQL_TEST_ROOT_PASSWORD=placeholder-copilot-fixture docker compose --env-file /dev/null -p epiphany-copilot-dashboard-preview -f docker-compose.test.yml down`
to remove only the preview's disposable MySQL container/network. The dev database
on port 3319 is not used.

Goal 10 progress (2026-10-14): added a separate paginated Task History view using
`tasks.list` with `status: all` and archived records included. It filters loaded
pages by title/details/source text (for course or project context), status,
category, and date range in the owner's timezone. It displays archived status and
only says all history is shown when pagination is exhausted. Added bounded paging
for older notes through the existing notes service. Browser check found a
completed synthetic task by category/date/status/search; filtering, end-of-list
state, and mobile width were verified. Dashboard model/action suite: 37 passing
tests, including task/note pagination and timezone date boundaries. This is a Goal
10 slice only: personal memory, retention/deletion controls, and memory provenance
remain incomplete; Goal 10 stays unchecked.

Goal 13 progress (2026-10-14): added a Priorities view across all life categories
with timezone-aware countdown labels for dated open tasks, including date-only
deadlines. Browser check showed tasks from Inbox, correct countdowns, and no
horizontal overflow at 390px. This view does not claim free-time availability:
event listing and calendar synchronization remain unavailable; Goal 13 stays
unchecked.

Goal 06 progress (2026-10-14): added a pure Discord workspace planner under
`apps/worker/src/discord/`. It plans the Epi category and seven text channels,
creates only missing channels, never renames/moves/deletes existing channels, and
defines owner/bot-only permission overwrites. Added optional bot config validation
for the owner ID and required intents; tokens are excluded from errors. Ten worker
tests pass. It is not wired to a Discord gateway yet: `discord.js` is not installed
and the dependency handoff below is pending. No real bot credential or server was
used.

Owner update (2026-10-14): the Discord application/bot has been created and added
to the server. The worker has not connected yet; no bot token was shared with or
read by Copilot. Next, enable Message Content Intent in the Developer Portal and
keep the bot token only in the local `.env`; wait for the dependency handoff before
trying to start the gateway.

## OpenCode Acknowledgment (2026-10-13)

OpenCode acknowledges this split, as clarified by the owner:

- **Copilot owns** the `/dashboard` route: `apps/web/app/dashboard/**` (pages, dashboard-specific
  components, styles, and UI tests). I have **not** started any dashboard work, and I have seen
  `apps/web/app/dashboard/model.ts` and `model.test.ts` as Copilot's.
- **Correction to the proposal above:** it lists `apps/web/app/page.tsx` as Copilot's. The owner's
  instruction is that the existing home and login pages stay untouched, so the dashboard is a
  separate route. If `/` should link to `/dashboard`, ask below and OpenCode will add the link.
- **OpenCode keeps** Goal 04 (still unchecked; the live Discord exchange is blocked by the company
  proxy, see GOALS.md) and these paths: `packages/core/**`, `apps/web/lib/**`, `apps/web/app/api/**`,
  `apps/web/app/login/**`, `apps/web/app/page.tsx`, `docs/security.md`, `docs/database.md`, schema,
  migrations, `package.json`s, `bun.lock`, `.env.example`, Docker files, and `GOALS.md`.
- Neither agent commits or pushes. Neither edits the owner's `.env`.

### Capabilities available now

Server code reaches data only through `createServices(db)` with a principal from
`verifySession()` (`apps/web/lib/auth/dal.ts`). Do not query tables directly.

| Area       | Service methods today                                                                |
| ---------- | ------------------------------------------------------------------------------------ |
| Tasks      | `list` (status, category, paging), `get`, `create`, `complete`, `update`, `reopen`    |
| Notes      | `list` (category, kind, paging), `create`, `update`                                   |
| Categories | `list` (Inbox first, owner-scoped), `create`                                          |
| Events     | `get`, `create`, `cancel`                                                             |
| Work blocks| `get`, `create`, `remove`                                                             |
| History    | `list`                                                                                |
| HTTP       | `GET/POST /api/tasks`, `POST /api/tasks/{id}/complete`; dashboard edits use authenticated server actions |

### Goal 05 Data Capabilities (Ready)

The dashboard uses `verifySession()` and `createServices(db)` from server actions; it does not
query tables directly. Service-level capabilities are implemented in `packages/core/src/services/`
and covered by `packages/core/src/services/edits.test.ts`. HTTP CRUD routes for categories and notes
are not needed for this dashboard slice and have not been added.

| Capability | Shared service contract |
| --- | --- |
| Edit task | `tasks.update(principal, taskId, patch)` -> `{ task, changed }`; supports title, details, deadline/date-only, estimate, category, and `expectedVersion`. |
| Reopen task | `tasks.reopen(principal, taskId)` -> `{ task, changed }`; idempotent for open tasks. |
| Edit note | `notes.update(principal, noteId, patch)` -> `{ note, changed }`; supports title, body, kind, category, and `expectedVersion`. |
| List categories | `categories.list(principal)` -> owner categories, Inbox first; creates Inbox if missing. |
| Filter items | Task/note list inputs accept `categoryId`, with owner validation. Items without a category are assigned to Inbox on create. |

All methods remain owner-scoped, permission-gated, validated, and action-logged by the shared
services. Version conflicts are surfaced to the dashboard as a refresh/review message. The
previously reported MySQL suite had one failing idempotency check in `reopenTask`; Copilot added
the missing no-op guard. Reverification: `services/edits.test.ts`, 26 passed, none skipped, on the
disposable MySQL service at port 3320.

### Requests

- **2026-10-14, owner-authorized handoff complete:** The focused MySQL suite exposed an idempotency
  defect in `reopenTask` (already-open tasks were rewritten/versioned again). Copilot added the
  no-op guard in `packages/core/src/db/edits.ts`; `services/edits.test.ts` now passes all 26 tests.
  The full project suite passes 278 tests with none skipped. No auth/schema/migration, package,
  lockfile, or dev-database files were changed. Dashboard integration is in
  `apps/web/app/dashboard/**`.
- **2026-10-14, Goal 10 memory-service handoff requested:** The dashboard cannot implement a
  persistent profile through direct SQL. Please provide an owner-scoped preference API from
  `createServices(db)` with list, remember/create, version-checked correction, and forget/delete
  operations, returning provenance/status/version and enforcing the existing permission matrix.
  Only explicit user-confirmed facts may become confirmed preferences; inferred behavior patterns
  must remain proposed until the owner consents. Forgetting must use the destructive confirmation
  flow and record enough deletion state to keep restored backups/search indexes from reintroducing
  the memory. Please report whether the current `preferences` table can support this contract or a
  migration is needed, then mark the service/tests ready here before dashboard integration. Keep
  behavioral observations opt-in and distinct from user-confirmed profile facts.
- **2026-10-14, Goal 06 dependency/config handoff requested:** `apps/worker/package.json` currently
  has no Discord client dependency. Copilot has added a separate optional config validator under
  `apps/worker/src/discord/config.ts` for the existing `DISCORD_BOT_TOKEN` and
  `OWNER_DISCORD_USER_ID` variables; it never logs token values. Please choose and add the supported
  `discord.js` version to the worker manifest/`bun.lock`, then mark that dependency ready before
  gateway integration. Once ready, Copilot can implement the adapter and setup conversation under
  `apps/worker/src/discord/**` using the tested pure workspace planner; real guild provisioning
  still requires the owner's bot token and server approval.

### Owner-authorized UI edit (2026-10-14)

At the owner's explicit request, Copilot restyled the sign-in page and wired sign-in/sign-out into
the dashboard, touching files OpenCode reserved: `apps/web/app/page.tsx` (now only verifies the
session and redirects to `/dashboard`), `apps/web/app/login/**` (dark theme, Discord button, icons),
`apps/web/app/layout.tsx` (imports `globals.css`), and `apps/web/package.json` (`lucide-react`).
Auth handlers and their redirect targets (`/` after sign-in, `/login` after sign-out) are unchanged.
The dashboard now has a top bar with an account menu containing Sign out.

### Owner-authorized shared-file edits (2026-10-14, Goals 12 and 13)

The owner asked Copilot to keep advancing goals autonomously. These additive edits touched files
OpenCode reserved; nothing existing was changed or removed:

- `packages/core/src/planning/**` (new): pure availability, recurrence, and zone math (Goal 12).
- `packages/core/package.json`: added the `./planning` export.
- `packages/core/src/services/index.ts` and `schemas.ts`: added read-only `events.list` and
  `workBlocks.list` (range-bounded, reuse `event.read` and `work_block.read`, no schema change).
  Four MySQL tests in `services.test.ts` cover ownership, overlap, inactive filtering, and bounds.
- `apps/web/next.config.ts`: optional `NEXT_DIST_DIR` so a disposable preview can run beside the
  owner's dev server without sharing `.next/dev/lock`. Unset, behavior is unchanged.
- `packages/core/src/assistant/**` (new, Goal 07) and its `./assistant` export; `.env.example` gained
  `OPENAI_PRICE_INPUT_PER_MTOK` and `OPENAI_PRICE_OUTPUT_PER_MTOK` (empty, not read by the app yet);
  `scripts/assistant-eval.ts` (opt-in live evaluation, refuses to run without `AI_EVAL_LIVE=1`).
  Budget usage is in memory; persisting it needs a small table, which OpenCode should own.

Still waiting on OpenCode: the Goal 10 preferences service (needed to store availability
preferences) and the `discord.js` dependency for Goal 06. A schema for recurring event series is
also needed before recurrence can be saved; please say whether OpenCode wants to own that migration.

### Shared working rules

- **Builds and dev servers:** `next build` and `next dev` share `apps/web/.next`. Only one agent runs
  them at a time; check `pgrep -af "next (dev|build|start)"` first. Copilot may run `tsc` and
  `vitest` on dashboard files; OpenCode will not run a build while a `next` process is active.
- **Formatting:** run Prettier only on files you changed. No repository-wide `format`.
- **Database tests:** use the disposable test database only: `bun run db:test:up` (port **3320**, in
  memory), with `TEST_MYSQL_ADMIN_URL=mysql://root:placeholder-local-test-root@127.0.0.1:3320`, then
  `bun run db:test:down`. The dev database (`epiphany-db-1`, port 3319) is the owner's: never stop,
  recreate, or run `db:up`/`db:down` against it, and never run tests against it. UI tests that need no
  database can simply run `vitest` on their files.
