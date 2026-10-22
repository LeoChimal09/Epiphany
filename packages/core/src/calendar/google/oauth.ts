import { GoogleInvalidGrantError, GoogleTokenError } from "./errors";

// The subset of `fetch` the calendar code uses, so tests can inject a fake.
export type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_REVOKE_URL = "https://oauth2.googleapis.com/revoke";

// `calendar.readonly` reads every calendar the owner picks. `calendar.app.created` lets Epiphany
// create and write only the secondary calendars it created itself, so it cannot edit the owner's
// own calendars even if a bug tried to.
export const SCOPE_READ = "https://www.googleapis.com/auth/calendar.readonly";
export const SCOPE_WRITE = "https://www.googleapis.com/auth/calendar.app.created";
export const SCOPE_OPENID = "openid";
export const SCOPE_EMAIL = "email";

export type CalendarAccessMode = "read" | "readwrite";

export function scopesFor(mode: CalendarAccessMode): string[] {
  return mode === "read"
    ? [SCOPE_OPENID, SCOPE_EMAIL, SCOPE_READ]
    : [SCOPE_OPENID, SCOPE_EMAIL, SCOPE_READ, SCOPE_WRITE];
}

export const canWrite = (scopes: string): boolean => scopes.split(/\s+/).includes(SCOPE_WRITE);

export interface RefreshedToken {
  accessToken: string;
  expiresAt: Date;
}

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  timeoutMs?: number;
  now?: () => Date;
}

async function errorCode(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { error?: unknown };
    return typeof body.error === "string" ? body.error : null;
  } catch {
    return null;
  }
}

// Exchanges a refresh token for a new access token. `invalid_grant` means the owner revoked access
// or the grant expired (GoogleInvalidGrantError); anything else is treated as possibly temporary.
export async function refreshAccessToken(
  credentials: OAuthClientCredentials,
  refreshToken: string,
): Promise<RefreshedToken> {
  const doFetch = credentials.fetch ?? fetch;
  let response: Response;
  try {
    response = await doFetch(GOOGLE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
      }),
      signal: AbortSignal.timeout(credentials.timeoutMs ?? 15_000),
    });
  } catch {
    throw new GoogleTokenError("Could not reach Google to refresh the calendar authorization.");
  }

  if (!response.ok) {
    const code = await errorCode(response);
    if (code === "invalid_grant") throw new GoogleInvalidGrantError();
    throw new GoogleTokenError(
      `Google could not refresh the calendar authorization (${response.status}${code ? `, ${code}` : ""}).`,
    );
  }

  let body: { access_token?: unknown; expires_in?: unknown };
  try {
    body = (await response.json()) as typeof body;
  } catch {
    throw new GoogleTokenError("Google returned an unreadable token response.");
  }
  if (typeof body.access_token !== "string" || body.access_token === "") {
    throw new GoogleTokenError("Google returned no access token.");
  }
  const seconds =
    typeof body.expires_in === "number" && body.expires_in > 0 ? body.expires_in : 3600;
  return {
    accessToken: body.access_token,
    expiresAt: new Date((credentials.now?.() ?? new Date()).getTime() + seconds * 1000),
  };
}

// Revokes a token at Google. Best effort: failures are reported to the caller, which still
// deletes the stored tokens.
export async function revokeToken(
  credentials: Pick<OAuthClientCredentials, "fetch" | "timeoutMs">,
  token: string,
): Promise<boolean> {
  const doFetch = credentials.fetch ?? fetch;
  try {
    const response = await doFetch(GOOGLE_REVOKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ token }),
      signal: AbortSignal.timeout(credentials.timeoutMs ?? 10_000),
    });
    // 400 invalid_token means it was already revoked or expired: the goal (no access) is met.
    return response.ok || response.status === 400;
  } catch {
    return false;
  }
}
