import { createClient, type Client, type InValue, type Transaction } from "@libsql/client";
import { getTableColumns, getTableName } from "drizzle-orm";
import path from "node:path";
import { createConnection, type RowDataPacket } from "mysql2/promise";
import { fileURLToPath } from "node:url";
import * as mysqlSchema from "./mysql-schema";
import { diffMigrations, loadMigrationFiles } from "./mysql-migrate";
import { getSqliteMigrationStatus } from "./sqlite-migrate";
import { sqliteSchema } from "./sqlite-schema";

type DrizzleTable = Parameters<typeof getTableColumns>[0];
const MYSQL_MIGRATIONS_FOLDER = path.resolve(
  fileURLToPath(new URL("../../drizzle", import.meta.url)),
);

interface TableMapping {
  name: string;
  columns: string[];
  sourceTypes: Map<string, string>;
}

interface MysqlField extends RowDataPacket {
  Field: string;
  Type: string;
}

const SQLITE_INTEGER_MIN = -(1n << 63n);
const SQLITE_INTEGER_MAX = (1n << 63n) - 1n;
const SQLITE_MIGRATION_TABLE = "__epiphany_sqlite_migrations";

function getTableMappings(): TableMapping[] {
  // Conversations were introduced after the MySQL cutover and have no legacy source.
  return Object.entries(sqliteSchema)
    .filter(([key]) => key !== "chatSessions")
    .map(([schemaKey, targetTable]) => {
      const sourceTable = (mysqlSchema as Record<string, unknown>)[schemaKey];
      if (!sourceTable || typeof sourceTable !== "object") {
        throw new Error(`The legacy MySQL schema is missing the ${schemaKey} table.`);
      }

      const sourceColumnDefinitions = Object.values(getTableColumns(sourceTable as DrizzleTable));
      const sourceColumns = sourceColumnDefinitions.map((column) => column.name);
      const sourceTypes = new Map(
        sourceColumnDefinitions.map((column) => [
          column.name,
          column.getSQLType().toLowerCase() === "boolean"
            ? "tinyint(1)"
            : column.getSQLType().toLowerCase(),
        ]),
      );
      const targetColumns = Object.values(getTableColumns(targetTable)).map(
        (column) => column.name,
      );
      const name = getTableName(targetTable);
      if (
        sourceColumns.length !== targetColumns.length ||
        sourceColumns.some((column, index) => column !== targetColumns[index])
      ) {
        throw new Error(`The SQLite and legacy MySQL schemas disagree for the ${name} table.`);
      }
      return { name, columns: targetColumns, sourceTypes };
    });
}

export function validateImportUrls(sourceUrl: string, destinationUrl: string): void {
  if (!/^mysql(?:2)?:\/\//i.test(sourceUrl)) {
    throw new Error("MYSQL_SOURCE_URL must be an explicit MySQL connection URL.");
  }
  if (!/^file:/i.test(destinationUrl) || /^file::memory:/i.test(destinationUrl)) {
    throw new Error("DATABASE_URL must be a persistent, file-backed SQLite URL.");
  }
  if (destinationUrl.includes("?") || destinationUrl.includes("#")) {
    throw new Error("DATABASE_URL must not include query parameters or fragments.");
  }
}

export function parseMySqlDateTime(value: string | Date): number {
  if (value instanceof Date) {
    const milliseconds = value.getTime();
    if (!Number.isFinite(milliseconds)) throw new Error("The source contains an invalid date.");
    return milliseconds;
  }
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,3}))?$/.exec(value);
  if (!match) throw new Error("A source date is not a UTC DATETIME(3) value.");
  const [, yearText, monthText, dayText, hourText, minuteText, secondText, fraction = ""] = match;
  const components = [yearText, monthText, dayText, hourText, minuteText, secondText].map(Number);
  const year = components[0]!;
  const month = components[1]!;
  const day = components[2]!;
  const hour = components[3]!;
  const minute = components[4]!;
  const second = components[5]!;
  const milliseconds = Number(fraction.padEnd(3, "0") || "0");
  if (year < 1000 || month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    throw new Error("A source date is outside the supported UTC DATETIME(3) range.");
  }
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute, second, milliseconds));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    throw new Error("A source date is not a valid calendar date.");
  }
  return date.getTime();
}

