import { randomBytes } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createConnection } from "mysql2/promise";

export const MIGRATIONS_FOLDER = path.resolve(
  fileURLToPath(new URL("../../drizzle", import.meta.url)),
);
export const TEST_ADMIN_URL = process.env.TEST_MYSQL_ADMIN_URL;
export const REQUIRE_DB_TESTS = process.env.REQUIRE_DB_TESTS === "true";
export const dbTestsEnabled = Boolean(TEST_ADMIN_URL);

const NAME_PATTERN = /^epiphany_test_[0-9a-f]{12}$/;

export interface TestDatabase {
  name: string;
  url: string;
  drop: () => Promise<void>;
  exists: () => Promise<boolean>;
}

async function withAdmin<T>(
  run: (admin: Awaited<ReturnType<typeof createConnection>>) => Promise<T>,
) {
  if (!TEST_ADMIN_URL) throw new Error("TEST_MYSQL_ADMIN_URL is not set.");
  const admin = await createConnection({ uri: TEST_ADMIN_URL });
  try {
    return await run(admin);
  } finally {
    await admin.end();
  }
}

// Creates a uniquely named database. drop() removes only that exact database.
export async function createTestDatabase(): Promise<TestDatabase> {
  if (!TEST_ADMIN_URL) throw new Error("TEST_MYSQL_ADMIN_URL is not set.");
  const name = `epiphany_test_${randomBytes(6).toString("hex")}`;
  await withAdmin((admin) =>
    admin.query(`CREATE DATABASE \`${name}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci`),
  );
  const url = new URL(TEST_ADMIN_URL);
  url.pathname = `/${name}`;

  return {
    name,
    url: url.toString(),
    drop: () =>
      withAdmin(async (admin) => {
        if (!NAME_PATTERN.test(name)) throw new Error(`Refusing to drop ${name}.`);
        await admin.query(`DROP DATABASE IF EXISTS \`${name}\``);
      }),
    exists: () =>
      withAdmin(async (admin) => {
        const [rows] = await admin.query("SHOW DATABASES LIKE ?", [name]);
        return (rows as unknown[]).length > 0;
      }),
  };
}
