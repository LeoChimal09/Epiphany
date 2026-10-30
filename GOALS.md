# Epiphany Build Goals

This is the execution checklist for [the product plan](README.md). Goals 01-05,
07, and 08 are complete; Goal 06 is the earliest open goal.
The current focus is Goal 12 by owner request; Goal 11 live checks are deferred.
Build one goal at a time, verify its completion criteria, and then
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

- [x] Complete goal 04. Owner confirmed functional sign-in on 2026-10-22;
  service authorization and persisted-write checks are recorded below.
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

- [x] Complete goal 07. Owner accepted on 2026-10-22; see progress record below.
- Deliver: AI intent interpretation, validated internal read/write capabilities,
  natural clarification, conversational context, and confirmed action responses.
- Require: the conversation evaluation harness, applicable held-out paraphrases,
  expired-confirmation tests, and text-provider budget enforcement/fallback checks.
- Done when: differently worded requests retrieve, create, and complete fixture
  tasks without prefixes; ambiguous references ask a question; failed actions
  are not reported as successful; advice does not mutate records.

### 08. Add Homework Intake And Automatic Sorting

- [x] Complete goal 08. Owner accepted on 2026-10-22; see progress record below.
- Deliver: mixed-message extraction, pasted-homework review, default Inbox,
  category changes, duplicate detection, and linked source messages.
- Done when: one out-of-order message produces separate assignment and idea
  records; uncertain/missing dates are flagged; corrections update classification;
  casual chat and no-save requests do not become durable tasks or notes.

### 09. Synchronize Discord And Dashboard Views

- [ ] Complete goal 09.
- Owner confirmed information retention on 2026-10-22. This does not yet verify
  the distinct Discord/dashboard synchronization acceptance checks below.
- Deliver: updated Discord overview messages, detail threads where useful,
  dashboard refresh/update delivery, and activity history with practical undo.
- Done when: a Discord completion appears on the dashboard and a dashboard edit
  appears in Discord; retries do not duplicate entries; deleting an overview
  message does not delete its underlying records.

### 10. Add Personal Memory And Continuity

- [ ] Complete goal 10.
- Owner confirmed retained information and recall after refresh on 2026-10-22.
  Remaining acceptance covers preference correction/forgetting and privacy/history
  behavior, not whether saved information survives refresh.
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
- Owner confirmed OAuth connection on 2026-10-22 and asked to defer further calendar
  checks. On 2026-10-23 the production Calendars page showed the primary, holiday, and
  Epiphany calendars up to date. Live task-deadline/work-block writes, conflict, and
  disconnect acceptance remain pending.
- 2026-10-23 follow-up: implemented idempotent task-deadline events on the dedicated
Epiphany calendar (date-only deadlines are all-day; timed tasks with estimates span
the estimate ending at the due time; unestimated timed tasks remain 15-minute markers)
and fixed narrow agenda text wrapping. Focused tests and the full automated
  release gate passed; a real task event write still needs confirmation after deployment.
- Deliver: OAuth consent, secure token storage, calendar selection, external
  event references, sync status, and a dedicated Epiphany calendar for writes.
- Require: version-aware conflict checks, visible stale/pending sync state, and
  reconciliation of uncertain writes before retries; test concurrent external edits.
- Done when: authorized events appear in the app; a fixture work block can be
  created/updated without duplication; disconnect prevents future access;
  expired or revoked access is handled visibly. Test writes use a test calendar.

### 12. Compute Availability And Scheduling Constraints

- [ ] Complete goal 12.
- Active next goal by owner request on 2026-10-22. First slice corrects overnight
  weekday-specific protected time so it blocks the following morning, including
  when that morning is the first requested date and across daylight-saving changes.
- Local scheduling controls and calendar availability are now implemented (2026-10-22):
  see the verification record below. Owner workflow acceptance remains pending.
- Deliver: timezone-aware availability using events, sleep, meals, travel,
  buffers, preferred hours, and protected time; recurrence and conflict handling.
- Check: occurrence versus series scope, all-day events, daylight-saving changes,
  and timezone changes without silently shifting fixed external appointments.
- Done when: fixed test schedules yield expected free windows, including
  timezone/day-boundary cases, and empty calendar time is not treated as
  automatically usable when blocked by preferences.

### 13. Build Today, Week, And Priorities Views

- [ ] Complete goal 13.
- Day/week/month, unified Tasks filters, countdowns, history, and past/today markers
  already exist. Availability and preparation milestones were added locally on
  2026-10-22; live desktop/mobile acceptance remains pending.
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
  text, response preferences, and provider cost/failure handling. Spoken output
  reuses the already-generated text reply; speech synthesis must not trigger a
  second conversational-model call.
