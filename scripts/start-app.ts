import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { accessSync, constants } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Command = readonly [string, ...string[]];

export interface AppCommands {
  migrate: Command;
  web: Command;
  worker: Command;
}

function port(value: string | undefined, fallback: number, name: string): number {
  const parsed = Number(value || fallback);
  if (!Number.isInteger(parsed) || parsed < 1 || parsed > 65535) {
    throw new Error(`${name} must be a whole number between 1 and 65535.`);
  }
  return parsed;
}

export function appEnvironment(env: NodeJS.ProcessEnv, cwd: string): NodeJS.ProcessEnv {
  const url = env.DATABASE_URL?.trim() ?? "";
  let path: string;
  try {
    if (!url.startsWith("file:") || /[?#]/.test(url)) throw new Error();
    path = url.startsWith("file://") ? fileURLToPath(url) : decodeURIComponent(url.slice(5));
    if (!path || path.includes(":memory:") || path.includes("\0")) throw new Error();
    if ([".", "..", "/"].includes(path)) throw new Error();
  } catch {
    throw new Error(
      "DATABASE_URL must name a persistent SQLite file (Railway: file:/data/epiphany.sqlite); memory and remote databases are not supported.",
    );
  }
  const webPort = port(env.PORT, 3000, "PORT");
  const workerPort = port(env.WORKER_HEALTH_PORT, 3001, "WORKER_HEALTH_PORT");
  if (webPort === workerPort) throw new Error("PORT and WORKER_HEALTH_PORT must differ.");
  const file = resolve(cwd, path);
  accessSync(dirname(file), constants.W_OK);
  return {
    ...env,
    DATABASE_URL: pathToFileURL(file).href,
    NODE_ENV: "production",
    PORT: String(webPort),
    WORKER_HEALTH_PORT: String(workerPort),
  };
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(JSON.stringify({ service: "app", event, ...fields }));
}

export async function supervise(
  commands: AppCommands,
  options: { cwd: string; env: NodeJS.ProcessEnv; shutdownTimeoutMs?: number },
): Promise<number> {
  const children = new Set<ChildProcess>();
  const exits: Promise<number>[] = [];
  let stopping = false;
  let result = 1;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let finish!: () => void;
  const stopped = new Promise<void>((done) => {
    finish = done;
  });

  const stop = (code: number, signal: NodeJS.Signals = "SIGTERM") => {
    if (stopping) return;
    stopping = true;
    result = code;
    for (const child of children) child.kill(signal);
    timer = setTimeout(() => {
      log("shutdown_timeout");
      result = 1;
      for (const child of children) child.kill("SIGKILL");
    }, options.shutdownTimeoutMs ?? 15_000);
    finish();
  };
  const onTerm = () => stop(0, "SIGTERM");
  const onInt = () => stop(0, "SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);

  const launch = (name: keyof AppCommands): Promise<number> => {
    const [executable, ...args] = commands[name];
    const child = spawn(executable, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: "inherit",
      // Direct children, without a shell or detached process group, stay supervised.
      detached: false,
    });
    children.add(child);
    child.once("error", () => {
      log("process_start_failed", { process: name });
      stop(1);
    });
    child.once("spawn", () => log("process_started", { process: name }));
    const exited = new Promise<number>((done) => {
      child.once("close", (code, signal) => {
        children.delete(child);
        log("process_exited", { process: name, code, signal });
        if (!stopping && (name !== "migrate" || code !== 0)) stop(1);
        done(code ?? 1);
      });
    });
    exits.push(exited);
    return exited;
  };

  try {
    const migrationCode = await launch("migrate");
    if (migrationCode === 0 && !stopping) {
      log("migrations_complete");
      void launch("web");
      void launch("worker");
    }
    await stopped;
    await Promise.all(exits);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
    process.off("SIGTERM", onTerm);
    process.off("SIGINT", onInt);
  }
}

async function main(): Promise<void> {
  const cwd = fileURLToPath(new URL("..", import.meta.url));
  const env = appEnvironment(process.env, cwd);
  if (Bun.version !== "1.3.14") throw new Error("The app supervisor requires Bun 1.3.14.");
  const nodeVersion = spawnSync("node", ["--version"], { encoding: "utf8" });
  const nodeMajor = Number(nodeVersion.stdout?.trim().match(/^v(\d+)\./)?.[1]);
  if (nodeVersion.status !== 0 || !(nodeMajor >= 24)) {
    throw new Error("Next.js requires Node 24 or newer on PATH.");
  }
  const require = createRequire(import.meta.url);
  process.exitCode = await supervise(
    {
      migrate: [process.execPath, "packages/core/src/db/cli.ts", "migrate"],
      web: [
        "node",
        require.resolve("next/dist/bin/next"),
        "start",
        "apps/web",
        "-H",
        "0.0.0.0",
        "-p",
        env.PORT!,
      ],
      worker: [process.execPath, "apps/worker/src/index.ts"],
    },
    { cwd, env },
  );
}

if (import.meta.main) {
  main().catch(() => {
    // Configuration paths and provider errors can contain private values.
    console.error(
      "App startup failed. Require Bun 1.3.14, Node 24+, a writable file DATABASE_URL parent directory, and distinct PORT/WORKER_HEALTH_PORT. See docs/operations.md.",
    );
    process.exitCode = 1;
  });
}
