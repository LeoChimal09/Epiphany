import { ConfigError, loadWebConfig, loadWorkerConfig, type Env } from "./config";

export type ServiceName = "web" | "worker";

export interface HealthReport {
  status: "ok" | "error";
  service: ServiceName;
  time: string;
  checks: {
    config: "ok" | "invalid";
    // Database connectivity is not checked until the database goal adds it.
    database: "not_checked";
  };
}

export function checkConfigHealth(
  service: ServiceName,
  env: Env,
  now: Date = new Date(),
): HealthReport {
  let configOk = true;
  try {
    if (service === "web") loadWebConfig(env);
    else loadWorkerConfig(env);
  } catch (error) {
    if (!(error instanceof ConfigError)) throw error;
    configOk = false;
  }

  return {
    status: configOk ? "ok" : "error",
    service,
    time: now.toISOString(),
    checks: { config: configOk ? "ok" : "invalid", database: "not_checked" },
  };
}