- Require: generated-audio retention and TTS budget enforcement with text fallback;
  no silent paid-provider switch to bypass the configured spending limit. Voice
  output is opt-in or explicitly requested, and ordinary text replies remain
  available without synthesis.
- Done when: audio plays on supported Discord clients without joining voice;
  disabling voice leaves text usable; synthesis failure falls back to text; tests
  verify that speech output uses the original reply without another conversation call.
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

### 2026-10-30: Application-Wide Visual Refresh

Owner-requested visual refresh across sign-in, dashboard navigation/headers,
chat, task/todo/event records, notes/ideas, calendar views, scheduling preferences,
calendar connections, confirmations, notifications, and the dashboard error page.
Shared global design tokens replace the disconnected black/gray palettes with
layered slate surfaces, violet actions, mint highlights, and warmer note accents.
Typography, spacing, focus states, empty states, selected navigation, and form
surfaces are consistent. Settings and calendar links are also discoverable in the
desktop sidebar. Existing workflows, authorization, and saved records are unchanged.

Verification: `bun run check`, 192 dashboard tests, `git diff --check`, and
`NEXT_DIST_DIR=.next-gate bun run build` passed. Five database-backed tests were
skipped without the disposable test database; no schema changes were made in this
slice. Local Chromium smoke checks covered desktop/mobile sign-in, all six main
views, event composition, expanded settings, and calendar connections. Additional
checks at 320/390/768/1024/1440 pixels verified chat layout; checks covered
conditional repeat/reminder controls, mobile task readability, reduced motion,
and absence of browser runtime errors. Browser screenshots were inspected; this
caught and corrected squeezed mobile task cards, misplaced chat send controls with
voice enabled, and clipped settings time fields. Browser checks did not submit
record/settings changes, send AI messages, or invoke voice/provider APIs.
No application dependencies were added, and nothing was committed or deployed.

### 2026-10-30: Conditional Controls, Visual Clarity, And Local Schema Recovery

The event composer now shows a required occurrence count only after daily or weekly
repetition is selected, and resets repetition when switching item types or all-day
mode. Todos no longer offer deadline-only split reminders; events label their
default as off rather than implying inheritance of the task default. Disabled
workspace split reminders hide the count without submitting an invalid hidden
edit. Task, todo, and event cards, badges, and selected filters now use distinct
accents plus icons/text. Scheduling disclosures have distinct icons, subtitles,
accent colors, open indicators, and keyboard focus styling.

The reported record/schedule loading failures also exposed the unapplied
`0014_sweet_omega_red` migration on the configured loopback database. Applied that
additive migration locally; `bun run db:status` reports none pending. Actual
owner-scoped task, note, category, event, work-block, preference, and calendar
overview reads through the shared services passed without changing records.
This does not migrate any remote deployment.

Verification: 89 focused dashboard/reminder/action tests, `bun run check`,
`bun run db:check`, `git diff --check`, and the isolated production build
(`NEXT_DIST_DIR=.next-gate bun run build`) passed. No browser interaction, live
Discord/model, or remote deployment acceptance was performed. Nothing committed
or deployed; running remote services still need the migration and updated code.

### 2026-10-30: Conversation Recovery And Local Repeating Events

Owner-requested fix/feature slice, without marking any additional goal complete:
the shared OpenAI adapter now fits optional context to the input budget, preserving
the current message, latest reminder, and pending confirmation. Short requests
no longer fail indefinitely because older conversation/records filled the cap.
The fixed prompt is also shorter; completion reports must not be interpreted as
consent to enable duration tracking. Event acknowledgments can resolve explicit
dates/times and numbered occurrence follow-ups without completing unrelated tasks.

