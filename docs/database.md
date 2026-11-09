# Database

Epiphany uses an on-disk SQLite database. The web and worker processes must share the
same durable file on one host. Separate Railway services cannot share an ordinary
SQLite file. Production deployment uses one service, one `/data` volume, and one replica;
see [operations](operations.md) and the [SQLite cutover guide](sqlite.md).

`DATABASE_URL=file:/data/epiphany.sqlite` selects the production file.
For local development use `file:./data/epiphany.sqlite` from the repository root.
The client creates the containing directory, not the schema. Run `bun run db:migrate`
before starting either process. Never put the production database in the image or an
ephemeral deployment directory.

## Schema and behavior

The current schema is `packages/core/src/db/sqlite-schema.ts`, reexported by `schema.ts`.
Versioned SQL and journal snapshots live in `packages/core/drizzle-sqlite`.
The original MySQL schema and migrations remain import-only historical references;
see [legacy recovery notes](database-mysql-legacy.md).

IDs, owner permissions, service APIs, and history are unchanged. UTC instants are stored
as integer epoch milliseconds and mapped to JavaScript `Date`s. JSON uses text columns
with JSON validation, and booleans use integers. Display timezones remain owner/event
settings. Foreign keys are enabled on every connection and never cascade personal
record deletion.

WAL mode permits concurrent reads. Writes and read-then-write decisions use SQLite
write transactions instead of MySQL row locks. Local clients serialize operations and
retry transient busy errors without blocking the JavaScript event loop. Keep external
network requests outside database transactions. A busy timeout is a failed operation,
not permission to bypass confirmation, version, or deduplication checks.

Personal records are accessed through `createServices`. Task completion/cancellation
retires planned blocks and unsent reminders atomically while retaining deadlines/history.
Event acknowledgement stops check-ins without erasing appointments. Imported external
appointments remain read-only. Reopening never resurrects old reminders or retired blocks.

Dashboard conversations use the additive `0002_fair_sleepwalker` migration. Run
`bun run db:migrate` before using saved chats. `createServices().conversations` owns
all transcript access, with owner/private-audience checks, optimistic turn claims,
and server-stored context rather than client-supplied state. Refresh never resends
a request. Interrupted requests require checking the record before deliberately retrying.
Only metadata, not transcript text, is copied into action history.

Chats expire 90 days after creation, keep at most 100 messages, and are physically
purged on the owner's next conversation access. The dashboard lists the 50 most recently
updated chats. Saved planning records have independent retention and are not deleted
when chats expire.

## Commands

| Command | Purpose |
| --- | --- |
| `bun run db:migrate` | Apply pending SQLite migrations to `DATABASE_URL`. |
| `bun run db:status` | Check applied/pending migrations and checksums. |
| `bun run db:generate` | Generate SQL after editing `sqlite-schema.ts`; review it. |
| `bun run db:check` | Verify schema and migration snapshots agree without a database. |
| `bun run db:import:mysql` | Import a stopped, backed-up MySQL source into an empty SQLite target. |
| `bun run restore:drill` | Verify a privacy-filtered owner export in a disposable SQLite file. |

There is no `db:push`. Never edit applied migration files. Add corrective migrations.
SQLite migrations and their journal entries are transactional: a failed migration rolls
back instead of leaving partially applied DDL. Back up before migrating real data.

## Backups and migration

Keep the existing MySQL service and a restorable backup until cutover validation passes.
Stop **all** old writers before transferring data; otherwise new records can be lost.
The full source import preserves IDs, UTC values, JSON, encrypted calendar credentials,
and record relationships. Use the same calendar encryption key after moving.
Do not point old MySQL application builds at SQLite or vice versa.

The owner JSON export deliberately excludes sign-in sessions, pending confirmation rows,
and credential fields. Unexpired chat transcripts are included, but active execution
leases are not restored and interrupted turns are never automatically replayed.
It is not a full disaster-recovery backup. For a live full SQLite
backup use SQLite's online backup API/tooling or stop writers and checkpoint before
copying; copying just the main file during WAL writes can lose committed data.
Keep encrypted, off-host backups and test recovery. A persistent volume alone is not
a backup. Reverting to MySQL after new SQLite writes requires a reconciled transfer;
blindly restarting old writers loses those new changes.

## Tests

Normal database suites create unique temporary on-disk SQLite fixtures, migrate them,
close their clients, remove only their own fixture directory, and verify cleanup.
They run without Docker or external credentials. Optional legacy MySQL/import tests use
`TEST_MYSQL_ADMIN_URL` against a disposable server, never production data.

Connect DBeaver using its SQLite driver and the exact database file for inspection.
Manual writes bypass service authorization/history and are not a supported editing flow.