export function convertMySqlValue(value: unknown, sourceType: string): InValue {
  if (value === null || value === undefined) return null;
  const type = sourceType.toLowerCase();
  if (/^(datetime|timestamp)(?:\(|$)/.test(type)) {
    if (typeof value !== "string" && !(value instanceof Date)) {
      throw new Error("A source date has an unexpected representation.");
    }
    return parseMySqlDateTime(value);
  }
  if (type === "json") {
    if (typeof value !== "string") throw new Error("A JSON source value was not returned as text.");
    try {
      JSON.parse(value);
    } catch {
      throw new Error("A JSON source value is invalid.");
    }
    return value;
  }
  if (/^(tinyint|smallint|mediumint|int|integer|bigint)(?:\(|\s|$)/.test(type)) {
    let integer: bigint;
    if (typeof value === "bigint") {
      integer = value;
    } else if (typeof value === "number" && Number.isSafeInteger(value)) {
      integer = BigInt(value);
    } else if (typeof value === "string" && /^-?\d+$/.test(value)) {
      integer = BigInt(value);
    } else {
      throw new Error("A source integer cannot be represented exactly.");
    }
    if (integer < SQLITE_INTEGER_MIN || integer > SQLITE_INTEGER_MAX) {
      throw new Error("A source integer exceeds SQLite's signed 64-bit range.");
    }
    return integer >= BigInt(Number.MIN_SAFE_INTEGER) && integer <= BigInt(Number.MAX_SAFE_INTEGER)
      ? Number(integer)
      : integer;
  }
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "bigint" ||
    value instanceof Uint8Array
  ) {
    return value;
  }
  throw new Error("A source value has an unsupported representation.");
}

async function validateSourceSchema(
  connection: Awaited<ReturnType<typeof createConnection>>,
  mappings: TableMapping[],
): Promise<Map<string, Map<string, string>>> {
  const types = new Map<string, Map<string, string>>();
  for (const table of mappings) {
    const [result] = await connection.query<MysqlField[]>(`SHOW COLUMNS FROM \`${table.name}\``);
    const fields = result.map((field) => field.Field);
    if (
      fields.length !== table.columns.length ||
      table.columns.some((column) => !fields.includes(column))
    ) {
      throw new Error(
        `The MySQL source does not have the current ${table.name} schema; no data was imported.`,
      );
    }
    if (result.some((field) => table.sourceTypes.get(field.Field) !== field.Type.toLowerCase())) {
      throw new Error(
        `The MySQL source column types do not match the current ${table.name} schema; no data was imported.`,
      );
    }
    types.set(table.name, new Map(result.map((field) => [field.Field, field.Type.toLowerCase()])));
  }
  return types;
}

async function validateCurrentSourceMigrations(
  connection: Awaited<ReturnType<typeof createConnection>>,
): Promise<void> {
  let rows: RowDataPacket[];
  try {
    [rows] = await connection.query<RowDataPacket[]>(
      "SELECT hash, created_at FROM `__drizzle_migrations` ORDER BY created_at ASC, id ASC",
    );
  } catch {
    throw new Error("The MySQL source migration history is missing or unreadable.");
  }
  const files = loadMigrationFiles(MYSQL_MIGRATIONS_FOLDER);
  const status = diffMigrations(
    files,
    rows.map((row) => ({ hash: String(row.hash), when: Number(row.created_at) })),
  );
  if (status.problems.length > 0 || status.pending.length > 0) {
    throw new Error("The MySQL source schema is not at the current migration version.");
  }
}

export async function assertFreshSqliteDestination(transaction: Transaction): Promise<void> {
  const tables = Object.values(sqliteSchema).map(getTableName);
  const objects = await transaction.execute(
    "SELECT name FROM sqlite_master WHERE type IN ('table', 'view', 'trigger') AND name NOT LIKE 'sqlite_%'",
  );
  const names = new Set(objects.rows.map((row) => String(row.name)));
  const expected = new Set([...tables, SQLITE_MIGRATION_TABLE]);
  const unexpected = [...names].filter((name) => !expected.has(name));
  if (unexpected.length > 0) {
    throw new Error(
      `The SQLite destination contains unrecognized objects (${unexpected.join(", ")}); refusing to import.`,
    );
  }
  for (const table of tables) {
    if (!names.has(table)) {
      throw new Error(
        "The SQLite destination schema is not installed; run SQLite migrations first.",
      );
    }
  }
  if (!names.has(SQLITE_MIGRATION_TABLE)) {
    throw new Error("The SQLite destination schema is not installed; run SQLite migrations first.");
  }

  for (const table of tables) {
    const result = await transaction.execute(`SELECT COUNT(*) AS count FROM "${table}"`);
    if (Number(result.rows[0]?.count) !== 0) {
      throw new Error("The SQLite destination is not empty; refusing to import.");
    }
  }
}

export interface MySqlToSqliteImportOptions {
  sourceUrl: string;
  destinationUrl: string;
  onTableImported?: (table: string, rowCount: number) => void;
}

export interface MySqlToSqliteImportResult {
  rowCounts: Record<string, number>;
  totalRows: number;
}

export async function importMySqlToSqlite({
  sourceUrl,
  destinationUrl,
  onTableImported,
}: MySqlToSqliteImportOptions): Promise<MySqlToSqliteImportResult> {
  validateImportUrls(sourceUrl, destinationUrl);
  const mappings = getTableMappings();
  const destination: Client = createClient({ url: destinationUrl, concurrency: 1 });
  try {
    const migrationStatus = await getSqliteMigrationStatus(destination);
    if (migrationStatus.problems.length > 0 || migrationStatus.pending.length > 0) {
      throw new Error("The SQLite destination schema is not fully migrated; refusing to import.");
    }

    const source = await createConnection({
      uri: sourceUrl,
      timezone: "Z",
      dateStrings: true,
      jsonStrings: true,
      supportBigNumbers: true,
      bigNumberStrings: true,
    });
    try {
      await source.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
      await source.query("START TRANSACTION WITH CONSISTENT SNAPSHOT, READ ONLY");
      await validateCurrentSourceMigrations(source);
      const sourceTypes = await validateSourceSchema(source, mappings);

      await destination.execute("PRAGMA foreign_keys = ON");
      const transaction = await destination.transaction("write");
      try {
        await assertFreshSqliteDestination(transaction);
        const rowCounts: Record<string, number> = {};
        let totalRows = 0;
        for (const table of mappings) {
          const columns = table.columns.map((column) => `\`${column}\``).join(", ");
          const [rows] = await source.query<RowDataPacket[]>(
            `SELECT ${columns} FROM \`${table.name}\``,
          );
          const columnTypes = sourceTypes.get(table.name);
          if (!columnTypes) throw new Error("Source schema validation state is incomplete.");
          const placeholders = table.columns.map(() => "?").join(", ");
          const insert = `INSERT INTO "${table.name}" (${table.columns
            .map((column) => `"${column}"`)
            .join(", ")}) VALUES (${placeholders})`;

          for (const row of rows) {
            const args = table.columns.map((column) => {
              const type = columnTypes.get(column);
              if (!type) throw new Error("A source column type is missing.");
              return convertMySqlValue(row[column], type);
            });
            await transaction.execute({ sql: insert, args });
          }

          const result = await transaction.execute(`SELECT COUNT(*) AS count FROM "${table.name}"`);
          const importedCount = Number(result.rows[0]?.count);
          if (importedCount !== rows.length) {
            throw new Error(`SQLite row-count validation failed for ${table.name}.`);
          }
          rowCounts[table.name] = importedCount;
          totalRows += importedCount;
          onTableImported?.(table.name, importedCount);
        }

        const foreignKeyViolations = await transaction.execute("PRAGMA foreign_key_check");
        if (foreignKeyViolations.rows.length > 0) {
          throw new Error("SQLite foreign-key validation failed; the import was rolled back.");
        }
        await source.commit();
        await transaction.commit();
        return { rowCounts, totalRows };
      } catch (error) {
        await transaction.rollback().catch(() => undefined);
        throw error;
      }
    } catch (error) {
      await source.rollback().catch(() => undefined);
      throw error;
    } finally {
      await source.end();
    }
  } finally {
    await destination.close();
  }
}

async function runCli(): Promise<void> {
  const sourceUrl = process.env.MYSQL_SOURCE_URL;
  const destinationUrl = process.env.DATABASE_URL;
  if (!sourceUrl || !destinationUrl) {
    console.error("Set MYSQL_SOURCE_URL and a file-backed SQLite DATABASE_URL explicitly.");
    process.exitCode = 1;
    return;
  }
  try {
    const result = await importMySqlToSqlite({ sourceUrl, destinationUrl });
    console.log(
      `Imported ${result.totalRows} rows across ${Object.keys(result.rowCounts).length} tables.`,
    );
  } catch {
    console.error(
      "Import failed; details withheld to avoid exposing connection credentials or record data.",
    );
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await runCli();
}