Timed local events now support bounded daily/weekly recurrence, intervals, chosen
weekdays, and a count or inclusive end date. The dashboard form offers simple
daily/weekly repeats. Occurrences are saved atomically, keep local wall times
across DST, and survive restarts. Cancellation previews one occurrence or the
entire series, uses the existing owner/version/expiry-bound confirmation, keeps
history, and stops affected scheduled reminders. See [calendar](docs/calendar.md)
and the [recurrence decision](docs/decisions/0001-initial-architecture.md#2026-10-30-bounded-local-event-recurrence).

Verification: `bun run check`, `bun run db:check`, the release gate's complete
disposable-MySQL suite (none skipped), clean/upgrade/idempotent migration tests,
and production build passed. Generated migration metadata initially failed
formatting; it was formatted and the full check passed afterward. Final focused
assistant/provider/intent/tool regressions passed, covering crowded web/Discord
topic changes, date/time event completion, recurring occurrence selection, and
safe cancellation. Fixtures were removed and their absence verified by the tests.
No live-model/Discord/Google or browser interaction checks were run. Nothing was
committed or deployed; apply additive migration `0014_sweet_omega_red` before
deploying both services. Open-ended/all-day recurrence and series editing remain
unsupported; the 520-occurrence/30-year bound is documented rather than silent.

Current next goal: **06 - Connect Discord And Create The Workspace**.

Official checked-off goals are **01 (architecture), 02 (skeleton), 03 (database), 04 (secure access),
05 (basic dashboard), 07 (free-form understanding), and 08 (intake/sorting)**.
The owner explicitly accepted 07/08 on 2026-10-22; earlier entries retain their
verification status at the time. The owner also reported good recall after refresh
for 09/10, but did not accept those goals as fully complete, so both remain unchecked.
Google Calendar is not connected/live for the owner; local integration code and
offline tests do not make Goal 11 operational or complete.
The owner confirmed functional sign-in on 2026-10-22, closing Goal 04's live OAuth
acceptance gate. Retention/recall for 09/10 is confirmed; remaining synchronization,
memory-control and privacy gates still apply to those unchecked goals.

- 2026-10-22, owner acceptance update: sign-in is functional, completing Goal 04
  alongside its previously recorded service checks. The owner also confirmed that
  Goals 09/10 retain information; no further refresh-persistence confirmation is
  needed. This report does not establish cross-platform update delivery or all
  inspect/correct/forget acceptance checks. Seven goals are checked off; Goal 06
  is next. No implementation or deployment changed in this documentation update.

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
  day the dashboard gained "Add event" and "Plan work" forms, plus Cancel/Remove controls on grid
  blocks and agenda rows, through validated actions that convert the owner's local
  date and time to instants in the configured timezone on the server (cancel keeps the event record;
  removing a work block leaves its task untouched). A browser check on a disposable database confirmed
  create, overlap flagging, remove, validation errors, an all-day event, and a jump to the event's
  week. The Calendar page now uses the same "Add task" composer as Active tasks; its calendar timing
  mode can estimate minutes or set an explicit start/end range, avoiding separate manual
  event/work-session controls. Existing calendar events and work sessions remain visible and removable. Remaining:
  preparation milestones, sync-failure display (waits for Goal 11), and free-time availability on
  the views (waits for stored preferences).

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

- 2026-10-19, production follow-ups (Goals 04 and 07 stay as recorded above): the deployed dashboard
  shows the signed-in owner's Discord name and picture (migration `0004_owner_avatar`; read through
  the new `owner.profile` service and the `owner.read` permission; the bypass never renames the
  owner). Assistant replies are now conversational: the model is asked for two to four short
  sentences, answers are capped at 700 characters at a sentence boundary, and action replies read
  naturally ("Got it, I added ..."). Assistant failures are now logged (`interpret_failed`, with the
  provider's HTTP status or the error class and code, never message text or keys); before this, a
  provider or budget failure produced the "can't interpret" reply with no log line. The strict
  structured-output schema no longer sends `default`/`minLength`/`maxLength`, which some providers
  reject; lengths are still enforced locally. Checks run: lint, format, typecheck, `db:check`,
  `build`, and the full test suite against the disposable MySQL (upgrade test now seeds the
  0003 schema and tolerates added columns). Not verified: a live OpenAI call (no credits
  available), the new migration on Railway, and the avatar against a real Discord sign-in.

- 2026-10-19, Goal 06 (implemented in code; not checked off, no live Discord run): the worker bot
  now links Discord messages to the owner by Discord ID (it previously passed the Discord ID where an
  owner ID was needed, which would have failed every message), answers only the owner, treats a
  channel as private only when Discord says `@everyone` cannot see it, and answers mentions elsewhere
  as a shared audience with no personal data. Workspace setup is conversational (new
  `setup_workspace` intent, `workspace.setup` permission, injected capability): it creates the private
  `epiphany` category and seven channels with owner-and-bot-only permissions, only in servers shared
  with the owner, reuses existing ones, repairs deleted ones, shares one run between simultaneous
  requests, stops and reports on a missing permission, and DM-checks the owner after a server-side
  setup. See [Discord](docs/discord.md). Checks run: lint, format, typecheck, and the full suite
  (adds routing, plan application, adapter-with-fake-guild, and assistant setup tests plus four
  evaluation cases). Remaining before checking off: create the Discord application, enable the
  Message Content intent, invite the bot, and verify against a real server: channels created once,
  rerun reuses them, an owner message reaches the service, a second account is ignored, and a blocked
  DM is reported.

- 2026-10-19, Goal 08 (implemented offline; not checked off, no live model run): the assistant has two
  new intents. `capture` takes up to 12 independent items from one message or a pasted list
  (assignment, idea, or note) and saves each as its own record: tasks keep the owner's original
  message (`source_text`) and a source reference (`discord:<channel>/<message>` or
  `dashboard:ask-epi`); items go to an existing category the model named, otherwise the Inbox, and
  Epi never creates a category from model output. A missing or unclear date is stored as a
  `review_note` (migration `0005_task_review_note`), shown on the dashboard task as "Needs review"
  and cleared automatically when a deadline is set. Likely duplicates of open tasks or notes (and
  repeats within one message) are skipped and reported rather than saved twice. `recategorize`
  moves a task or note after a correction ("that's a school thing"), resolving "the first one"
  against what was just created and asking when ambiguous. "Don't save this", "just chatting", and
  similar phrases are enforced in code (`nosave.ts`), so a model mistake cannot create records from
  them. Checks run: lint, format, typecheck, and the full suite against the disposable MySQL (new
  tests for the out-of-order mixed message, flagged dates, categories, duplicates, per-item
  failures, no-save, corrections, shared audiences, plus five held-out evaluation cases); mutation
  checks that disabling the no-save guard, duplicate detection, or the source link failed tests.
  Remaining before checking off: run the live evaluation with a real model (`AI_EVAL_LIVE=1`) and
  confirm the pasted-homework behavior in a real conversation; the dashboard does not yet let the
  owner clear a review flag without setting a date, and attachments are not read.
  2026-10-19 follow-up from a real production test (a pasted Canvas list of 12 assignments saved only
  the first, because the deployed build predated `capture`): pasted school-system text now has its
  own prompt guidance (course codes, "Go to course", points, date headings, "Today"), a capture holds
  up to 30 items, the message limit is 8000 characters (it was 2000), the default output cap is 4000
  tokens (it was 1000, too small for a long list), and the reply lists the first 12 tasks and counts
  the rest. A Canvas-style case was added to the held-out evaluation.
  The assistant now says so when it cannot handle everything: a message over the 8000-character
  limit (the dashboard counts and blocks it instead of silently cutting a paste), an answer cut off
  at the output cap or an input over the token cap ("send it in smaller pieces"), a paste of more
  than 30 items (it says how many it left out), and a reminder to skim the Inbox after any longer
  paste, since messy text can be misread. Discord: Epi logs `discord_ready`, sends the owner a
  one-time DM offering the workspace when it is in a server the owner is in, and a mention in a
  public channel now says to DM it for setup (it previously gave the generic privacy refusal).
  2026-10-19 correction after the bot sat in the owner's server without creating anything: setup was
  only on request, which was easy to miss. Epi now sets up automatically, at startup and when added,
  in a server the owner owns (adding it there is the approval; idempotent, and the owner is DMed what
  it created or what permission is missing, a problem only once). In a server the owner merely
  belongs to it still only offers.

- 2026-10-19, Goal 09 (implemented offline; not checked off, no live Discord run): overview messages for
  `today`, `schedule`, `priorities`, `notes-and-ideas`, and `activity-log` are rendered from the
  records (`packages/core/src/overview/`, pure and deterministic, escaped so titles cannot ping,
  under 2000 characters) and kept in step by the worker (`overview-sync.ts`): one message per view,
  edited in place only when the content changed, recreated if deleted (records untouched), an
  orphaned message adopted by its marker instead of duplicated, and per-view failures isolated, so
  retries never duplicate. Bindings live in `discord_overviews` (migration `0006`, read and written
  through `overviews` services). Discord changes sync immediately and dashboard changes within 30
  seconds; the dashboard re-reads every 30 seconds while visible (it waits during an action and
  drops stale results). "Undo" reverses the last completion or category move in a conversation
  (`lastChange`, cleared by anything else said). Checks run: lint, format, typecheck, and the full
  suite against the disposable MySQL (render, sync with a fake server, services, a real-record
  test that a Discord completion and a dashboard edit both appear, undo, upgrade seeds through
  0005). Remaining before checking off: verify in a real server that the messages post once,
  update after a dashboard edit, and reappear after deletion; threads for detailed items are not
  built; undo covers only the last completion or move, not creations or deletions.

- 2026-10-20, Goal 11 (implemented offline; NOT checked off: no live Google run was possible): OAuth
  connect/callback/disconnect (`/api/google/*`: authorization code + PKCE + `state`, offline access,
  owner-only, same-origin POST disconnect; missing config fails closed with a message), AES-256-GCM
  token storage (`TOKEN_ENCRYPTION_KEY`), migration `0008_google_calendar` (`calendar_accounts`,
  `synced_calendars`, `calendar_event_refs`), a typed Google Calendar REST client over an injectable
  `fetch` (pagination, `syncToken` with 410 full resync, `If-Match`, 429/rate-limit backoff, bounded
  retries, uncertain writes never retried blindly), a sync engine (`packages/core/src/calendar/`:
  idempotent import of all-day, timezone and recurring-instance events, cancellations, no sync loops;
  work blocks pushed only to the dedicated "Epiphany" calendar with ETag conflict checks and
  reconciliation of uncertain writes by private key before any retry), `calendar.*` permissions and
  services, a Calendars page (`/dashboard/calendars`, from the account menu) with connect, status,
  calendar selection, sync state, conflict choices and disconnect, and a worker runner started from
  `worker.ts` (does nothing when Google is unconfigured). See [calendar](docs/calendar.md). Checks
  run: lint, format, typecheck, `db:check`, `build`, and the full suite against the disposable MySQL
  (token crypto and tamper tests; client tests on a fake `fetch`; 36 sync tests on an in-memory Google
  covering idempotence, no duplicates, no loops, concurrent external edit => conflict not overwrite,
  uncertain-write reconciliation, disconnect, invalid_grant, outages, and owner isolation; service
  permission and web route tests; the upgrade test now seeds `0007`). Mutation checks on 11 safety
  behaviors (If-Match, own-calendar-only writes, loop guard, conflict detection, uncertain-write
  reconciliation, token wipe on disconnect, OAuth state, 410, invalid_grant, consent, token binding)
  each made tests fail. **Remaining before checking off (needs a real Google
  account):** create the OAuth client and add yourself as a test user; set the three variables on
  Railway; connect once from the deployed dashboard; confirm your events appear, the "Epiphany"
  calendar is created once, a test work block appears there and updates without duplicating, an edit
  made in Google Calendar shows as a conflict, Disconnect removes access (and the app disappears from
  myaccount.google.com/permissions), and that an access removed at Google shows "needs to be connected
  again". Also unverified live: Google's actual behavior for the `calendar.app.created` scope on
  `calendarList`, recreating an event with a previously deleted ID, and the unverified-app consent screen.
  Limits: one Google account per owner; no Microsoft (Goal 23); only the next 180 days and the past 30
  are read (rolling, re-read weekly); no push notifications (polls every 5 minutes); no
  occurrence-versus-series edits of external events (they are read-only); the dashboard week view does
  not yet badge individual blocks with their sync state (the Calendars page lists blocks that are not in sync).

- 2026-10-20, Goals 07/08 follow-up (local implementation; goals remain unchecked):
  standalone greetings, thanks, and simple approval/rejection replies bypass the model
  and its budget gate, but still require an authenticated private owner conversation.
  Multi-item captures now show every extracted item in a numbered preview, with dates,
  categories, and review flags, before any save. Approval is model-free, owner-bound,
  expires in ten minutes, rechecks current duplicates, and preserves the original task
  source. Unrelated messages discard the preview. Missing deadlines are flagged in
  code; same-title tasks with conflicting details are no longer silently deduplicated.
  Interpretation receives existing category names. Discord sends long reviews in full
  across multiple messages with mentions disabled. Partial imports explicitly distinguish
  validated failures from unverified writes and warn before retrying; the dashboard does
  not label unverified writes as unchanged. Verification: 183 focused tests passed across
  12 files, including isolated MySQL imports, expiry/decline/owner checks, budget exhaustion,
  source preservation, duplicate rechecks, partial failures, state validation, and server-
  rendered chat UI. Typecheck, scoped lint, formatting, and whitespace checks passed.
  The test runner now transforms JSX for component tests using its existing Oxc support;
  no dependencies were added. Limits: no supplied reproduction paste or live-model
  evaluation, no live Discord/Railway deployment, and no production build was run for this
  follow-up. Configured AI is still required to enter private chat; the bypassed routine
  paths consume no model tokens. Single-item requests retain immediate-save behavior.

- 2026-10-20, Goals 10, 12-18, 19-24 (implemented offline; none checked off, nothing run live). What exists:
  - **10 memory:** `remember`/`list_memory`/`forget` intents; explicit memories are kept, inferred ones are
    proposed and unused until confirmed; provenance shown; forget goes through the confirmation service;
    confirmed memories are given to the model; the year-old completed task stays searchable and inactive.
    Retention: see docs/reminders.md and docs/release-gate.md (deletion ledger). Attachments are not kept.
  - **12/13 planning:** availability now reads the owner's stored `planning.*` preferences (defaults never
    offer overnight or meal time). Still missing: free time and preparation milestones on the dashboard views.
  - **14 conversational planning:** `show_schedule` (grounded overview, free time, proposals), `plan_work`
    (conflict-checked, offers the next free window), proposals scheduled only after a yes and re-checked,
    completing a task clears its remaining planned blocks (kept in history).
  - **15 reminders:** persistent jobs, dedupe keys, claim-before-send, interrupted jobs become `unknown` and
    are not resent (at-most-once), bounded backoff, quiet hours, daily limit, grace/catch-up, merged summary
    after outages, no AI call. See docs/reminders.md for the chosen defaults.
  - **16/17 check-ins and routines:** morning briefing built at send time, event reminders and "still going?"
    checks, replies ("finished it", snooze, not going) tied to the reminder, pause/resume, activity follow-ups,
    early-finish choices, bedtime/workout/hourly routines, conversational settings (daily-limit increases ask
    first). Buttons are not built.
  - **18 personalization:** opt-in (explicit yes), only owner-reported durations and snoozes are recorded, a
    single report concludes nothing (three needed), corrections override, pause and erase (confirmed) work.
  - **19 release gate:** `bun run gate`, `bun run restore:drill`, export/restore/verify and the deletion
    ledger (`packages/core/src/ops`), docs/release-gate.md, docs/operations.md. The manual gates need the
    deployed system.
  - **20/21/22/24 voice:** audio-message intake, spoken replies (ElevenLabs then OpenAI, own budget), live
    voice session rules and a `@discordjs/voice` adapter, dashboard push-to-talk with stop-speaking. See
    docs/voice.md. All tested against fakes; the live Discord voice path is entirely unverified.
  - **23 Microsoft:** feasibility and alternatives recorded in docs/microsoft-calendar.md; the integration is
    deliberately not built until the tenant answer is known.
  Migrations `0007` to `0009` add reminders, Google Calendar, usage, and observations tables.

