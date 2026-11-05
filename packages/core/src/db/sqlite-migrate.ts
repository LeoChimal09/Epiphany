import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Client, Transaction } from "@libsql/client";

export const SQLITE_MIGRATIONS_TABLE = "__epiphany_sqlite_migrations";
export const SQLITE_MIGRATIONS_FOLDER = path.resolve(
  fileURLToPath(new URL("../../drizzle-sqlite", import.meta.url)),
);

export interface SqliteMigrationFile {
  tag: string;
  hash: string;
  when: number;
  statements: string[];
}

export interface AppliedSqliteMigration {
  hash: string;
  when: number;
}

export interface SqliteMigrationStatus {
  applied: string[];
  pending: string[];
  problems: string[];
}

export interface SqliteMigrationOptions {
  onApplied?: (tag: string) => void;
}

export function loadSqliteMigrationFiles(
  migrationsFolder = SQLITE_MIGRATIONS_FOLDER,
): SqliteMigrationFile[] {
  const journal = JSON.parse(
    fs.readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries: Array<{ tag: string; when: number }> };
  return journal.entries.map(({ tag, when }) => {
    const sqlPath = path.join(migrationsFolder, `${tag}.sql`);
    const contents = fs.readFileSync(sqlPath, "utf8");
    const statements = contents
      .split(/-->\s*statement-breakpoint/g)
      .map((statement) => statement.trim())
      .filter(Boolean);
    if (statements.length === 0) {
      throw new Error(`SQLite migration ${tag} contains no statements.`);
    }
    return {
      tag,
      hash: createHash("sha256").update(contents).digest("hex"),
      when,
      statements,
    };
  });
}

export function diffSqliteMigrations(
  files: SqliteMigrationFile[],
  applied: AppliedSqliteMigration[],
): SqliteMigrationStatus {
  const problems: string[] = [];
  const fileByWhen = new Map<number, SqliteMigrationFile>();
  for (const file of files) {
    if (fileByWhen.has(file.when)) {
      problems.push(`Migration timestamp ${file.when} is duplicated in the migration journal.`);
    }
    fileByWhen.set(file.when, file);
  }

  const appliedFiles = new Set<SqliteMigrationFile>();
  const seenAppliedTimes = new Set<number>();
  for (const entry of applied) {
    if (seenAppliedTimes.has(entry.when)) {
      problems.push(
        `Migration timestamp ${entry.when} appears more than once in migration history.`,
      );
    }
    seenAppliedTimes.add(entry.when);
    const file = fileByWhen.get(entry.when);
    if (!file) {
      problems.push(
        `Applied SQLite migration (timestamp ${entry.when}) is not in the migrations folder.`,
      );
    } else if (file.hash !== entry.hash) {
      problems.push(
        `Applied SQLite migration ${file.tag} was modified after it was applied. ` +
          `Database SHA-256: ${entry.hash}; file SHA-256: ${file.hash}; migration timestamp: ${entry.when}.`,
      );
    } else {
      appliedFiles.add(file);
    }
  }
  const lastApplied = applied.reduce((latest, entry) => Math.max(latest, entry.when), 0);
  const pendingFiles = files.filter((file) => !appliedFiles.has(file));
  for (const file of pendingFiles) {
    if (file.when < lastApplied) {
      problems.push(
        `Pending SQLite migration ${file.tag} sorts before an already-applied migration. ` +
          "Add a new migration with a later timestamp instead.",
      );
    }
  }

  return {
    applied: files.filter((file) => appliedFiles.has(file)).map((file) => file.tag),
    pending: pendingFiles.map((file) => file.tag),
    problems,
  };
}

async function hasHistoryTable(transaction: Transaction): Promise<boolean> {
  const result = await transaction.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?",
    args: [SQLITE_MIGRATIONS_TABLE],
  });
  return result.rows.length > 0;
}

async function readApplied(transaction: Transaction): Promise<AppliedSqliteMigration[]> {
  if (!(await hasHistoryTable(transaction))) return [];
  const rows = await transaction.execute(
    `SELECT hash, created_at FROM "${SQLITE_MIGRATIONS_TABLE}" ORDER BY created_at ASC, id ASC`,
  );
  return rows.rows.map((row) => ({
    hash: String(row.hash),
    when: Number(row.created_at),
  }));
}

async function statusInTransaction(
  transaction: Transaction,
  files: SqliteMigrationFile[],
): Promise<SqliteMigrationStatus> {
  return diffSqliteMigrations(files, await readApplied(transaction));
}

export async function getSqliteMigrationStatus(
  client: Client,
  migrationsFolder = SQLITE_MIGRATIONS_FOLDER,
): Promise<SqliteMigrationStatus> {
  const files = loadSqliteMigrationFiles(migrationsFolder);
  const transaction = await client.transaction("write");
  try {
    const status = await statusInTransaction(transaction, files);
    await transaction.commit();
    return status;
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
}

export async function runSqliteMigrations(
  client: Client,
  migrationsFolder = SQLITE_MIGRATIONS_FOLDER,
  options: SqliteMigrationOptions = {},
): Promise<{ applied: string[] }> {
  const files = loadSqliteMigrationFiles(migrationsFolder);
  const transaction = await client.transaction("write");
  try {
    await transaction.execute(
      `CREATE TABLE IF NOT EXISTS "${SQLITE_MIGRATIONS_TABLE}" (` +
        "id INTEGER PRIMARY KEY AUTOINCREMENT, hash TEXT NOT NULL, created_at INTEGER NOT NULL)",
    );

    const status = await statusInTransaction(transaction, files);
    if (status.problems.length > 0) {
      throw new Error(`SQLite migration history problems:\n- ${status.problems.join("\n- ")}`);
    }

    const applied: string[] = [];
    for (const file of files.filter((entry) => status.pending.includes(entry.tag))) {
      for (const [index, statement] of file.statements.entries()) {
        try {
          await transaction.execute(statement);
        } catch (error) {
          throw new SqliteMigrationError(file.tag, index, file.statements.length, error);
        }
      }
      await transaction.execute({
        sql: `INSERT INTO "${SQLITE_MIGRATIONS_TABLE}" (hash, created_at) VALUES (?, ?)`,
        args: [file.hash, file.when],
      });
      applied.push(file.tag);
    }

    await transaction.commit();
    for (const tag of applied) options.onApplied?.(tag);
    return { applied };
  } catch (error) {
    await transaction.rollback().catch(() => undefined);
    throw error;
  }
}

export class SqliteMigrationError extends Error {
  readonly tag: string;
  readonly statementIndex: number;
  readonly statementCount: number;

  constructor(tag: string, statementIndex: number, statementCount: number, cause: unknown) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super(
      `SQLite migration ${tag} failed at statement ${statementIndex + 1} of ${statementCount}: ${detail}. ` +
        "Its transaction was rolled back; inspect the cause before retrying.",
      { cause },
    );
    this.name = "SqliteMigrationError";
    this.tag = tag;
    this.statementIndex = statementIndex;
    this.statementCount = statementCount;
  }
}
