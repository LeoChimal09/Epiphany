import fs from "node:fs";
import path from "node:path";
import { readMigrationFiles } from "drizzle-orm/migrator";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

export const MIGRATIONS_TABLE = "__drizzle_migrations";
export const MIGRATION_LOCK_NAME = "epiphany:schema-migrations";

export interface MigrationFile {
  tag: string;
  hash: string;
  when: number;
  statements: string[];
}

export interface AppliedMigration {
  hash: string;
  when: number;
}

export interface MigrationStatus {
  applied: string[];
  pending: string[];
  problems: string[];
}

export class MigrationError extends Error {
  readonly tag: string;
  readonly statementIndex: number;
  readonly statementCount: number;

  constructor(tag: string, statementIndex: number, statementCount: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `Migration ${tag} failed at statement ${statementIndex + 1} of ${statementCount}: ${detail}\n` +
        "MySQL DDL commits implicitly, so earlier statements in this migration may already be " +
        "applied. The migration was NOT recorded. Do not rerun blindly: follow the recovery " +
        "steps in docs/database.md.",
      { cause },
    );
    this.name = "MigrationError";
    this.tag = tag;
    this.statementIndex = statementIndex;
    this.statementCount = statementCount;
  }
}

export function loadMigrationFiles(migrationsFolder: string): MigrationFile[] {
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string; when: number }> };
  const files = readMigrationFiles({ migrationsFolder });
  return journal.entries.map((entry, index) => {
    const file = files[index];
    if (!file) throw new Error(`Migration journal entry ${entry.tag} has no matching file.`);
    return {
      tag: entry.tag,
      hash: file.hash,
      when: file.folderMillis,
      statements: file.sql.map((statement) => statement.trim()).filter(Boolean),
    };
  });
}

async function readApplied(connection: Pool | PoolConnection): Promise<AppliedMigration[]> {
  const [tables] = await connection.query<RowDataPacket[]>(
    "SELECT 1 FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name = ?",
    [MIGRATIONS_TABLE],
  );
  if (tables.length === 0) return [];
  const [rows] = await connection.query<RowDataPacket[]>(
    `SELECT hash, created_at FROM \`${MIGRATIONS_TABLE}\` ORDER BY created_at ASC, id ASC`,
  );
  return rows.map((row) => ({ hash: String(row.hash), when: Number(row.created_at) }));
}

function matchesApplied(file: MigrationFile, entry: AppliedMigration): boolean {
  if (file.when !== entry.when) return false;
  if (file.hash === entry.hash) return true;
  // Release cec7de7 shipped the same ALTER plus the backfill now in 0013.
  // Preserve that recorded history; never rerun its ALTER or accept other changed files.
  return (
    file.tag === "0011_nebulous_outlaw_kid" &&
    file.when === 1793049246426 &&
    file.hash === "242300bca7673f5399a360ad8ba0682f048d3db4d39d5e14c9dc8a793a733de3" &&
    entry.hash === "bae9bfd4833e56f2b357448350f7d29f036c46124a7600c51d6d581d35bf071a"
  );
}

// Compares the journal with recorded history. Problems must be resolved by a person; the
// runner refuses to apply anything while any exist.
export function diffMigrations(
  files: MigrationFile[],
  applied: AppliedMigration[],
): MigrationStatus {
  const problems: string[] = [];
  const byWhen = new Map(files.map((file) => [file.when, file]));
  const appliedFiles = new Set(
    files.filter((file) => applied.some((entry) => matchesApplied(file, entry))),
  );

  for (const entry of applied) {
    const file = byWhen.get(entry.when);
    if (!file) {
      problems.push(`Applied migration (id ${entry.when}) is not in the migrations folder.`);
    } else if (!matchesApplied(file, entry)) {
      problems.push(
        `Applied migration ${file.tag} was modified after it was applied. ` +
          `Database SHA-256: ${entry.hash}; file SHA-256: ${file.hash}; migration timestamp: ${entry.when}. ` +
          "Stop and compare the recorded release before recovery (docs/database.md). " +
          "Do not overwrite migration-history hashes or delete migration rows.",
      );
    }
  }

  const pending = files.filter((file) => !appliedFiles.has(file));
  const lastApplied = applied.reduce((max, entry) => Math.max(max, entry.when), 0);
  for (const file of pending) {
    if (file.when < lastApplied) {
      problems.push(
        `Pending migration ${file.tag} is older than an already-applied migration (out of order). Regenerate it so it sorts last.`,
      );
    }
  }

  return {
    applied: files.filter((file) => appliedFiles.has(file)).map((file) => file.tag),
    pending: pending.map((file) => file.tag),
    problems,
  };
}