- 2026-10-21, Goals 07/08 idea and intake follow-up (verified locally, not deployed):
  idea capture supports constructive feedback in the same interpretation call. The
  `develop_idea` intent appends deduplicated bullets to the same owner-scoped idea,
  preserves its original body, and uses expected-version updates to refuse concurrent
  overwrites. Active ideas are re-read through `notes.get`; ambiguous references ask
  which idea, and advice/no-save messages do not edit notes. The user's six-assignment
  course-card paste is now parsed without a model call when the entire format matches;
  incomplete or ambiguous layouts still use interpretation, never a partial parse.
  Dates use the owner's local today, with explicit AM/PM conversion. The exact supplied
  paste saves all six assignments after preview/approval, including course details,
  points, source text, and the source reference, with zero provider calls even at the
  AI budget limit. A consistent flat-list count blocks saving a one-item extraction of
  a ten-entry list; independent multi-goal captures are covered by preview/save tests.
  Expanded the opt-in model evaluation with the supplied paste, mixed-life goals,
  initial idea feedback, and follow-up bullet development. Verification: 213 tests
  across 13 focused files passed with required disposable MySQL; typecheck, scoped
  lint, formatting, and whitespace checks passed. No dependency or schema changes.
  Limits: no live-model evaluation or deployed Discord/Google/voice checks were run.
  GitHub main/dev and latest recorded deployments still reference 45dfd67; channel
  setup and these follow-ups remain local. No commit, push, or deployment performed.

