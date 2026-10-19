import { ConfigError, loadWorkerConfig } from "@epiphany/core";
import { startWorker } from "./worker";

const SHUTDOWN_TIMEOUT_MS = 10_000;

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), service: "worker", event, ...fields }),
  );
}

async function main(): Promise<void> {
  let config;
  try {
    config = loadWorkerConfig(process.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      console.error(error.message);
      process.exit(1);
    }
    throw error;
  }

  const worker = await startWorker(config, process.env);
  log("started", { healthPort: worker.healthPort });

  const shutdown = (signal: string) => {
    log("stopping", { signal });
    const timer = setTimeout(() => {
      log("shutdown_timeout");
      process.exit(1);
    }, SHUTDOWN_TIMEOUT_MS);
    timer.unref();
    worker.stop().then(
      () => {
        log("stopped");
        process.exit(0);
      },
      (error: unknown) => {
        log("shutdown_failed", { message: error instanceof Error ? error.message : "unknown" });
        process.exit(1);
      },
    );
  };

  process.once("SIGINT", () => shutdown("SIGINT"));
  process.once("SIGTERM", () => shutdown("SIGTERM"));
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : "Worker failed to start.");
  process.exit(1);
});
