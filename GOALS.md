# Epiphany Build Goals

This is the execution checklist for [the product plan](README.md). Goals 01, 02,
03, and 05 are complete; Goal 04 remains open pending live Discord OAuth
verification. Build one goal at a time, verify its completion criteria, and then
check it off. Epi's shared planning system covers every area of life, not only
school assignments.

## Working Rules

- Work in numbered order unless a documented dependency or external blocker
  requires a change. Record blockers instead of silently marking goals complete.
- At the start of a goal, choose its smallest testable implementation slice.
- Mark a goal complete only after its stated checks pass; record verification.
- No command syntax for users to memorize. Installation and authorization can
  use normal platform consent screens; buttons are optional conveniences.
- Use isolated fixtures or test accounts for destructive tests, never real-user
  cleanup sweeps. Remove only records created by the test.
- Keep calendar mutations, private-data access, and AI actions permissioned.
- Keep credentials out of the repository, prompts, and logs.
- Follow [the project development practices](docs/standards/development-practices.md)
  for Bun, checks, migrations, secret handling, deployment, and verification.
- Apply [Epi's operating policies](docs/operating-policies.md) and their per-goal
  gates; documented policies alone do not count as implemented safeguards.

## Foundation

### 01. Decide The Initial Architecture

- [x] Complete goal 01. Decision record: [0001](docs/decisions/0001-initial-architecture.md).
- Deliver: a short decision record for dashboard, backend, bot runtime, database,
  hosting, and initial AI provider. Prefer Bun for supported JS/TS tooling.
- Confirmed on 2026-10-13: MySQL is the database. Choose its supported version,
  driver/ORM, hosting, local setup, and independent backup approach; do not reopen
  the database choice without the user's agreement. No service is provisioned yet.
- Decide: owner-only first release, timezone, data retention defaults, and AI cost
  limits. Determine whether DiscordNPC concepts will be adapted across runtimes.
- Record: automation defaults/confirmation expiry, retention and backup settings,
  RPO/RTO and restore-test cadence, and provider budgets/thresholds/request caps
  using the operating-policy decision table. These values are not chosen yet.
- Done when: every initial component has a chosen role, local run approach, and
  deployment approach; required accounts and external blockers are listed.

### 02. Create A Runnable Project Skeleton

- [x] Complete goal 02. Details: [local development](docs/local-development.md).
- Deliver: application structure, dependency setup, environment example without
  secrets, formatting/linting, test commands, and basic service health checks.
- Implement: the applicable standard script contract, Bun lockfile, staged-secret
  guard with synthetic-fixture tests, and CI for check, test:run, and build. Do not
  automatically install git hooks or reference commands that do not exist.
- Done when: dashboard and background service run locally, missing configuration
  produces actionable errors, baseline checks pass, and CI runs on an isolated
  fixture environment without production credentials.

### 03. Establish The Database And Domain Records

- [x] Complete goal 03. Details: [database](docs/database.md).
- Deliver: MySQL migrations and records for owner identity, tasks, events, work blocks,
  categories/Inbox, notes, preferences, and action history. Add later domain
  tables as the corresponding goals require them.
- Implement: schema-as-code, versioned migrations, documented generation/application
  commands, and isolated clean-install/upgrade checks; no destructive production push.
- Require: the [migration workflow](docs/standards/development-practices.md#required-migration-workflow)
  for every later schema change, ordered migration history, a serialized runner,
  status inspection, and recovery from partially applied MySQL DDL.
- Done when: fixture records survive restart; task completion, event cancellation,
  and work-block removal are distinct operations; clean installation and upgrade
  preserve fixture data; a second migration run applies nothing; CI validates
  migrations against disposable MySQL fixtures and the recovery plan is documented.

### 04. Secure Shared Data Access

- [ ] Complete goal 04.
- Deliver: authenticated dashboard access, owner authorization, shared data-service
  operations, input validation, and an auditable change path.
- Require: the action permission matrix, version-bound confirmation enforcement,
  and shared-channel privacy rules at the service boundary.
- Done when: the owner can access fixture records, unauthorized callers cannot,
  and updates return persisted results rather than optimistic success alone.

## First End-To-End Workflow

### 05. Build A Basic Dashboard And Inbox

- [x] Complete goal 05. Verification: dated progress record below.
- Deliver: mobile-friendly task list for school, work, fitness, errands, and
  personal projects; note list, owner-defined categories, Inbox, and basic
  create/edit/complete controls backed by the shared data service.
- Done when: changes persist after reload; completed items leave the active list
  but remain in history; uncategorized items appear in Inbox.

### 06. Connect Discord And Create The Workspace

- [ ] Complete goal 06.
- Deliver: bot connection, secure owner-account linking, approved channel setup,
  appropriate intents/permissions, and a DM-delivery check.
- Done when: setup creates the planned channels once, rerunning reuses them,
  owner messages reach the service, and other users cannot access personal data.
- Constraint: onboarding is conversational or dashboard-guided, not slash-command
  dependent. Missing permissions or blocked DMs must be visible.

### 07. Implement Free-Form Understanding And Safe Actions

- [ ] Complete goal 07.
- Deliver: AI intent interpretation, validated internal read/write capabilities,
  natural clarification, conversational context, and confirmed action responses.
- Require: the conversation evaluation harness, applicable held-out paraphrases,
  expired-confirmation tests, and text-provider budget enforcement/fallback checks.
- Done when: differently worded requests retrieve, create, and complete fixture
  tasks without prefixes; ambiguous references ask a question; failed actions
  are not reported as successful; advice does not mutate records.

### 08. Add Homework Intake And Automatic Sorting

- [ ] Complete goal 08.
- Deliver: mixed-message extraction, pasted-homework review, default Inbox,
  category changes, duplicate detection, and linked source messages.
- Done when: one out-of-order message produces separate assignment and idea
  records; uncertain/missing dates are flagged; corrections update classification;
  casual chat and no-save requests do not become durable tasks or notes.

### 09. Synchronize Discord And Dashboard Views

- [ ] Complete goal 09.
- Deliver: updated Discord overview messages, detail threads where useful,
  dashboard refresh/update delivery, and activity history with practical undo.
- Done when: a Discord completion appears on the dashboard and a dashboard edit
  appears in Discord; retries do not duplicate entries; deleting an overview
  message does not delete its underlying records.

### 10. Add Personal Memory And Continuity

- [ ] Complete goal 10.
- Deliver: confirmed preferences, recent context, relevant database retrieval,
  memory provenance, and inspect/correct/forget controls.
- Include: [historical assignment retrieval](README.md#historical-records-and-archived-assignments)
  and dashboard history search with explicit archive/retention rules.
- Done when: preferences persist across sessions; current records override old
  summaries; forgotten preferences are excluded from retrieval; private memory
  is not disclosed to unauthorized users or shared-channel audiences.
- Check history: a year-old completed fixture is searchable without becoming
  active or triggering reminders; missing attachments are reported honestly;
  age alone does not complete or delete unresolved work.
- Require: the chosen retention policy and live-record/derived-memory deletion
  controls; document any separately retained logs, backups, and provider copies.

## Calendar And Visual Planning

### 11. Connect Google Calendar Safely

- [ ] Complete goal 11.
- Deliver: OAuth consent, secure token storage, calendar selection, external
  event references, sync status, and a dedicated Epiphany calendar for writes.
- Require: version-aware conflict checks, visible stale/pending sync state, and
  reconciliation of uncertain writes before retries; test concurrent external edits.
- Done when: authorized events appear in the app; a fixture work block can be
  created/updated without duplication; disconnect prevents future access;
  expired or revoked access is handled visibly. Test writes use a test calendar.

### 12. Compute Availability And Scheduling Constraints

- [ ] Complete goal 12.
- Deliver: timezone-aware availability using events, sleep, meals, travel,
  buffers, preferred hours, and protected time; recurrence and conflict handling.
- Check: occurrence versus series scope, all-day events, daylight-saving changes,
  and timezone changes without silently shifting fixed external appointments.
- Done when: fixed test schedules yield expected free windows, including
  timezone/day-boundary cases, and empty calendar time is not treated as
  automatically usable when blocked by preferences.

### 13. Build Today, Week, And Priorities Views

- [ ] Complete goal 13.
- Deliver: daily timeline, weekly visual calendar, deadline countdowns, preparation
  milestones, effort estimates, and visually distinct events/work blocks.
- Done when: fixture data renders accurately on mobile and desktop, conflicts
  and sync failures are visible, and completion history remains accessible.

### 14. Make Weekly Planning Conversational

- [ ] Complete goal 14.
- Deliver: deadline/effort-aware recommendations, work-block proposals, and
  approved scheduling and rescheduling.
- Done when: "Epi whats my schedule looking like this week, i want to see what
  assignments i can crunch" produces a grounded overview and recommendations;
  "What about Thursday?" uses context; approved blocks avoid conflicts;
  completing early clears remaining blocks but retains task history/deadlines.

## Proactive Accountability

### 15. Build A Reliable Reminder Service

- [ ] Complete goal 15.
- Deliver: persistent reminder jobs, timezone-aware timing, retry/deduplication,
  restart recovery, failed-delivery reporting, and configurable overdue handling.
- Require: reminders independent of new AI calls, bounded rate-limit-aware retries,
  chosen grace/catch-up limits, and recovery that skips obsolete notifications
  rather than replaying every missed hourly prompt. Document uncertain delivery.
- Done when: controlled-clock tests send a due reminder once across retries and
  restart; blocked delivery is recorded; quiet hours and limits are enforced.

### 16. Add Briefings And Two-Way Check-Ins

- [ ] Complete goal 16.
- Deliver: morning briefing, event/deadline reminders, natural replies, optional
  Done/Still working/Snooze/Replan buttons, and bounded acknowledgment follow-ups.
- Done when: "Finished it" updates the right task or asks which one; "Not going"
  handles the intended event; snoozing changes reminder timing; no reply remains
  unknown and does not trigger an unlimited follow-up loop.

### 17. Support Routines, Rewards, And Wind-Down

- [ ] Complete goal 17.
- Deliver: recurring workouts, hourly awareness prompts, bedtime reminders, and
  early-completion choices for catch-up work, exercise, or a break.
- Done when: a user can choose an activity and duration conversationally, receive
  its agreed follow-up, and pause reminders; protected rest is not overwritten.

### 18. Add Opt-In Behavioral Personalization

- [ ] Complete goal 18.
- Deliver: evidence-backed insights from voluntary updates, task durations,
  postponements, and reminder responses, plus review/correction/pause controls.
- Done when: repeated reported durations improve estimates; a single missed
  reply creates no conclusion; corrections override inferences; paused tracking
  adds no observations; adaptations stay within approved settings.

## First Release Gate

### 19. Verify And Deploy The Text Assistant

- [ ] Complete goal 19.
- Deliver: automated checks for goals 03-18, deployment configuration, backup and
  restore procedure, service monitoring, and an owner onboarding walkthrough.
- Verify: independent dashboard/worker operation, graceful shutdown, redacted logs,
  safe migration rollout, and the selected host's runtime secret configuration.
- Require: cross-service outage and budget-limit tests, the applicable conversation
  suite, isolated restores measured against chosen RPO/RTO targets, usable exports,
  and deletion-aware restore handling so forgotten data is not reintroduced.
- Done when: the full create-plan-remind-reply-complete workflow passes with
  isolated data; access denial, AI failures, restarts, and sync failures are tested;
  a restore is verified; deployed reminders work with the dashboard closed.
- Release scope: dashboard, Discord text, Google Calendar, notes, memory, and
  configurable accountability. Voice is not required for this release gate.

## Voice And Later Extensions

### 20. Accept Audio Messages

- [ ] Complete goal 20.
- Deliver: supported audio-attachment intake, transcription, size/duration limits,
  consent/retention controls, and the existing conversational action path.
- Require: explicit audio/transcript retention settings and transcription budget
  controls before enabling capture; test the unavailable/limit-reached response.
- Done when: an audio fixture creates the same validated result as equivalent
  text; uncertain transcription asks for clarification; unsupported or oversized
  input fails clearly; raw-audio retention follows the selected policy.

### 21. Send Spoken Replies And Reminders

- [ ] Complete goal 21.
- Deliver: selectable Epi voice, optional TTS audio attachments, accompanying
  text, response preferences, and provider cost/failure handling.
- Require: generated-audio retention and TTS budget enforcement with text fallback;
  no silent paid-provider switch to bypass the configured spending limit.
- Done when: audio plays on supported Discord clients without joining voice;
  disabling voice leaves text usable; synthesis failure falls back to text.
- Constraint: verify native voice-message support before promising that format.

### 22. Support Server Voice Conversations

- [ ] Complete goal 22.
- Deliver: a compatibility assessment of DiscordNPC's voice approach, explicit
  join/listen/leave controls, speaker authorization, transcription, TTS, and idle exit.
- Done when: Epi converses in a test server voice channel, accepts only authorized
  personal actions, displays listening status, honors stop/leave, and disconnects
  on idle. Verify current voice protocol/encryption and library support first.
- Constraint: no assumption of normal DM-call support or silent recording of others.

### 23. Investigate And Connect Microsoft Calendars

- [ ] Complete goal 23.
- Deliver: tenant-policy feasibility check, Graph authorization if permitted, and
  unified availability without duplicate Google copies; assess read-only alternatives.
- Done when: permitted test events contribute to availability and revocation works.
  If blocked by the institution, record the blocker and supported alternatives;
  do not mark the integration complete or promise immediate subscription refresh.

### 24. Add Dashboard Voice And Optional Activation

- [ ] Complete goal 24.
- Deliver: browser push-to-talk, microphone controls, interruptible spoken replies,
  and a feasibility assessment for "Hey Epi" during an enabled listening session.
- Done when: a permitted microphone session supports the same validated actions
  as text, stopping ends capture, and browser/device limitations are documented.
- Constraint: wake-word support is optional and platform-dependent, not a promise
  of always-on background listening or operation with the browser closed.

## Progress Record

Current next goal: **04 - Secure Shared Data Access**.

- 2026-10-13, Goal 01: wrote
  [the architecture decision record](docs/decisions/0001-initial-architecture.md):
  Next.js dashboard, separate Bun/discord.js worker, shared domain package,
  MySQL 8.4 LTS with Drizzle + mysql2, Railway hosting, OpenAI text provider,
  owner-only, America/Chicago, plus the confirmation expiry, retention, backup
  (RPO 24h/RTO 4h) and $10/month AI budget values. Checks: documentation-only;
  re-read the record against the owner's selections and GOALS.md numbering. Limits:
  no service or account is provisioned; the Railway-offered MySQL version is
  unverified; day boundaries, quiet hours, and notification frequency remain open
  for Goals 12/15.

- 2026-10-13, Goal 02 (completed; owner accepted the local CI replay because no repository exists yet): Bun workspace with
  `apps/web` (Next.js 16.4), `apps/worker` (Bun), `packages/core`, `scripts`,
  `docker-compose.yml` (MySQL 8.4), `.env.example`, ESLint/Prettier/TypeScript,
  Vitest, the staged-secret guard, and `.github/workflows/ci.yml`. Commands are in
  [local development](docs/local-development.md). Checks run: `bun run check`
  (lint with no warnings, format, typecheck for both TS projects) passed;
  `bun run test:run` passed, 45 tests including the guard against temporary git
  repositories and a mutation check that made 3 guard tests fail; `bun run build`
  passed with no configuration. Dashboard and worker were started: missing or invalid
  `DATABASE_URL`/`WORKER_HEALTH_PORT` stops each with a message naming the variable and
  no value; with valid values, `/api/health` (dashboard, dev and production) and
  `/health` (worker) return 200, and the worker exits 0 on SIGTERM. A disposable
  Compose project booted MySQL 8.4.10 healthy, then its container and volume were
  removed. The CI steps were replayed from a clean copy with a credential-free
  environment and a frozen-lockfile install; all passed.
  **Remaining limit:** the workflow has not run on a hosted runner because there is no
  repository, so run it on first push; also `precommit:check`/`security:staged` need a git repository (the
  guard's logic is tested in temporary repos). Limits: health reports configuration
  only; `db:up` was verified through Compose directly with a temporary env file, not
  via `bun run db:up`; `typescript` is pinned to 6.x until typescript-eslint supports 7.

- 2026-10-13, Goal 03 (completed): Drizzle schema for owners, categories/Inbox, tasks, events,
  work blocks, notes, preferences, and action history in `packages/core/src/db/schema.ts`; one
  reviewed migration (`0000_initial_schema`); an own migration runner (named-lock serialization,
  history-tamper and out-of-order detection, partial-failure reporting) with `db:generate`,
  `db:migrate`, `db:status`, and `db:check`; domain operations in `domain.ts`; and
  [database docs](docs/database.md) including DBeaver settings and the recovery procedure.
  Checks run: `bun run check`, `db:check`, and `test:run` (66 tests, none skipped, with the
  disposable MySQL 8.4 test database) passed, as did `build`. Database tests cover clean
  install, a second run applying nothing, two concurrent runners, a tampered history row, an
  upgrade over seeded rows, a deliberately failing two-statement migration with recovery,
  restart persistence, UTC round-trips, a single Inbox under concurrency, the three distinct
  operations (task completion, event cancellation, work-block removal), idempotent repeats,
  owner scoping, and database-enforced CHECK constraints. Mutation checks: removing the lock
  failed the concurrency test; making completion remove work blocks failed the distinct-operation
  test; an unmigrated schema edit failed `db:check`. A throwaway MySQL with a persistent volume
  was migrated, written, restarted as a server, and read back intact, then removed. The CLI
  was run against a disposable database (pending, applied, nothing on rerun).
  Limits: the CI workflow (MySQL 8.4 service, `REQUIRE_DB_TESTS`) has not run on a hosted runner;
  only one real migration exists, so the upgrade check uses a synthetic follow-up migration until
  a second real one exists; the Railway MySQL version is still unverified; the dev database
  (`bun run db:up`) has not been started with your `.env`; web and worker do not use the
  database yet and health still reports it as `not_checked`; completing a task does not yet
  clear its future work blocks (Goal 14).

- 2026-10-13, Goal 04 (implemented; not checked off until one live Discord sign-in is verified): the
  access model in [security](docs/security.md). Core: unforgeable owner principals, the permission
  matrix, version-bound single-use 10-minute confirmations (first handler: `note.delete`),
  shared-channel denial for every action, strict input validation, and secured services that
  return re-read rows (`packages/core/src/services/`, `auth/`). Web: Discord OAuth sign-in with
  hashed server-side sessions, and `/api/tasks` (list, create, complete) behind them
  (`apps/web/lib/`). Migrations `0001_confirmations` and `0002_sessions` were added, and the
  upgrade test now runs from every previous real schema over seeded rows. Checks run: `check`,
  `db:check`, `build`, and 172 tests with none skipped, replayed from a clean copy with a
  credential-free environment. Mutation checks: disabling any of forged-principal rejection,
  shared-audience denial (including confirm/cancel, where a real gap was found and fixed),
  stale-version detection, expiry, hash matching, advice-vs-consent, same-origin checks, session
  expiry, OAuth state comparison, owner-only sign-in, token hashing, or the owner filter made
  tests fail. The built app was served against a real MySQL and driven over HTTP: sign-out, forged
  cookie, no origin, cross-site, other-owner, and unconfigured-sign-in cases all behaved correctly.
  **Open:** the real Discord token exchange cannot complete from the development machine: the
  company network's TLS-inspecting proxy (Zscaler) re-signs Discord's certificate with a company CA
  that WSL, Node, Bun, and curl do not trust (`UNABLE_TO_GET_ISSUER_CERT_LOCALLY`). The consent screen
  and redirect work in the browser; the server-side exchange is covered only against a stubbed
  Discord. Resolution options (trust the company root CA via `NODE_EXTRA_CA_CERTS`, or test from an
  unmanaged network) are in [local development](docs/local-development.md).
  2026-10-13 addendum: added `ENV_BYPASS=dev` (development on localhost only; refused in production
  builds, for non-localhost URLs, and for any value but `dev`; POST and same-origin only; loopback
  bind; audited) so development does not depend on Discord. Sign-in failures now log the underlying
  cause and a certificate hint. Verified: 218 tests (none skipped, clean-copy replay), mutation checks
  on every bypass guard (which exposed and closed an untested URL-hostname check), and the real dev
  server driven over HTTP, plus a production build with the bypass set (sign-in fails closed). Limits: no rate limiting;
  sessions do not slide; only the tasks API exists over HTTP; `note.delete` is the only confirmable
  action so far; the scanner now treats values containing `(` as code.

- 2026-10-14, Goal 05 (completed): responsive `/dashboard` workspace with active/completed tasks
  across school, work, fitness, errands, and personal categories; task
  creation/edit/completion/reopen; notes/ideas creation/editing; owner categories and Inbox;
  category moves/filtering, search, timezone-aware deadlines, and persisted refresh. All personal
  data goes through authenticated `verifySession()` and `createServices(db)`; no table queries or
  new public API routes were added. Goal 05 service methods (`tasks.update/reopen`, `notes.update`,
  `categories.list`, and category list filters) were completed in the shared service layer; the
  already-open-task `reopenTask` no-op guard was fixed and its 26-test MySQL suite passes.
  Verification: `bun run check` passed; full `test:run` with required disposable MySQL passed
  278/278, none skipped; dashboard scoped tests pass 30/30. Browser checks on isolated synthetic
  MySQL data verified task/note/category creation, versioned edits, category moves, Inbox display,
  task completion and reopening, persistence after reload, Chicago timezone conversion, and a
  390px viewport without horizontal overflow. Limits: no production build was run while the
  interactive preview was active; preview data is synthetic and is deleted when the preview is
  stopped. Goal 04 remains unchecked pending live Discord OAuth verification through the proxy.

- 2026-10-14, Goal 12 (engine implemented; not checked off): `packages/core/src/planning/` is a
  pure, database-free module (`@epiphany/core/planning`). It provides DST-safe wall-clock-to-instant
  conversion (a time skipped by spring-forward moves ahead by the gap; a repeated fall-back time uses
  its first occurrence), daily/weekly recurrence with interval, until, and count, occurrence scope
  (skip, move) and this-and-following scope (series split that keeps the interval phase and counted
  totals), and `computeAvailability`/`findConflicts` using events (with travel and buffers), planned
  work blocks, sleep (including windows that cross midnight), meals, recurring and one-off protected
  time, and preferred hours. Days with no preferred hours, and time outside them, are never offered
  as free. Fixed events are instants and do not move when the owner's timezone changes; all-day
  events stay on their own timezone's calendar days and only block when marked blocking. Verification:
  39 planning tests (spring-forward 23 h and fall-back 25 h days, midnight boundaries, timezone
  change, all-day, conflicts) pass, and `bun run check` passes. Remaining before checking off:
  recurring series and the owner's availability preferences are not stored anywhere yet (series need
  a schema and the preferences service needs the Goal 10 handoff), so nothing feeds the engine from
  the database, and no calendar import exists.

- 2026-10-14, Goal 13 (partial; not checked off): the dashboard now opens on a Today view and has a
  Week view (events and planned work blocks on a time grid, all-day and deadline chips, a current-time
  line, overlap warnings, planned versus due effort, tasks completed that day, week navigation, and a
  day-card list on narrow screens). It reads through new range-bounded `events.list` and
  `workBlocks.list` shared services (permission-gated, owner-scoped, at most 62 days and 500 rows per
  request, covered by 4 MySQL tests) and a validated `loadDashboardSchedule` action. Verification: 129
  service and planning tests with MySQL on a disposable database, 155 no-database tests, and
  `bun run check` pass; a browser check on synthetic fixture data confirmed exact block positions,
  overlap columns, week navigation, and no horizontal overflow at 1280 px and 390 px. Later the same
  day the dashboard gained "Add event" (timed or all-day) and "Plan work" forms, and Cancel/Remove
  controls on grid blocks and agenda rows, through validated actions that convert the owner's local
  date and time to instants in the configured timezone on the server (cancel keeps the event record;
  removing a work block leaves its task untouched). A browser check on a disposable database confirmed
  create, overlap flagging, remove, validation errors, an all-day event, and a jump to the event's
  week. Remaining: preparation milestones, sync-failure display (waits for Goal 11), and free-time
  availability on the views (waits for stored preferences).

- 2026-10-15, Goal 07 (groundwork implemented; not checked off): `packages/core/src/assistant/`
  (`@epiphany/core/assistant`) turns a free-form owner message into one validated intent and then
  into permissioned service calls. A model may only return the flat intent schema (respond, clarify,
  list, create, complete, delete-note, confirm, decline); it never produces instants or SQL, local
  dates and times are converted by the application, and an id it supplies is trusted only if it is
  one of the owner's own records the application fetched. Replies are built from persisted rows, so
  a failed change is reported as not done; advice never mutates; an ambiguous reference asks
  "which one?" and a following "the second one" resolves against that list; deletion goes through
  the existing confirmation service (expired, stale, declined, and unrelated-message cases tested).
  Shared audiences get no model call and no data. The monthly budget (default $10, warning at 80%,
  hard stop at 100%, reset on the 1st in America/Chicago) is enforced before every call, and a provider
  outage or exhausted budget produces an honest "nothing was changed" reply with no silent provider
  switch. The OpenAI adapter uses strict structured outputs with per-request token caps and never
  echoes the key or request details in errors. Verification: 45 assistant tests on a disposable MySQL
  database, `bun run check`, and 190 no-database tests pass. The conversation evaluation harness
  (`eval.ts`: 30 cases, 23 held-out paraphrases, an advice-must-not-mutate check, an injection-text
  fixture, and a spend cap) is validated offline with gold and deliberately wrong providers. Not
  done, so the goal stays unchecked: no live model call has been made (the adapter is tested only
  against a fake `fetch`), the OpenAI model ID and token prices are not chosen, usage is held in
  memory rather than persisted, and the live evaluation (`scripts/assistant-eval.ts`, opt-in with
  `AI_EVAL_LIVE=1`) and the Discord and dashboard entry points that call the assistant still need
  to be built or run.

When completing a goal, add a dated note with the implementation location,
checks run, results, and any remaining limits. Change the next-goal pointer only
after the current goal's completion criteria pass.