- 2026-10-21, Goals 07/08 manual intake follow-up: user screenshots show a six-item
  preview, approval, a six-item save response, and corresponding dashboard tasks
  with the expected deadlines. The first title incorrectly retained the greeting.
  `assistant/intake.ts` now excludes a bounded introductory phrase such as
  "Hey epi heres my assignments," before validating the complete course-card list.
  Existing saved titles are not changed. Verification: 43 parser/no-save tests,
  typecheck, scoped lint, formatting, and whitespace checks passed. Reload
  persistence, cancellation, duplicate handling, and idea development still need
  manual acceptance; no goal is newly marked complete.

- 2026-10-21, dashboard growth and calendar clarification: the user confirmed that
  all six imported tasks survived a page reload. Ask Epi now shows only five upcoming
  tasks, with navigation to all tasks and the current week. Task lists page loaded
  records in groups of 20, reset on view/search/category changes, and clamp when
  records disappear. The existing 100-per-status initial fetch remains bounded;
  Task history retains incremental access to older records. Calendar help now
  distinguishes due markers from study blocks rather than claiming sync is always
  disconnected. The exact course-card fixture places deadlines on October 21, 22,
  25, and 26 without inventing work sessions. Verification: 66 focused parser,
  dashboard-rendering, model, and schedule tests passed; typecheck and scoped lint
  passed. No external calendar connection, real data edits, or deployment performed.

