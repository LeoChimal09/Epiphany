import type { Env, WorkerConfig } from "@epiphany/core";
import { startHealthServer } from "./health-server";
import { startDiscordGateway } from "./discord/gateway";

export interface Worker {
  healthPort: number;
  stop: () => Promise<void>;
}

// The Discord bot and reminder scheduler attach here in later goals.
export async function startWorker(config: WorkerConfig, env: Env): Promise<Worker> {
  const health = await startHealthServer(config.healthPort, env);
  const discord = await startDiscordGateway({
    databaseUrl: config.databaseUrl,
    timezone: config.timezone,
    env,
  });
  let stopping: Promise<void> | undefined;

  return {
    healthPort: health.port,
    stop: () => (stopping ??= Promise.all([health.stop(), discord?.stop()]).then(() => undefined)),
  };
}
