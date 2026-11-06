# SQLite schema, migrations, and MySQL import

SQLite is the new local-file persistence target chosen to reduce Railway's
separate database-service cost. The application stores data in a persistent
file, normally `file:./data/epiphany.sqlite`; a memory database is never a
valid runtime destination. The web and worker processes must share the same
durable volume and file. A local file does not synchronize across isolated
hosts or volumes.

The application schema is `packages/core/src/db/sqlite-schema.ts`. It mirrors
the current legacy MySQL columns and names, stores timestamps as integer epoch
milliseconds, booleans as SQLite integers, and JSON documents as text. Named
indexes, checks, and foreign keys are included. The old MySQL schema and
migrations remain available in `mysql-schema.ts` and `packages/core/drizzle/`;
they are not altered or used to initialize SQLite.
Category-name uniqueness uses SQLite's built-in `NOCASE` collation for
case-insensitive matching. It intentionally does not emulate MySQL's broader
accent- and Unicode-aware collation rules.

## Migrations

Reviewed, versioned SQLite migrations live in
`packages/core/drizzle-sqlite/`. Generate a migration with:

```sh
bun run db:generate
```

Review generated SQL before keeping it. The managed application entrypoint runs
this versioned migration step before launching its child processes. For direct
local web/worker commands, apply migrations explicitly against the selected
SQLite file first:

```sh
DATABASE_URL="file:./data/epiphany.sqlite" bun packages/core/src/db/cli.ts migrate
DATABASE_URL="file:./data/epiphany.sqlite" bun packages/core/src/db/cli.ts status
```

The SQLite runner serializes work in a write transaction, records each
migration's SHA-256 and journal timestamp, refuses changed or out-of-order
history, and safely does nothing on a second run. DDL and history updates commit
or roll back together. The runner only applies reviewed migration files; there
is no schema push or automatic schema synchronization.

Keep MySQL migrations untouched. New schema changes belong in the SQLite schema
and a new SQLite migration; do not generate or apply a legacy MySQL migration
as part of a SQLite deployment.

## One-time MySQL import

Keep the existing MySQL database unchanged. Take and retain a separate backup
before importing. The importer opens the explicit MySQL source read-only,
validates that its migration history, table columns, and SQL types match the
current legacy schema, and reads all tables from one consistent snapshot. It
writes only to a file-backed SQLite destination.

First migrate a new destination file. Set `MYSQL_SOURCE_URL` in a protected
environment to the explicit source connection URL, then run:

```sh
DATABASE_URL="file:./data/epiphany.sqlite" bun packages/core/src/db/cli.ts migrate
DATABASE_URL="file:./data/epiphany.sqlite" bun packages/core/src/db/sqlite-import.ts
```

Do not put real connection URLs in shell history, documentation, or committed
files; use the deployment secret manager or a protected environment. The
importer prints only row totals and withholds connection and record details on
failure.

Import refuses a destination with any application rows, unexpected tables,
views, or triggers. It preserves IDs, UTC `DATETIME(3)` values (as epoch
milliseconds), integer values, and the original JSON text returned by MySQL.
Integers outside SQLite's signed 64-bit range are rejected rather than
truncated. The destination writes run in one transaction; each table's row
count and the final foreign-key check must pass before commit. Any failure
rolls back the destination import. An empty migrated destination can be safely
retried after investigation; a partially populated destination is never
appended to or overwritten.

This tool does not delete, update, migrate, or otherwise write to MySQL. Keep
MySQL and its backup intact until the imported SQLite database has been
independently verified and the owner has confirmed the deployment and rollback
plan. The importer does not deploy services, move a Railway volume, or create
an independent backup.
