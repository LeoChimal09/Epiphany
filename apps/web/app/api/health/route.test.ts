import { afterEach, describe, expect, it, vi } from "vitest";
import { GET } from "./route";

afterEach(() => vi.unstubAllEnvs());

describe("GET /api/health", () => {
  it("returns 200 with valid configuration", async () => {
    vi.stubEnv("DATABASE_URL", "mysql://epiphany:placeholder-fixture@127.0.0.1:3407/epiphany");
    const response = GET();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ status: "ok", service: "web" });
  });

  it("returns 503 when required configuration is missing", async () => {
    vi.stubEnv("DATABASE_URL", "");
    const response = GET();
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({ status: "error", checks: { config: "invalid" } });
  });
});
