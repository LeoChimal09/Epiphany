import { Discord, generateCodeVerifier, generateState } from "arctic";
import type { AuthConfig } from "@epiphany/core";

export interface DiscordSignIn {
  userId: string;
  // Best effort: the access token is only needed to read the user ID, then it is revoked.
  revoke: () => Promise<void>;
}

export interface DiscordClient {
  newState: () => string;
  newVerifier: () => string;
  authorizationUrl: (state: string, verifier: string) => URL;
  exchange: (code: string, verifier: string) => Promise<DiscordSignIn>;
}

export const REDIRECT_PATH = "/api/auth/discord/callback";

// Only the `identify` scope: Epiphany needs to know who signed in, nothing else.
// Returns null when Discord credentials are not configured (possible in development bypass mode).
export function createDiscordClient(config: AuthConfig): DiscordClient | null {
  if (!config.discordClientId || !config.discordClientSecret) return null;
  const discord = new Discord(
    config.discordClientId,
    config.discordClientSecret,
    `${config.appUrl}${REDIRECT_PATH}`,
  );

  return {
    newState: generateState,
    newVerifier: generateCodeVerifier,
    authorizationUrl: (state, verifier) =>
      discord.createAuthorizationURL(state, verifier, ["identify"]),
    async exchange(code, verifier) {
      const tokens = await discord.validateAuthorizationCode(code, verifier);
      const accessToken = tokens.accessToken();
      const response = await fetch("https://discord.com/api/users/@me", {
        headers: { Authorization: `Bearer ${accessToken}` },
      });
      if (!response.ok) throw new Error(`Discord user lookup failed (${response.status}).`);
      const user = (await response.json()) as { id?: unknown };
      if (typeof user.id !== "string" || !/^\d{15,25}$/.test(user.id)) {
        throw new Error("Discord returned an unexpected user.");
      }
      return { userId: user.id, revoke: () => discord.revokeToken(accessToken) };
    },
  };
}
