import { afterEach, describe, expect, it } from "vitest";
import { startWorker, type Worker } from "./worker";

const env = { DATABASE_URL: "mysql://epiphany:placeholder-fixture@127.0.0.1:3407/epiphany" };
const config = { databaseUrl: env.DATABASE_URL, timezone: "America/Chicago", healthPort: 0 };

let worker: Worker | undefined;

afterEach(async () => {
  await worker?.stop();
  worker = undefined;
});

describe("worker health server", () => {
  it("serves a healthy report", async () => {
    worker = await startWorker(config, env);
    const response = await fetch(`http://127.0.0.1:${worker.healthPort}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ status: "ok", service: "worker" });
  });

  it("returns 503 when configuration is invalid", async () => {
    worker = await startWorker(config, {});
    const response = await fetch(`http://127.0.0.1:${worker.healthPort}/health`);
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "error" });
  });

  it("returns 404 for unknown paths", async () => {
    worker = await startWorker(config, env);
    const response = await fetch(`http://127.0.0.1:${worker.healthPort}/nope`);
    expect(response.status).toBe(404);
  });

  it("stops listening on shutdown, and stopping twice is safe", async () => {
    worker = await startWorker(config, env);
    const port = worker.healthPort;
    await worker.stop();
    await worker.stop();
    await expect(fetch(`http://127.0.0.1:${port}/health`)).rejects.toThrow();
  });
});
