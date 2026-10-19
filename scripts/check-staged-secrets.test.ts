import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { findStagedSecrets, formatFindings, scanContent, scanPath } from "./check-staged-secrets";

// Synthetic, obviously fake values assembled at runtime so this file holds no token-shaped literal.
const fake = {
  discord: ["M" + "A".repeat(23), "B".repeat(6), "C".repeat(27)].join("."),
  openai: "sk-" + "Z".repeat(40),
  googleSecret: "GOCSPX-" + "Y".repeat(24),
  googleKey: "AIza" + "X".repeat(35),
  privateKey: "-----BEGIN " + "RSA PRIVATE KEY-----",
  password: "synthetic" + "Password1",
};
const env = (name: string, value: string) => [name, value].join("=");

describe("scanContent", () => {
  it.each([
    ["Discord bot token", fake.discord],
    ["OpenAI API key", fake.openai],
    ["Google OAuth client secret", fake.googleSecret],
    ["Google API key", fake.googleKey],
    ["private key block", fake.privateKey],
  ])("flags a %s", (reason, value) => {
    const findings = scanContent("notes.txt", `line one\nvalue ${value} here`);
    expect(findings).toEqual([{ file: "notes.txt", line: 2, reason: `possible ${reason}` }]);
  });

  it("flags secret assignments with real-looking values", () => {
    const findings = scanContent(".env.local.txt", env("OPENAI_API_KEY", "abc123"));
    expect(findings).toHaveLength(1);
    expect(findings[0]?.reason).toContain("OPENAI_API_KEY");
  });

  it("flags a database URL with a real-looking password", () => {
    const url = "mysql://epiphany:" + fake.password + "@127.0.0.1:3407/epiphany";
    expect(scanContent("config.txt", `url ${url}`)).toHaveLength(1);
  });

  it("allows empty and placeholder values", () => {
    const content = [
      env("DISCORD_BOT_TOKEN", ""),
      env("OPENAI_API_KEY", "your-key-here"),
      env("MYSQL_PASSWORD", "replace-with-local-password"),
      "MYSQL_PASSWORD: ${MYSQL_PASSWORD:?Set it in .env}",
      "DATABASE_URL=mysql://epiphany:replace-with-local-password@127.0.0.1:3407/epiphany",
    ].join("\n");
    expect(scanContent(".env.example", content)).toEqual([]);
  });

  it("allows only the documented local default password", () => {
    const local = [
      env("MYSQL_PASSWORD", '"epiphany"'),
      "DATABASE_URL=mysql://epiphany:epiphany@127.0.0.1:3319/epiphany",
    ].join("\n");
    expect(scanContent(".env.example", local)).toEqual([]);

    const lookalike = env("MYSQL_PASSWORD", "epiphany-" + "prod-pw1");
    expect(scanContent("a.txt", lookalike)).toHaveLength(1);
    expect(scanContent("a.txt", "mysql://epiphany:" + "epiphany1" + "@host/db")).toHaveLength(1);
  });

  it("treats a schema or code expression as code, not as a secret value", () => {
    const code = 'DISCORD_CLIENT_SECRET: required("the application client secret"),';
    expect(scanContent("config.ts", code)).toEqual([]);
    expect(scanContent("config.ts", env("OPENAI_API_KEY", "abc123"))).toHaveLength(1);
    expect(scanContent("config.ts", 'const key = "' + fake.openai + '";')).toHaveLength(1);
  });

  it("never includes the matched value in formatted output", () => {
    const findings = scanContent("a.txt", env("OPENAI_API_KEY", fake.openai));
    expect(formatFindings(findings)).not.toContain(fake.openai);
  });

  it("skips lockfiles and binary content", () => {
    expect(scanContent("bun.lock", fake.openai)).toEqual([]);
    expect(scanContent("blob.bin", `${fake.openai}\u0000`)).toEqual([]);
  });
});

describe("scanPath", () => {
  it.each([
    ".env",
    ".env.local",
    "apps/web/.env.production",
    "id.pem",
    "tls.key",
    "voice.wav",
    "dev.sqlite",
  ])("blocks %s", (file) => expect(scanPath(file)).toHaveLength(1));

  it.each([".env.example", ".env.local.example", "src/index.ts", "docs/notes.md"])(
    "allows %s",
    (file) => expect(scanPath(file)).toEqual([]),
  );
});

describe("findStagedSecrets with a temporary git repository", () => {
  let repo: string;

  const git = (...args: string[]) =>
    execFileSync("git", args, {
      cwd: repo,
      stdio: "pipe",
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
    });
  const stage = (file: string, content: string) => {
    mkdirSync(dirname(join(repo, file)), { recursive: true });
    writeFileSync(join(repo, file), content);
    git("add", "--", file);
  };

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), "epiphany-secret-guard-"));
    git("init", "--quiet");
  });

  afterEach(() => rmSync(repo, { recursive: true, force: true }));

  it("reports a staged secret by file and line", () => {
    stage("src/config.ts", `export const a = 1;\nconst key = "${fake.openai}";\n`);
    expect(findStagedSecrets(repo)).toEqual([
      { file: "src/config.ts", line: 2, reason: "possible OpenAI API key" },
    ]);
  });

  it("reports a staged environment file", () => {
    stage(".env", env("APP_TIMEZONE", "America/Chicago"));
    expect(findStagedSecrets(repo)).toEqual([{ file: ".env", reason: "staged environment file" }]);
  });

  it("ignores secrets that are not staged", () => {
    writeFileSync(join(repo, "untracked.txt"), fake.openai);
    stage("clean.txt", "nothing sensitive");
    expect(findStagedSecrets(repo)).toEqual([]);
  });

  it("scans the staged version, not the working copy", () => {
    stage("note.txt", fake.openai);
    writeFileSync(join(repo, "note.txt"), "now clean");
    expect(findStagedSecrets(repo)).toHaveLength(1);
  });

  it("accepts a placeholder-only example file", () => {
    stage(
      ".env.example",
      [env("DISCORD_BOT_TOKEN", ""), env("MYSQL_PASSWORD", "replace-with-local-password")].join(
        "\n",
      ),
    );
    expect(findStagedSecrets(repo)).toEqual([]);
  });
});
