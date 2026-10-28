import { ConfigError, googleCalendarRequested, loadGoogleConfig, type Env } from "@epiphany/core";
import { connectDatabase } from "@epiphany/core/db";
import { syncAllAccounts, type CalendarRuntime, type FetchLike } from "@epiphany/core/calendar";

export interface CalendarRunner {
  // Runs one pass now (used by tests); a pass already in progress is awaited, never doubled.
  tick: () => Promise<void>;
  stop: () => Promise<void>;
}

export interface CalendarRunnerOptions {
  databaseUrl: string;
  env: Env;
  // How often to look for due work. Each calendar is read at most every `syncIntervalMs`.
  tickMs?: number;
  syncIntervalMs?: number;
  fetch?: FetchLike;
  log?: (event: string, fields?: Record<string, unknown>) => void;
}

const defaultLog = (event: string, fields: Record<string, unknown> = {}) =>
  console.log(
    JSON.stringify({ time: new Date().toISOString(), service: "worker", event, ...fields }),
  );

// Keeps Google Calendar in sync: reads the owner's selected calendars and mirrors work blocks to
// the Epiphany calendar. Does nothing when Google is not configured, and a Google outage is
// recorded on the calendar (visible in the dashboard) without affecting anything else the worker
// does.
export function startCalendarRunner(options: CalendarRunnerOptions): CalendarRunner | null {
  const log = options.log ?? defaultLog;
  if (!googleCalendarRequested(options.env)) return null;

  let google;
  try {
    google = loadGoogleConfig(options.env);
  } catch (error) {
    if (error instanceof ConfigError) {
      log("calendar_sync_disabled", { reason: error.issues.join("; ") });
      return null;
    }
    throw error;
  }

  const handle = connectDatabase(options.databaseUrl, 2);
  const runtime: CalendarRuntime = {
    db: handle.db,
    tokenKey: google.tokenKey,
    clientId: google.clientId,
    clientSecret: google.clientSecret,
    fetch: options.fetch,
  };
  const tickMs = options.tickMs ?? 15_000;
  const intervalMs = options.syncIntervalMs ?? 5 * 60_000;

  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let stopped = false;

  const run = async () => {
    try {
      const reports = await syncAllAccounts(runtime, { intervalMs });
      for (const report of reports) {
        if (report.status === "skipped") continue;
        const changed =
          report.imported + report.updated + report.canceled + report.conflicts > 0 ||
          report.pushed.created + report.pushed.updated + report.pushed.removed > 0;
        if (changed || report.status !== "ok") {
          log("calendar_sync", {
            status: report.status,
            imported: report.imported,
            updated: report.updated,
            canceled: report.canceled,
            pushed: report.pushed,
            conflicts: report.conflicts,
            errors: report.errors.length,
          });
        }
      }
    } catch (error) {
      log("calendar_sync_failed", { message: error instanceof Error ? error.name : "unknown" });
    }
  };

  const tick = () => (running ??= run().finally(() => (running = undefined)));
  const schedule = () => {
    if (stopped) return;
    timer = setTimeout(() => {
      void tick().finally(schedule);
    }, tickMs);
    timer.unref();
  };
  // First pass shortly after start-up, then on the interval.
  timer = setTimeout(() => {
    void tick().finally(schedule);
  }, 5_000);
  timer.unref();

  return {
    tick,
    async stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      await running;
      await handle.close();
    },
  };
}