- 2026-10-21, unified Calendar navigation: replaced separate Today/Week sidebar entries
  with one Calendar entry and Day/Week/Month controls. Previous/next navigation and
  Today work within the selected view; month cells open day details. Month ranges
  include complete Monday-first weeks, including adjacent-month spillover, and load
  every displayed week through the existing authorized schedule action. Cross-week
  records are deduplicated; a failed week is reported rather than silently omitted;
  outdated requests cannot replace the selected range. Month cells cap previews at
  three entries and show a remaining count. Task deadline truncation is visible.
  Verification: 46 focused calendar/dashboard/model tests passed, including leap-year
  and year-boundary month ranges, all-week loading, rendering, deduplication and
  failures; typecheck and scoped lint passed. No schema changes or deployment.

- 2026-10-22, idea organization follow-up: idea development retains flexible labels
  (Concern, Problem, Goal, or custom text) and groups appended bullets under one
  owner-local date heading per day. Legacy content is preserved under its stored
  creation date when first developed; earlier points are not retroactively labeled.
  The dashboard renders idea date headings, real bullet lists and emphasized labels;
  plain notes and the plain-text editor remain unchanged. A new model prompt and
  held-out evaluation case treat a contributed concern as idea development rather
  than losing it as casual chat; opinion-only and no-save guards remain in force.
  Date grouping and duplicate handling add no model calls or schema changes.
  Verification: seven MySQL-backed idea tests and 21 focused journal, rendering,
  provider and evaluation tests passed; typecheck and scoped lint passed. MySQL
  creation timestamps and the injected conversation clock are tested separately.
  Live model interpretation quality remains unverified; no deployment or edits
  to existing personal ideas were performed.

