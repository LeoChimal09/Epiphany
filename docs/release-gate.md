# Release gate (Goal 19)

The first release is the text assistant: dashboard, Discord text, Google Calendar, notes, memory, and
configurable accountability. Voice is not part of it. Run the automated gates with:

```
bun run gate
```

It runs lint (no warnings), formatting, typecheck, `db:check`, the full test suite against the
disposable SQLite files, the production build, and
checks that the environment template and release documents are complete.
For a database cutover, also run the optional legacy migration/import tests with
`TEST_MYSQL_ADMIN_URL` pointed at a disposable MySQL server (`bun run db:test:up`).

## What each gate proves

| Gate (from GOALS.md) | Where it is checked |
| --- | --- |
| Automated checks for goals 03-18 | `bun run gate` (the suites for database, services, assistant, overview, reminders, planning, calendar) |
| Shared dashboard/worker persistence | One Railway service supervises both processes against one persistent SQLite volume; child exits stop the sibling (docs/operations.md) |
| Graceful shutdown | `apps/worker/src/index.ts` handles SIGTERM/SIGINT within 10 s; `worker.test.ts` |
| Redacted logs | Logs are JSON events with error classes and codes only; tests assert no message text or keys are logged (assistant `interpret_failed`, provider errors) |
| Safe migration rollout | Startup migration before both children (serialized SQLite transaction, checksum/out-of-order validation, transactional DDL); recovery in docs/database.md |
| Selected host's runtime secrets | Variables per service in docs/operations.md; `.env.example` is checked by the gate |
| Cross-service outage tests | AI down: assistant says nothing was changed and reminders still send (reminder tests run with no model). Discord down: reminders retry, then are recorded `failed`. SQLite unavailable: fails closed, nothing invented. Google down: sync records the error and the rest keeps working |
| Budget-limit tests | Text budget (assistant), voice budget (voice tests): stop at 100%, no silent provider switch |
| Conversation suite | `packages/core/src/assistant/eval.ts` (offline); the live run is `AI_EVAL_LIVE=1 bun scripts/assistant-eval.ts` |
| Isolated restore against RPO/RTO | `bun run restore:drill` (below) |
| Usable exports | `exportOwnerData` produces readable JSON per owner, without credentials |
| Deletion-aware restore | The deletion ledger is re-applied after a restore (below) |

## Targets and the restore drill

Recovery targets (docs/decisions/0001-initial-architecture.md): **RPO 24 hours, RTO 4 hours**.

```
SOURCE_DATABASE_URL="file:/path/to/epiphany.sqlite" bun run restore:drill
```

It exports the owner's data, restores it into a disposable database, verifies every table, applies the
deletion ledger, prints the time taken against the targets, and removes only the database it created.

**Deletion-aware restore.** A backup older than a deletion would bring the deleted note or memory back.
Every deletion (note, remembered preference, task) is written to the action history; the drill builds a
*deletion ledger* from it and re-applies it after the restore. In production the ledger must be stored
**apart from the backup** and written whenever a backup is taken; if the whole database is lost, a ledger
kept only inside it is lost too.

## Manual gates (need the deployed system)

These cannot be completed from a development machine. Tick each one after doing it for real and record the
date and result in the GOALS.md progress record.

- [ ] One Railway service and persistent volume deployed from the release commit; `/api/health` and the worker health port
      answer; the worker logs `discord_ready`.
- [ ] A real Railway SQLite backup restored into a scratch file and verified with the drill; time
      recorded against the 4 h target.
- [ ] The full flow with real accounts: create a task in Discord, see it on the dashboard, plan a work
      block, receive the reminder in private `#check-ins`, reply "finished it", and see it complete everywhere.
- [ ] The same reminder delivered with the dashboard closed, and after restarting the worker.
- [ ] Stop the OpenAI key, the Discord token, and the database one at a time and confirm the documented
      behavior (docs/operating-policies.md "Outages").
- [ ] Owner onboarding walkthrough (docs/operations.md) followed from a clean Discord server.
- [ ] Monitoring: the alert described in docs/operations.md fires when the worker stops.
