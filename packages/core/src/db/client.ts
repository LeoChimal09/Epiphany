import { createClient, type Client, type InValue, type ResultSet } from "@libsql/client";
import { drizzle, type LibSQLDatabase } from "drizzle-orm/libsql";
import { chmodSync, closeSync, mkdirSync, openSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import * as schema from "./schema";

export type Database = LibSQLDatabase<typeof schema>;

const queues = new Map<string, Promise<void>>();

export function sqliteFile(databaseUrl: string): string {
  if (
    !databaseUrl.startsWith("file:") ||
    !databaseUrl.slice(5) ||
    databaseUrl.includes("?") ||
    databaseUrl.includes("#") ||
    databaseUrl.includes(":memory:")
  )
    throw new Error(
      "DATABASE_URL must name a persistent SQLite file, e.g. file:/data/epiphany.sqlite.",
    );
  const file = databaseUrl.startsWith("file:/")
    ? fileURLToPath(databaseUrl)
    : resolve(databaseUrl.slice(5));
  if (!file || file.endsWith("/:memory:") || file === process.cwd())
    throw new Error("An on-disk SQLite database is required.");
  return file;
}

async function retryBusy<T>(operation: () => Promise<T>, reset?: () => Promise<void>): Promise<T> {
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      return await operation();
    } catch (error) {
      if (!/SQLITE_BUSY|SQLITE_LOCKED/.test(String(error)) || Date.now() >= deadline) throw error;
      await reset?.();
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
}

export interface DatabasePool {
  client: Client;
  query: <T = Record<string, unknown>[]>(
    statement: string,
    values?: unknown[],
  ) => Promise<[T, unknown[]]>;
  end: () => Promise<void>;
}

export interface DatabaseHandle {
  db: Database;
  pool: DatabasePool;
  close: () => Promise<void>;
}

export function createDatabasePool(databaseUrl: string, connectionLimit?: number): DatabasePool {
  void connectionLimit;
  const file = sqliteFile(databaseUrl);
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
  closeSync(openSync(file, "a", 0o600));
  chmodSync(file, 0o600);
  const raw = createClient({ url: pathToFileURL(file).href, concurrency: 1, timeout: 0 });
  const configure = async () => {
    await raw.execute("PRAGMA foreign_keys = ON");
    await raw.execute("PRAGMA synchronous = FULL");
    await raw.execute("PRAGMA cache_size = -4096");
  };
  const reset = async () => {
    // Failed native BEGIN statements can remain active on Bun; discard that connection.
    await raw.reconnect();
    await configure();
  };
  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = queues.get(file) ?? Promise.resolve();
    let release!: () => void;
    const lock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => lock);
    queues.set(file, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (queues.get(file) === tail) queues.delete(file);
    }
  }
  const ready = exclusive(async () => {
    await retryBusy(() => raw.execute("PRAGMA journal_mode = WAL"), reset);
    await configure();
  });
  const client = new Proxy(raw, {
    get(target, key) {
      if (key === "transaction")
        return async (...args: Parameters<Client["transaction"]>) => {
          await ready;
          const previous = queues.get(file) ?? Promise.resolve();
          let release!: () => void;
          const lock = new Promise<void>((resolve) => {
            release = resolve;
          });
          const tail = previous.then(() => lock);
          queues.set(file, tail);
          await previous;
          const unlock = () => {
            release();
            if (queues.get(file) === tail) queues.delete(file);
          };
          try {
            const transaction = await retryBusy(() => target.transaction(...args), reset);
            return new Proxy(transaction, {
              get(tx, method) {
                const value = Reflect.get(tx, method, tx);
                if (method === "commit" || method === "rollback")
                  return async () => {
                    try {
                      return await value.call(tx);
                    } finally {
                      tx.close();
                      unlock();
                    }
                  };
                if (method === "close")
                  return () => {
                    tx.close();
                    unlock();
                  };
                return typeof value === "function" ? value.bind(tx) : value;
              },
            });
          } catch (error) {
            unlock();
            throw error;
          }
        };
      const value = Reflect.get(target, key, target);
      if (["execute", "batch", "migrate", "executeMultiple"].includes(String(key)))
        return async (...args: unknown[]) => {
          await ready;
          return exclusive(() => retryBusy(() => value.apply(target, args), reset));
        };
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    client,
    async query<T>(statement: string, values: unknown[] = []): Promise<[T, unknown[]]> {
      const result: ResultSet = await client.execute({
        sql: statement,
        args: values.map((value) => (value instanceof Date ? value.getTime() : value)) as InValue[],
      });
      return [result.rows as unknown as T, []];
    },
    async end() {
      try {
        await ready;
      } finally {
        await exclusive(async () => raw.close());
      }
    },
  };
}

export function connectDatabase(databaseUrl: string, connectionLimit?: number): DatabaseHandle {
  const pool = createDatabasePool(databaseUrl, connectionLimit);
  return { db: drizzle(pool.client, { schema }), pool, close: pool.end };
}
