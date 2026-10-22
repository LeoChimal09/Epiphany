import { afterEach, describe, expect, it, vi } from "vitest";
import { startCalendarRunner, type CalendarRunner } from "./calendar-runner";

const databaseUrl = "mysql://epiphany:placeholder-fixture@127.0.0.1:3407/epiphany";
const key = Buffer.alloc(32, 3).toString("base64");

let runner: CalendarRunner | null = null;
afterEach(async () => {
  await runner?.stop();
  runner = null;
});

describe("calendar runner", () => {
  it("does nothing when Google Calendar is not configured", () => {
    const log = vi.fn();
    runner = startCalendarRunner({ databaseUrl, env: { DATABASE_URL: databaseUrl }, log });
    expect(runner).toBeNull();
    expect(log).not.toHaveBeenCalled();
  });

  it("stays off, and says why without printing values, when configuration is incomplete", () => {
    const log = vi.fn();
    runner = startCalendarRunner({
      databaseUrl,
      env: { GOOGLE_CLIENT_ID: "placeholder-id", TOKEN_ENCRYPTION_KEY: "short" },
      log,
    });
    expect(runner).toBeNull();
    expect(log).toHaveBeenCalledWith("calendar_sync_disabled", expect.anything());
    const reason = JSON.stringify(log.mock.calls);
    expect(reason).toContain("GOOGLE_CLIENT_SECRET");
    expect(reason).not.toContain("placeholder-id");
  });

  it("survives a database outage: the failure is logged and the runner keeps working", async () => {
    const log = vi.fn();
    runner = startCalendarRunner({
      databaseUrl,
      env: {
        GOOGLE_CLIENT_ID: "placeholder-id",
        GOOGLE_CLIENT_SECRET: "placeholder-secret",
        TOKEN_ENCRYPTION_KEY: key,
      },
      tickMs: 3_600_000,
      log,
    });
    expect(runner).not.toBeNull();
    await runner!.tick();
    await runner!.tick();
    expect(log.mock.calls.filter(([event]) => event === "calendar_sync_failed")).toHaveLength(2);
  });
});
