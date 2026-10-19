import { describe, expect, it } from "vitest";
import { ConfigError } from "@epiphany/core";
import { loadDiscordBotConfig, REQUIRED_DISCORD_INTENTS } from "./config";

const SYNTHETIC_TOKEN = "placeholder-test-discord-token";
const OWNER_ID = "100000000000000001";

describe("Discord bot configuration", () => {
  it("keeps the health-only worker usable when the bot token is not configured", () => {
    expect(loadDiscordBotConfig({ OWNER_DISCORD_USER_ID: OWNER_ID })).toBeNull();
  });

  it("requires a valid owner ID when a bot token is enabled", () => {
    expect(() =>
      loadDiscordBotConfig({ DISCORD_BOT_TOKEN: "placeholder-test-discord-token" }),
    ).toThrow(ConfigError);
    expect(() =>
      loadDiscordBotConfig({
        DISCORD_BOT_TOKEN: "placeholder-test-discord-token",
        OWNER_DISCORD_USER_ID: "not-an-id",
      }),
    ).toThrow(ConfigError);
  });

  it("never includes a configured token in validation errors", () => {
    try {
      loadDiscordBotConfig({ DISCORD_BOT_TOKEN: "placeholder-test-discord-token" });
      throw new Error("Expected invalid bot configuration");
    } catch (error) {
      expect(error).toBeInstanceOf(ConfigError);
      expect((error as Error).message).not.toContain(SYNTHETIC_TOKEN);
    }
  });

  it("returns the owner identity and required gateway intents for valid configuration", () => {
    expect(
      loadDiscordBotConfig({
        DISCORD_BOT_TOKEN: "placeholder-test-discord-token",
        OWNER_DISCORD_USER_ID: OWNER_ID,
      }),
    ).toEqual({
      token: SYNTHETIC_TOKEN,
      ownerUserId: OWNER_ID,
      requiredIntents: REQUIRED_DISCORD_INTENTS,
    });
  });
});
