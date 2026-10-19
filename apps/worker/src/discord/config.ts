import { ConfigError, type Env } from "@epiphany/core";

export const REQUIRED_DISCORD_INTENTS = [
  "Guilds",
  "GuildMessages",
  "DirectMessages",
  "MessageContent",
] as const;

export interface DiscordBotConfig {
  token: string;
  ownerUserId: string;
  requiredIntents: typeof REQUIRED_DISCORD_INTENTS;
}

// The dashboard and worker share OWNER_DISCORD_USER_ID. An unset bot token keeps the
// current health-only worker usable; no token value is included in validation errors.
export function loadDiscordBotConfig(env: Env): DiscordBotConfig | null {
  const token = env.DISCORD_BOT_TOKEN?.trim() ?? "";
  if (!token) return null;

  const ownerUserId = env.OWNER_DISCORD_USER_ID?.trim() ?? "";
  if (!/^\d{15,25}$/.test(ownerUserId)) {
    throw new ConfigError("Discord bot", [
      "OWNER_DISCORD_USER_ID must be a numeric Discord user ID when DISCORD_BOT_TOKEN is set",
    ]);
  }

  return { token, ownerUserId, requiredIntents: REQUIRED_DISCORD_INTENTS };
}
