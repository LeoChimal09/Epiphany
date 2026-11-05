import type { DatabasePool as Pool } from "../db/client";
type RowDataPacket = Record<string, unknown>;

// Export, restore, and verification of one owner's data. It works from the live schema (every table
// with an owner_id, plus owners), so a table added by a later migration is included automatically.
// Credentials never leave the database: sessions and any column that looks like a token or secret
// are left out of an export, and have to be re-created (sign in again, reconnect a calendar).

export interface OwnerExport {
  version: 1;
  exportedAt: string;
  ownerId: string;
  tables: Record<string, Record<string, unknown>[]>;
}

const SKIP_TABLES = new Set(["__drizzle_migrations", "sessions", "confirmations"]);
const SECRET_COLUMN = /token|secret|password|ciphertext|encrypted/i;

async function ownedTables(pool: Pool): Promise<{ table: string; key: string }[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    `SELECT m.name AS t, p.name AS c FROM sqlite_schema m, pragma_table_info(m.name) p
     WHERE m.type = 'table' AND p.name IN ('owner_id', 'id') ORDER BY m.name`,
  );
  const byTable = new Map<string, Set<string>>();
  for (const row of rows) {
    const table = String(row.t);
    byTable.set(table, (byTable.get(table) ?? new Set()).add(String(row.c)));
  }
  const result: { table: string; key: string }[] = [];
  for (const [table, columns] of byTable) {
    if (SKIP_TABLES.has(table)) continue;
    if (table === "owners") result.push({ table, key: "id" });
    else if (columns.has("owner_id")) result.push({ table, key: "owner_id" });
  }
  return result;
}

async function tableColumns(pool: Pool, table: string): Promise<string[]> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT name AS c FROM pragma_table_info(?) ORDER BY cid",
    [table],
  );
  return rows.map((row) => String(row.c));
}

function encode(value: unknown): unknown {
  if (value instanceof Date) return { $date: value.toISOString() };
  if (Buffer.isBuffer(value)) return { $base64: value.toString("base64") };
  return value;
}

function decode(value: unknown): unknown {
  if (value && typeof value === "object") {
    const tagged = value as { $date?: unknown; $base64?: unknown };
    if (typeof tagged.$date === "string") return Date.parse(tagged.$date);
    if (typeof tagged.$base64 === "string") return Buffer.from(tagged.$base64, "base64");
    // JSON column values are stored as text.
    return JSON.stringify(value);
  }
  return value;
}

// Every record of the owner, as plain JSON a person can read and another system can load.
export async function exportOwnerData(
  pool: Pool,
  ownerId: string,
  now: Date = new Date(),
): Promise<OwnerExport> {
  const tables: OwnerExport["tables"] = {};
  for (const { table, key } of await ownedTables(pool)) {
    const columns = (await tableColumns(pool, table)).filter(
      (column) => !SECRET_COLUMN.test(column),
    );
    const [rows] = await pool.query<RowDataPacket[]>(
      `SELECT ${columns.map((column) => `\`${column}\``).join(", ")} FROM \`${table}\` WHERE \`${key}\` = ?`,
      [ownerId],
    );
    tables[table] = rows.map((row) =>
      Object.fromEntries(columns.map((column) => [column, encode(row[column])])),
    );
  }
  return { version: 1, exportedAt: now.toISOString(), ownerId, tables };
}

// Loads an export into a database that has been migrated but holds none of this owner's data.
// Foreign keys are relaxed only for the load, then the data is verified.
export async function restoreOwnerData(pool: Pool, data: OwnerExport): Promise<{ rows: number }> {
  if (data.version !== 1) throw new Error("Unsupported export version.");
  const connection = await pool.client.transaction("write");
  let rows = 0;
  try {
    await connection.execute("PRAGMA defer_foreign_keys = ON");
    for (const [table, records] of Object.entries(data.tables)) {
      if (!/^[a-z_][a-z0-9_]*$/.test(table)) throw new Error(`Refusing table name ${table}.`);
      for (const record of records) {
        const columns = Object.keys(record);
        if (columns.length === 0) continue;
        const values = columns.map((column) => decode(record[column]));
        if (columns.some((column) => !/^[a-z_][a-z0-9_]*$/.test(column)))
          throw new Error("Invalid column name.");
        await connection.execute({
          sql: `INSERT INTO \`${table}\` (${columns.map((c) => `\`${c}\``).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`,
          args: values as import("@libsql/client").InValue[],
        });
        rows++;
      }
    }
    if ((await connection.execute("PRAGMA foreign_key_check")).rows.length)
      throw new Error("Restored data violates foreign keys.");
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.close();
  }
  return { rows };
}

export interface VerifyResult {
  ok: boolean;
  mismatches: string[];
}

// Compares the restored database with the export, table by table (row counts and a checksum of the
// exported columns), so a silent loss or change is caught.
export async function verifyRestore(pool: Pool, data: OwnerExport): Promise<VerifyResult> {
  const after = await exportOwnerData(pool, data.ownerId, new Date(data.exportedAt));
  const mismatches: string[] = [];
  const sum = (rows: unknown[]) =>
    JSON.stringify(rows.map((row) => JSON.stringify(row)).toSorted());
  for (const [table, records] of Object.entries(data.tables)) {
    const restored = after.tables[table] ?? [];
    if (restored.length !== records.length) {
      mismatches.push(`${table}: ${records.length} rows exported, ${restored.length} restored`);
    } else if (sum(restored) !== sum(records)) {
      mismatches.push(`${table}: contents differ`);
    }
  }
  return { ok: mismatches.length === 0, mismatches };
}

// Things the owner deleted, kept apart from the backup so a restore does not bring them back.
export interface DeletionLedger {
  entries: { table: "notes" | "preferences" | "tasks"; id: string; deletedAt: string }[];
}

const LEDGER_TABLES: Record<string, DeletionLedger["entries"][number]["table"]> = {
  "note.delete": "notes",
  "preference.delete": "preferences",
  "task.delete": "tasks",
};

// Reads the deletions recorded in the action history since a time. Store the result somewhere
// other than the backup (for example next to it, written at the same moment as every backup).
export async function buildDeletionLedger(
  pool: Pool,
  ownerId: string,
  since: Date = new Date(0),
): Promise<DeletionLedger> {
  const [rows] = await pool.query<RowDataPacket[]>(
    "SELECT action, entity_id AS id, created_at AS at FROM action_history WHERE owner_id = ? AND created_at >= ? AND action IN ('note.delete','preference.delete','task.delete')",
    [ownerId, since],
  );
  return {
    entries: rows.map((row) => ({
      table: LEDGER_TABLES[String(row.action)]!,
      id: String(row.id),
      deletedAt: new Date(row.at as Date).toISOString(),
    })),
  };
}

// Removes from a restored database anything the ledger says was deleted after the backup, so
// forgotten data is not reintroduced. Returns how many records it removed again.
export async function applyDeletionLedger(
  pool: Pool,
  ownerId: string,
  ledger: DeletionLedger,
): Promise<number> {
  let removed = 0;
  for (const entry of ledger.entries) {
    if (!["notes", "preferences", "tasks"].includes(entry.table))
      throw new Error("Invalid deletion ledger table.");
    const result = await pool.client.execute({
      sql: `DELETE FROM \`${entry.table}\` WHERE id = ? AND owner_id = ?`,
      args: [entry.id, ownerId],
    });
    removed += result.rowsAffected;
  }
  return removed;
}
