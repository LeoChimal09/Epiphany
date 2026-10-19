import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadAuthConfig,
  loadDatabaseToolingConfig,
  loadWebConfig,
  loadWorkerConfig,
} from "./config";

const databaseUrl = "mysql://epiphany:placeholder-fixture@127.0.0.1:3407/epiphany";

describe("loadWebConfig", () => {
  it("returns defaults for optional values", () => {
    expect(loadWebConfig({ DATABASE_URL: databaseUrl })).toEqual({
      databaseUrl,
      timezone: "America/Chicago",
    });
  });

  it("lists every missing required variable by name", () => {
    expect.assertions(3);
    try {
      loadWebConfig({});
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      const message = (error as ConfigError).message;
      expect(message).toContain("DATABASE_URL is required");
      expect(message).toContain(".env.example");
    }
  });

  it("treats an empty value as missing", () => {
    expect(() => loadWebConfig({ DATABASE_URL: "" })).toThrow(/DATABASE_URL is required/);
  });

  it("rejects a non-mysql URL without echoing it", () => {
    const secret = "synthetic-not-a-real-password";
    expect.assertions(2);
    try {
      loadWebConfig({ DATABASE_URL: `postgres://user:${secret}@host/db` });
    } catch (error) {
      const message = (error as ConfigError).message;
      expect(message).toContain("DATABASE_URL must be a mysql:// URL");
      expect(message).not.toContain(secret);
    }
  });

  it("rejects an unknown timezone", () => {
    expect(() =>
      loadWebConfig({ DATABASE_URL: databaseUrl, APP_TIMEZONE: "Mars/Olympus" }),
    ).toThrow(/APP_TIMEZONE must be an IANA timezone/);
  });
});

describe("loadWorkerConfig", () => {
  it("defaults the health port", () => {
    expect(loadWorkerConfig({ DATABASE_URL: databaseUrl }).healthPort).toBe(3001);
  });

  it("parses a configured health port", () => {
    expect(
      loadWorkerConfig({ DATABASE_URL: databaseUrl, WORKER_HEALTH_PORT: "4010" }).healthPort,
    ).toBe(4010);
  });

  it.each(["abc", "0", "70000", "12.5"])("rejects health port %s", (port) => {
    expect(() => loadWorkerConfig({ DATABASE_URL: databaseUrl, WORKER_HEALTH_PORT: port })).toThrow(
      /WORKER_HEALTH_PORT must be a whole number/,
    );
  });
});

describe("loadDatabaseToolingConfig", () => {
  it("requires only DATABASE_URL and names itself in errors", () => {
    expect(loadDatabaseToolingConfig({ DATABASE_URL: databaseUrl })).toEqual({ databaseUrl });
    expect(() => loadDatabaseToolingConfig({})).toThrow(
      /Invalid database tooling configuration:\n {2}- DATABASE_URL is required/,
    );
  });
});

describe("loadAuthConfig", () => {
  const valid = {
    DISCORD_CLIENT_ID: "123456789012345678",
    DISCORD_CLIENT_SECRET: "placeholder-client-secret",
    OWNER_DISCORD_USER_ID: "100000000000000001",
    APP_URL: "http://localhost:3000/",
  };

  it("parses valid settings and normalizes the URL", () => {
    expect(loadAuthConfig(valid)).toEqual({
      discordClientId: valid.DISCORD_CLIENT_ID,
      discordClientSecret: valid.DISCORD_CLIENT_SECRET,
      ownerDiscordUserId: valid.OWNER_DISCORD_USER_ID,
      appUrl: "http://localhost:3000",
      secureCookies: false,
      timezone: "America/Chicago",
      devBypass: false,
    });
    expect(loadAuthConfig({ ...valid, APP_URL: "https://epi.example.com" }).secureCookies).toBe(
      true,
    );
  });

  it("names every missing setting with how to find it", () => {
    expect.assertions(4);
    try {
      loadAuthConfig({});
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("Invalid dashboard sign-in configuration");
      expect(message).toContain("DISCORD_CLIENT_ID is required");
      expect(message).toContain("OWNER_DISCORD_USER_ID is required");
      expect(message).toContain("APP_URL is required");
    }
  });

  it("rejects malformed values without echoing them", () => {
    const secret = "not-a-snowflake-xyz";
    expect.assertions(3);
    try {
      loadAuthConfig({ ...valid, OWNER_DISCORD_USER_ID: secret, APP_URL: "ftp://x" });
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toContain("OWNER_DISCORD_USER_ID must be a numeric Discord user ID");
      expect(message).toContain("APP_URL must be an http(s) URL");
      expect(message).not.toContain(secret);
    }
  });
});