- 2026-10-22, compact idea cards: idea bodies now use a native, keyboard-accessible
  details/summary accordion, collapsed by default. Titles, creation timestamps and
  Edit controls remain visible; expanding Idea details reveals the preserved dated
  sections and labeled bullets. No saved content is changed. Verification: five
  focused rendering tests, typecheck, scoped lint, formatting and whitespace checks
  passed. Local only; no deployment performed.

- 2026-10-22, idea resumption after refresh: fixed the OpenAI request serializer
  omitting the freshly loaded active idea (and existing category/list-count
  metadata). Added a read-only resume_idea intent for returning to a saved project
  without requiring invented new points. The action resolves owner-scoped ideas,
  clarifies ambiguity, returns a bounded saved-body recap and establishes active
  context for subsequent requests without changing the note or its version.
  Browser refresh still resets the full transient chat; resumption restores
  persisted idea context, not the previous transcript. Verification: 22 parser,
  provider and evaluation tests and nine MySQL-backed idea tests passed; typecheck
  passed. The screenshot's exact provider failure cannot be determined without
  its sanitized interpret_failed log; no live provider call or deployment performed.

- 2026-10-22, conversational provider follow-up: OpenAI now returns ordinary text
  with at most one optional function proposal, rather than a mandatory structured
  JSON envelope. Each supported action exposes only its own arguments; capture
  items are sparse, and idea feedback accompanies the same completion. Existing
  intent validation, owner-bound shared services, no-save rules, confirmations,
  scripted providers, and read-only idea resumption remain in place. Invalid
  optional actions preserve useful discussion with an explicit unsaved warning;
  invalid-only, refusal and truncation paths fail without claiming an outage or
  executing anything. Available usage costs are retained on rejected output, and
  input estimates include function schemas. No automatic retry, repair, or second
  model call was added. Evaluation rejects malformed actions and accounts for
  output failures rather than falsely passing their fallback text.
  Verification: 197 offline tests across 13 focused assistant files passed,
  including all 29 action tools, conversation failures, authorization/no-save
  guards and service refusal; workspace/dashboard typecheck, scoped ESLint,
  scoped Prettier and whitespace checks passed. ESLint emitted its existing
  React auto-detection notice. No MySQL/persistence test, live-model evaluation,
  API request, credential read, commit, or deployment was performed. Provider
  quality and measured token savings remain unverified; no goal was checked off.

- 2026-10-22, deadline notification follow-up: added a dedicated dashboard area
  derived from authorized loaded tasks, showing timed deadlines within one hour,
  due now and overdue, plus calendar-based date-only notices. Five-item paging,
  task navigation and the disclosed initial 100-open-task limit retain access to
  full task history. Mark done uses the existing persisted completion action;
  no response never completes work. Timed countdowns now use actual elapsed
  days/hours/minutes (including an earlier deadline today or last night), and
  all task lists use the same hydration-safe dashboard clock.
  Reused the persistent reminder engine and worker; added a one-hour default
  alongside 24/2 hours without overriding confirmed owner preferences or changing
  dedupe, quiet hours, pause, retry/catch-up or daily-limit policies. Reminder
  text asks for explicit completion, and timed pauses use the injected worker clock.
  Verification: the final 131 targeted tests across ten files passed with a
  dedicated disposable MySQL Compose fixture, including persisted completion/
  reload/history, owner isolation, 61/60-minute boundaries, restart dedupe,
  silence, delivery safeguards, dashboard/calendar regressions, and three offline
  Discord-runner tests with external fetch blocked. Typecheck, scoped ESLint,
  scoped Prettier and whitespace checks passed. The exact fixture databases,
  container and network were removed and cleanup verified.
  Dashboard notifications work only while the page is open;
  background Discord needs the worker and enabled DMs. No new overdue-DM loop
  or Discord buttons; natural replies use existing assistant context/interpretation.
  No personal-data changes, live credentials/model/Discord calls, commit or deployment.
  All incomplete goal checkboxes and the next-goal pointer remain unchanged.

