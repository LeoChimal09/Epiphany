import { decodeIdToken, Google, generateCodeVerifier, generateState } from "arctic";
import type { GoogleConfig } from "@epiphany/core";
import { scopesFor, type CalendarAccessMode, type GoogleTokens } from "@epiphany/core/calendar";

export const GOOGLE_REDIRECT_PATH = "/api/google/callback";

export interface GoogleOAuthClient {
  newState: () => string;
  newVerifier: () => string;
  authorizationUrl: (state: string, verifier: string, mode: CalendarAccessMode) => URL;
  exchange: (code: string, verifier: string) => Promise<GoogleTokens>;
}

// Authorization-code flow with PKCE and `state`. Offline access plus a forced consent screen make
// Google issue a refresh token every time, so a reconnect can always replace a dead one.
export function createGoogleOAuthClient(config: GoogleConfig, appUrl: string): GoogleOAuthClient {
  const google = new Google(
    config.clientId,
    config.clientSecret,
    `${appUrl}${GOOGLE_REDIRECT_PATH}`,
  );
  return {
    newState: generateState,
    newVerifier: generateCodeVerifier,
    authorizationUrl(state, verifier, mode) {
      const url = google.createAuthorizationURL(state, verifier, scopesFor(mode));
      url.searchParams.set("access_type", "offline");
      url.searchParams.set("prompt", "consent");
      return url;
    },
    async exchange(code, verifier) {
      const tokens = await google.validateAuthorizationCode(code, verifier);
      const claims = decodeIdToken(tokens.idToken()) as { sub?: unknown; email?: unknown };
      if (typeof claims.sub !== "string" || claims.sub === "") {
        throw new Error("Google returned no account identifier.");
      }
      return {
        providerAccountId: claims.sub,
        email: typeof claims.email === "string" ? claims.email : null,
        scopes: tokens.hasScopes() ? tokens.scopes() : [],
        accessToken: tokens.accessToken(),
        refreshToken: tokens.hasRefreshToken() ? tokens.refreshToken() : null,
        accessTokenExpiresAt: tokens.accessTokenExpiresAt(),
      };
    },
  };
}
