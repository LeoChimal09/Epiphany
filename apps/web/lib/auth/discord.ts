import { Discord, generateCodeVerifier, generateState } from "arctic";
import type { AuthConfig } from "@epiphany/core";
import { cleanAvatarHash, cleanDisplayName } from "@epiphany/core/services";

export interface DiscordSignIn {
  userId: string;
  // Display details from the same identify response, already validated. The name is Discord's
  // global display name, then the username; null when Discord sent neither.
  displayName: string | null;
  avatarHash: string | null;
  // Best effort: the access token is only needed to read the identity, then it is revoked.
  revoke: () => Promise<void>;
}

export interface DiscordClient {
  newState: () => string;
  newVerifier: () => string;
  authorizationUrl: (state: string, verifier: string) => URL;
  exchange: (code: string, verifier: string) => Promise<DiscordSignIn>;
}

export const REDIRECT_PATH = "/api/auth/discord/callback";

// Only the `identify` scope: Epiphany needs to know who signed in (id, name, avatar), nothing else.
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
      const user = (await response.json()) as {
        id?: unknown;
        global_name?: unknown;
        username?: unknown;
        avatar?: unknown;
      };
      if (typeof user.id !== "string" || !/^\d{15,25}$/.test(user.id)) {
        throw new Error("Discord returned an unexpected user.");
      }
      const name = cleanDisplayName(user.global_name ?? user.username, "");
      return {
        userId: user.id,
        displayName: name || null,
        avatarHash: cleanAvatarHash(user.avatar),
        revoke: () => discord.revokeToken(accessToken),
      };
    },
  };
}
