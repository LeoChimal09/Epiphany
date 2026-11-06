import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appEnvironment, type AppCommands } from "./start-app";

let fixture: string;
const supervisors = new Set<ChildProcess>();
const moduleUrl = new URL("./start-app.ts", import.meta.url).href;

beforeEach(() => {
  fixture = resolve(".local", `start-app-test-${randomUUID()}`);
  mkdirSync(fixture, { recursive: true });
});

afterEach(async () => {
  for (const child of supervisors) {
    child.kill("SIGTERM");
    await new Promise<void>((done) => child.once("close", () => done()));
  }
  supervisors.clear();
  rmSync(fixture, { recursive: true, force: true });
});

function events(): { name: string; event: string; pid: number }[] {
  try {
    return readFileSync(join(fixture, "events.jsonl"), "utf8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line: string) => JSON.parse(line));
  } catch {
    return [];
  }
}

function command(name: string, behavior = ""): readonly [string, ...string[]] {
  return [
    process.execPath,
    "--input-type=module",
    "-e",
    `import { appendFileSync, readFileSync } from "node:fs";
const name = ${JSON.stringify(name)};
const file = ${JSON.stringify(join(fixture, "events.jsonl"))};
const record = event => appendFileSync(file, JSON.stringify({name,event,pid:process.pid})+"\\n");
record("started");
process.on("SIGTERM", () => { record("SIGTERM"); process.exit(0); });
process.on("SIGINT", () => { record("SIGINT"); process.exit(0); });
${behavior}
`,
  ];
}

function start(commands: AppCommands, shutdownTimeoutMs = 1000) {
  const child = spawn(
    "bun",
    [
      "-e",
      `import { supervise } from ${JSON.stringify(moduleUrl)};
process.exitCode = await supervise(${JSON.stringify(commands)}, {
  cwd: ${JSON.stringify(process.cwd())}, env: process.env, shutdownTimeoutMs: ${shutdownTimeoutMs}
});`,
    ],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  supervisors.add(child);
  let output = "";
  child.stdout.on("data", (chunk: Buffer) => (output += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (output += chunk.toString()));
  const exited = new Promise<number | null>((done) =>
    child.once("close", (code) => {
      supervisors.delete(child);
      done(code);
    }),
  );
  return { child, exited, output: () => output };
}

const migration = () => command("migrate", "setTimeout(() => process.exit(0), 30);");
const idle = () => "setInterval(() => {}, 1000);";

describe("single-service startup configuration", () => {
  it.each([
    "mysql://example.invalid/epiphany",
    ":memory:",
    "file::memory:",
    "file:/data/test.sqlite?mode=memory",
    "file://remote/data/test.sqlite",
    "file:",
  ])("rejects nonpersistent DATABASE_URL %s", (databaseUrl) => {
    expect(() => appEnvironment({ DATABASE_URL: databaseUrl }, fixture)).toThrow(
      "persistent SQLite file",
    );
  });

  it.each([
    { databaseUrl: "", expected: "DATABASE_URL is missing" },
    {
      databaseUrl: "mysql://synthetic-user:synthetic-secret@example.invalid/private-db",
      expected: "remove any old MySQL reference",
    },
    {
      databaseUrl: "file:epiphany.sqlite",
      port: "3001",
      expected: "PORT and WORKER_HEALTH_PORT must differ",
    },
    {
      databaseUrl: pathToFileURL(resolve(".local", "missing-parent", "private-db.sqlite")).href,
      expected: "parent directory does not exist",
    },
  ])("logs an actionable, redacted CLI error: $expected", ({ databaseUrl, port, expected }) => {
    const result = spawnSync("bun", ["scripts/start-app.ts"], {
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        PORT: port ?? "3000",
        WORKER_HEALTH_PORT: "3001",
      },
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain(expected);
    expect(result.stderr).not.toContain("synthetic-secret");
    expect(result.stderr).not.toContain("private-db");
    expect(result.stdout).not.toContain("process_started");
  });

  it("uses a writable local file, production mode and separate configurable ports", () => {
    const env = appEnvironment(
      { DATABASE_URL: "file:epiphany.sqlite", PORT: "8080", WORKER_HEALTH_PORT: "8081" },
      fixture,
    );
    expect(env).toMatchObject({
      DATABASE_URL: pathToFileURL(join(fixture, "epiphany.sqlite")).href,
      NODE_ENV: "production",
      PORT: "8080",
      WORKER_HEALTH_PORT: "8081",
    });
    expect(() =>
      appEnvironment({ DATABASE_URL: "file:epiphany.sqlite", PORT: "3001" }, fixture),
    ).toThrow("must differ");
    expect(() =>
      appEnvironment({ DATABASE_URL: "file:epiphany.sqlite", PORT: "0" }, fixture),
    ).toThrow("PORT");
  });
});

describe("single-service process supervision", () => {
  it("never starts either application after a failed migration", async () => {
    const app = start({
      migrate: command("migrate", "process.exit(2);"),
      web: command("web", idle()),
      worker: command("worker", idle()),
    });
    expect(await app.exited).toBe(1);
    expect(events().map(({ name }) => name)).toEqual(["migrate"]);
  });

  it.each([0, 7])("migrates first and stops the sibling after unexpected exit %s", async (code) => {
    const app = start({
      migrate: migration(),
      web: command(
        "web",
        `setInterval(() => {
  if (readFileSync(file, "utf8").includes('"name":"worker"')) process.exit(${code});
}, 10);`,
      ),
      worker: command("worker", idle()),
    });
    expect(await app.exited).toBe(1);
    expect(events()[0]?.name).toBe("migrate");
    expect(events()).toContainEqual(expect.objectContaining({ name: "worker", event: "SIGTERM" }));
    for (const { pid } of events()) expect(() => process.kill(pid, 0)).toThrow();
  });

  it("forwards shutdown during migration and never starts the applications", async () => {
    const app = start({
      migrate: command("migrate", idle()),
      web: command("web", idle()),
      worker: command("worker", idle()),
    });
    await expect.poll(() => events().length).toBe(1);
    app.child.kill("SIGTERM");
    expect(await app.exited).toBe(0);
    expect(events().map(({ name }) => name)).toEqual(["migrate", "migrate"]);
    expect(events()[1]?.event).toBe("SIGTERM");
    for (const { pid } of events()) expect(() => process.kill(pid, 0)).toThrow();
  });

  it.each(["SIGTERM", "SIGINT"] as const)(
    "forwards %s to both children and waits for exit",
    async (signal) => {
      const app = start({
        migrate: migration(),
        web: command("web", idle()),
        worker: command("worker", idle()),
      });
      await expect.poll(() => events().filter(({ event }) => event === "started").length).toBe(3);
      app.child.kill(signal);
      expect(await app.exited).toBe(0);
      expect(
        events()
          .filter(({ event }) => event === signal)
          .map(({ name }) => name)
          .sort(),
      ).toEqual(["web", "worker"]);
      for (const { pid } of events()) expect(() => process.kill(pid, 0)).toThrow();
    },
  );

  it("bounds shutdown when a child ignores SIGTERM without leaving it orphaned", async () => {
    const app = start(
      {
        migrate: migration(),
        web: command("web", idle()),
        worker: command(
          "worker",
          `process.removeAllListeners("SIGTERM"); process.on("SIGTERM", () => {}); ${idle()}`,
        ),
      },
      100,
    );
    await expect.poll(() => events().filter(({ event }) => event === "started").length).toBe(3);
    app.child.kill("SIGTERM");
    expect(await app.exited).toBe(1);
    expect(app.output()).toContain("shutdown_timeout");
    for (const { pid } of events()) expect(() => process.kill(pid, 0)).toThrow();
  });

  it("stops a running sibling if an executable cannot start", async () => {
    const app = start({
      migrate: migration(),
      web: command("web", idle()),
      worker: [join(fixture, "missing-executable")],
    });
    expect(await app.exited).toBe(1);
    expect(app.output()).toContain("process_start_failed");
    for (const { pid } of events()) expect(() => process.kill(pid, 0)).toThrow();
  });
});
