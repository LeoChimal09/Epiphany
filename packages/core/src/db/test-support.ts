import { mkdtemp, rm, access } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle-sqlite", import.meta.url));
export const TEST_ADMIN_URL = undefined;
export const REQUIRE_DB_TESTS = true;
export const dbTestsEnabled = true;

export interface TestDatabase {
  name: string;
  url: string;
  drop: () => Promise<void>;
  exists: () => Promise<boolean>;
}

export async function createTestDatabase(): Promise<TestDatabase> {
  const directory = await mkdtemp(join(tmpdir(), "epiphany-test-"));
  const file = join(directory, "epiphany.sqlite");
  return {
    name: directory,
    url: pathToFileURL(file).href,
    drop: () => rm(directory, { recursive: true, force: true }),
    exists: async () => {
      try {
        await access(file);
        return true;
      } catch {
        return false;
      }
    },
  };
}
