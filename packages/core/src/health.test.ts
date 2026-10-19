import { describe, expect, it } from "vitest";
import { checkConfigHealth } from "./health";

const now = new Date("2026-10-13T12:00:00.000Z");

describe("checkConfigHealth", () => {
  it("reports ok with valid configuration", () => {
    const report = checkConfigHealth(
      "web",
      { DATABASE_URL: "mysql://epiphany:placeholder-fixture@127.0.0.1:3407/epiphany" },
      now,
    );
    expect(report).toEqual({
      status: "ok",
      service: "web",
      time: "2026-10-13T12:00:00.000Z",
      checks: { config: "ok", database: "not_checked" },
    });
  });

  it("reports an error without leaking details when configuration is invalid", () => {
    const report = checkConfigHealth("worker", { DATABASE_URL: "not-a-url" }, now);
    expect(report.status).toBe("error");
    expect(report.checks.config).toBe("invalid");
    expect(JSON.stringify(report)).not.toContain("not-a-url");
  });
});
