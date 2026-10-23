import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

// The automated part of the Goal 19 release gate: every check that needs no live service. It prints
// a table and exits non-zero if anything fails. The manual part (a real restore, deployed reminders
// with the dashboard closed, the owner walkthrough) is in docs/release-gate.md.
interface Gate {
  name: string;
  run: () => { ok: boolean; detail: string };
}

const sh = (command: string, args: string[], env: Record<string, string> = {}) => {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, ...env },
    maxBuffer: 64 * 1024 * 1024,
  });
  const tail = `${result.stdout}${result.stderr}`.trim().split("\n").slice(-3).join(" | ");
  return { ok: result.status === 0, detail: result.status === 0 ? "passed" : tail.slice(0, 300) };
};

const hasDatabase = Boolean(process.env.TEST_MYSQL_ADMIN_URL);

const gates: Gate[] = [
  {
    name: "lint (no warnings)",
    run: () => sh("bun", ["run", "lint"]),
  },
  { name: "formatting", run: () => sh("bunx", ["prettier", "--check", "."]) },
  { name: "typecheck", run: () => sh("bun", ["run", "typecheck"]) },
  { name: "migrations match schema", run: () => sh("bun", ["run", "db:check"]) },
  {
    name: "tests against disposable MySQL (none skipped)",
    run: () =>
      hasDatabase
        ? sh("bunx", ["vitest", "run"], { REQUIRE_DB_TESTS: "true" })
        : {
            ok: false,
            detail:
              "set TEST_MYSQL_ADMIN_URL (bun run db:test:up) so database tests cannot be skipped",
          },
  },
  {
    name: "production build",
    run: () => sh("bun", ["run", "build"], { NEXT_DIST_DIR: ".next-gate" }),
  },
  {
    name: "environment template covers deployment settings",
    run: () => {
      const template = readFileSync(".env.example", "utf8");
      const needed = [
        "DATABASE_URL",
        "DISCORD_BOT_TOKEN",
        "OWNER_DISCORD_USER_ID",
        "OPENAI_API_KEY",
        "APP_URL",
      ];
      const missing = needed.filter((name) => !new RegExp(`^#?\\s*${name}=`, "m").test(template));
      return missing.length === 0
        ? { ok: true, detail: "passed" }
        : { ok: false, detail: `missing: ${missing.join(", ")}` };
    },
  },
  {
    name: "release documents exist",
    run: () => {
      const docs = [
        "docs/release-gate.md",
        "docs/reminders.md",
        "docs/discord.md",
        "docs/database.md",
        "docs/security.md",
        "docs/operations.md",
      ];
      const missing = docs.filter((file) => !existsSync(file));
      return missing.length === 0
        ? { ok: true, detail: "passed" }
        : { ok: false, detail: `missing: ${missing.join(", ")}` };
    },
  },
];

let failed = 0;
for (const gate of gates) {
  const started = Date.now();
  const result = gate.run();
  if (!result.ok) failed++;
  console.log(
    `${result.ok ? "PASS" : "FAIL"}  ${gate.name} (${Math.round((Date.now() - started) / 1000)}s)${result.ok ? "" : `\n      ${result.detail}`}`,
  );
}
console.log(
  failed === 0
    ? "\nAll automated gates passed. Complete the manual gates in docs/release-gate.md."
    : `\n${failed} gate(s) failed.`,
);
process.exit(failed === 0 ? 0 : 1);
