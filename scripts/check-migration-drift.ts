import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

// Fails when schema.ts differs from the committed migrations (a schema change without a
// migration) or when the migration snapshots are inconsistent. Needs no database.
const migrations = "packages/core/drizzle";
const schema = "packages/core/src/db/schema.ts";

function drizzleKit(args: string[]): string {
  try {
    return execFileSync("node_modules/.bin/drizzle-kit", args, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const { stdout = "", stderr = "" } = error as { stdout?: string; stderr?: string };
    throw new Error(`drizzle-kit ${args[0]} failed:\n${stdout}${stderr}`, { cause: error });
  }
}

const sqlFiles = (folder: string) => readdirSync(folder).filter((name) => name.endsWith(".sql"));

function main(): void {
  const scratch = mkdtempSync(join(process.env.TMPDIR ?? tmpdir(), "epiphany-drift-"));
  try {
    drizzleKit(["check", "--dialect", "mysql", "--out", migrations]);

    const copy = join(scratch, "drizzle");
    cpSync(migrations, copy, { recursive: true });
    // drizzle-kit prefixes --out with "./", so pass a path relative to the working directory.
    const output = drizzleKit([
      "generate",
      "--dialect",
      "mysql",
      "--schema",
      schema,
      "--out",
      relative(process.cwd(), copy),
      "--name",
      "drift_probe",
    ]);

    const existing = sqlFiles(migrations);
    if (sqlFiles(copy).some((name) => !existing.includes(name))) {
      throw new Error(
        "schema.ts has changes without a migration. Run `bun run db:generate`, review the SQL, and keep both.",
      );
    }
    // drizzle-kit can exit 0 after an internal error, so require its explicit all-clear.
    if (!output.includes("No schema changes")) {
      throw new Error(
        `Unexpected drizzle-kit output; cannot confirm migrations are current:\n${output}`,
      );
    }
    console.log("Migrations match schema.ts and are internally consistent.");
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  console.error(error instanceof Error ? error.message : "Migration drift check failed.");
  process.exit(1);
}