- 2026-10-22, owner acceptance and stale-idea follow-up: the owner explicitly
  confirmed Goals 07/08 complete, so their checkboxes are now checked. Their report
  that recall works well after refresh is partial evidence for 09/10, not full
  acceptance; those remain unchecked. Google Calendar remains unconnected and
  unverified live for this owner, regardless of the local Goal 11 implementation.
  Duplicate idea screenshots exposed an unguarded `create_note` path: a repeated
  same-title idea proposal could save a second card even on an unrelated actionable
  follow-up. The shared assistant now uses existing title/body matching and
  owner-scoped retrieval (including the freshly fetched active idea) to clarify
  before saving a matching-title idea. Changed content is called out explicitly,
  never silently discarded or auto-appended. Ordinary notes and distinct ideas
  keep their existing behavior; `develop_idea` still appends validated new points.
  Provider guidance prioritizes the current message and separates project ideas,
  reference notes, and actionable maintenance/reminder requests. Missing reminder
  timing calls for a question, not an invented deadline. No new reminder API or
  scheduling architecture was added. Existing duplicate cards are not deleted.
  Verification: 234 tests across nine focused assistant files passed with a
  dedicated disposable MySQL server. Cases cover scripted stale `create_note`
  follow-ups, optional-tool dispatch, truthful clarification without invented
  timing, fresh active-idea retrieval outside the recent-note pool, changed
  content, legitimate development, distinct ideas, ordinary notes, owner isolation,
  and a reminder-after-idea evaluation with history. Workspace/dashboard
  typecheck, scoped ESLint, scoped Prettier, and whitespace checks passed
  (ESLint emitted its existing React auto-detection notice).
  Fixture databases were verified absent, and the dedicated test container and
  network were removed with cleanup verified.
  Tests simulate provider output; no live output was inspected or invented as
  evidence of what the deployed model actually returned. No live model/Discord/
  calendar calls, personal-data or credential changes, commit, or deployment.

- 2026-10-22, unified task browsing: removed the separate Priorities navigation
  entry and added All tasks / With due date or duration / Just tasks filters to
  Tasks. Due-date and duration metadata remain visible; tasks with neither show
  a Just task label. Filter changes reset paging; search and category filtering
  remain compatible. No persisted task records or scheduling rules are changed.

- 2026-10-22, Goals 12/13 (implemented locally; owner desktop/mobile acceptance pending):
  added `/dashboard/planning` in the account menu with separate, collapsed save controls
  for preferred hours, sleep, meals, recurring protected time, event buffers, optional
  default travel, and minimum block length. Validated settings are saved as confirmed
  preferences through owner-scoped services, with existing-version conflict checks.
  Dashboard schedule snapshots now include these preferences and Google sync warnings.
  A collapsed Availability and preparation panel uses the shared, model-free engine
  to show upcoming usable windows and bounded, per-task preparation milestones before
  exact deadlines. It distinguishes overdue work, missing estimates, conflicting blocks,
  covered effort and insufficient time. Suggestions are not bookings or a joint plan;
  only loaded deadlines and blocks in the displayed range are considered.
  Added padding around event reads for travel/buffers crossing the loaded week boundary,
  and shared travel defaults with Epi's conversational planning.
  Verification: 191 dashboard/planning tests passed; 2 unrelated database-backed tests
  skipped in the unit run. Five selected MySQL cases passed for persisted settings,
  owner isolation, conversational free time, confirmed scheduling, and shared-channel
  restrictions. Typechecks, scoped ESLint and production build passed. Fixture schemas
  were verified absent. Google live checks remain deferred; no external service calls,
  owner preference changes, deployment, or commit were performed.

- 2026-10-22, dashboard selection and explicit confirmation:
  task checkboxes now select records without mutation; page selection and an explicit
  Mark selected done action open a dialog naming the affected tasks. Single-task,
  calendar and notification completion use the same confirmation UI. Completed
  tasks remain in history; partial bulk failures are reported explicitly.
  Notes/ideas have a Delete action using existing version-bound, expiring proposals;
  cancellation preserves the item and editing after preview invalidates confirmation.
  Deletion is permanent, with an explicit warning, not a recoverable trash feature.
  Verification: dashboard unit/render/action tests, five isolated MySQL action cases
  (selected-only completion, history, cancellation, stale previews, owner isolation),
  typechecks, ESLint, formatting and production build passed. No owner records were
  deleted or completed, and no deployment or commit was performed.

When completing a goal, add a dated note with the implementation location,
checks run, results, and any remaining limits. Change the next-goal pointer only
after the current goal's completion criteria pass.