async function checkedStatus(
  connection: Pool | PoolConnection,
  files: MigrationFile[],
): Promise<MigrationStatus> {
  const applied = await readApplied(connection);
  const status = diffMigrations(files, applied);
  const legacy0011 = files.some((file) =>
    applied.some((entry) => file.hash !== entry.hash && matchesApplied(file, entry)),
  );
  if (legacy0011) {
    const [columns] = await connection.query<RowDataPacket[]>(
      "SELECT COLUMN_TYPE AS columnType, IS_NULLABLE AS nullable, COLUMN_DEFAULT AS defaultValue " +
        "FROM information_schema.columns WHERE table_schema = DATABASE() " +
        "AND table_name = 'tasks' AND column_name = 'task_type'",
    );
    const column = columns[0];
    if (
      columns.length !== 1 ||
      column?.columnType !== "enum('task','todo')" ||
      column.nullable !== "NO" ||
      column.defaultValue !== "task"
    ) {
      status.problems.push(
        "The released legacy 0011 checksum is recognized, but tasks.task_type does not match " +
          "its expected schema (enum('task','todo') NOT NULL DEFAULT 'task'). " +
          "Stop and inspect the schema before recovery (docs/database.md).",
      );
    }
  }
  return status;
}

export async function getMigrationStatus(
  pool: Pool,
  migrationsFolder: string,
): Promise<MigrationStatus> {
  return checkedStatus(pool, loadMigrationFiles(migrationsFolder));
}

export interface RunMigrationsOptions {
  lockTimeoutSeconds?: number;
  onApplied?: (tag: string) => void;
}

// Applies pending migrations in order. A single MySQL named lock on a dedicated connection
// serializes runners, so concurrent dashboard/worker starts cannot race.
export async function runMigrations(
  pool: Pool,
  migrationsFolder: string,
  options: RunMigrationsOptions = {},
): Promise<{ applied: string[] }> {
  const files = loadMigrationFiles(migrationsFolder);
  const connection = await pool.getConnection();
  try {
    const [lockRows] = await connection.query<RowDataPacket[]>(
      "SELECT GET_LOCK(?, ?) AS acquired",
      [MIGRATION_LOCK_NAME, options.lockTimeoutSeconds ?? 60],
    );
    if (Number(lockRows[0]?.acquired) !== 1) {
      throw new Error("Could not acquire the migration lock; another migration may be running.");
    }

    try {
      await connection.query(
        `CREATE TABLE IF NOT EXISTS \`${MIGRATIONS_TABLE}\` (id SERIAL PRIMARY KEY, hash text NOT NULL, created_at bigint)`,
      );
      const status = await checkedStatus(connection, files);
      if (status.problems.length > 0) {
        throw new Error(`Migration history problems:\n- ${status.problems.join("\n- ")}`);
      }

      const applied: string[] = [];
      for (const file of files.filter((entry) => status.pending.includes(entry.tag))) {
        for (const [index, statement] of file.statements.entries()) {
          try {
            await connection.query(statement);
          } catch (error) {
            throw new MigrationError(file.tag, index, file.statements.length, error);
          }
        }
        await connection.query(
          `INSERT INTO \`${MIGRATIONS_TABLE}\` (hash, created_at) VALUES (?, ?)`,
          [file.hash, file.when],
        );
        applied.push(file.tag);
        options.onApplied?.(file.tag);
      }
      return { applied };
    } finally {
      await connection.query("SELECT RELEASE_LOCK(?)", [MIGRATION_LOCK_NAME]);
    }
  } finally {
    connection.release();
  }
}