describe("loadAuthConfig with ENV_BYPASS", () => {
  const dev = { ENV_BYPASS: "dev", NODE_ENV: "development" };
  const reasons = (env: Record<string, string>) => {
    try {
      loadAuthConfig(env);
      return null;
    } catch (error) {
      return (error as Error).message;
    }
  };

  it("is off when unset or empty, and then Discord settings are required as before", () => {
    for (const bypass of [undefined, "", "  "]) {
      const env = {
        NODE_ENV: "development",
        ...(bypass === undefined ? {} : { ENV_BYPASS: bypass }),
      };
      expect(reasons(env)).toContain("DISCORD_CLIENT_ID is required");
    }
  });

  it("turns on in development without any Discord settings, defaulting to localhost", () => {
    expect(loadAuthConfig(dev)).toEqual({
      discordClientId: null,
      discordClientSecret: null,
      ownerDiscordUserId: null,
      appUrl: "http://localhost:3000",
      secureCookies: false,
      timezone: "America/Chicago",
      devBypass: true,
    });
  });

  it("keeps Discord settings when present, so both sign-in methods can coexist", () => {
    const config = loadAuthConfig({
      ...dev,
      DISCORD_CLIENT_ID: "123456789012345678",
      DISCORD_CLIENT_SECRET: "placeholder-client-secret",
      OWNER_DISCORD_USER_ID: "100000000000000001",
      APP_URL: "http://127.0.0.1:3010",
    });
    expect(config).toMatchObject({
      discordClientId: "123456789012345678",
      ownerDiscordUserId: "100000000000000001",
      appUrl: "http://127.0.0.1:3010",
      devBypass: true,
    });
  });

  it("also works under test", () => {
    expect(loadAuthConfig({ ENV_BYPASS: "dev", NODE_ENV: "test" }).devBypass).toBe(true);
  });

  it.each([
    ["production", { NODE_ENV: "production" }],
    ["an unset NODE_ENV", {}],
    ["an unknown NODE_ENV", { NODE_ENV: "staging" }],
  ])("is refused, not ignored, with %s", (_name, extra) => {
    const message = reasons({ ENV_BYPASS: "dev", ...extra });
    expect(message).toContain("ENV_BYPASS=dev is only allowed in development");
  });

  it.each([
    "https://epi.example.com",
    "http://10.1.2.3:3000",
    "http://localhost.evil.example",
    "http://192.168.0.5",
  ])("is refused when APP_URL is %s", (appUrl) => {
    expect(reasons({ ...dev, APP_URL: appUrl })).toContain("requires APP_URL to be localhost");
  });

  it.each(["http://localhost:3000", "http://127.0.0.1:3000", "http://[::1]:3000"])(
    "accepts loopback APP_URL %s",
    (appUrl) => {
      expect(loadAuthConfig({ ...dev, APP_URL: appUrl }).devBypass).toBe(true);
    },
  );

  it.each(["prod", "true", "1", "DEV", "Dev", "yes", "development"])(
    "rejects ENV_BYPASS=%s without echoing it",
    (value) => {
      const message = reasons({ ...dev, ENV_BYPASS: value });
      expect(message).toContain('ENV_BYPASS must be "dev" or unset');
      expect(message).not.toContain(`=${value}`);
    },
  );

  it("still validates the optional settings it is given", () => {
    expect(reasons({ ...dev, OWNER_DISCORD_USER_ID: "nope" })).toContain("OWNER_DISCORD_USER_ID");
    expect(reasons({ ...dev, APP_TIMEZONE: "Mars/Base" })).toContain("APP_TIMEZONE");
    expect(reasons({ ...dev, APP_URL: "not a url" })).toContain("APP_URL");
  });
});
