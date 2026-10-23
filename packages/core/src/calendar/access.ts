import { and, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import type { Actor } from "../db/domain";
import { calendarAccounts } from "../db/schema";
import { decryptToken, encryptToken, tokenContext } from "./crypto";
import { GoogleInvalidGrantError, GoogleTokenError } from "./google/errors";
import { refreshAccessToken, revokeToken, type FetchLike } from "./google/oauth";
import { CalendarError, saveConnectedAccount, wipeAccounts } from "./store";

// What the calendar code needs from its environment. `fetch`, `now`, `sleep`, and `random` are
// injectable so every Google interaction can be tested offline.
export interface CalendarRuntime {
  db: Database;
  tokenKey: Buffer;
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
  now?: () => Date;
  sleep?: (ms: number) => Promise<void>;
  random?: () => number;
}

const REFRESH_MARGIN_MS = 60_000;

export const runtimeNow = (runtime: Pick<CalendarRuntime, "now">) => runtime.now?.() ?? new Date();

export interface GoogleTokens {
  providerAccountId: string;
  email: string | null;
  scopes: string[];
  accessToken: string;
  refreshToken: string | null;
  accessTokenExpiresAt: Date;
}

// Stores a new connection: tokens are encrypted before they reach the database.
export async function connectAccount(
  runtime: Pick<CalendarRuntime, "db" | "tokenKey">,
  actor: Actor,
  tokens: GoogleTokens,
): Promise<string> {
  if (!tokens.refreshToken) {
    throw new CalendarError(
      "no_refresh_token",
      "Google did not provide offline access. Remove Epiphany at myaccount.google.com/permissions and connect again.",
    );
  }
  const refreshToken = tokens.refreshToken;
  return saveConnectedAccount(runtime.db, actor, {
    provider: "google",
    providerAccountId: tokens.providerAccountId,
    email: tokens.email,
    scopes: tokens.scopes.join(" "),
    accessTokenExpiresAt: tokens.accessTokenExpiresAt,
    encrypt: (accountId) => ({
      accessTokenEnc: encryptToken(
        runtime.tokenKey,
        tokenContext(accountId, "access"),
        tokens.accessToken,
      ),
      refreshTokenEnc: encryptToken(
        runtime.tokenKey,
        tokenContext(accountId, "refresh"),
        refreshToken,
      ),
    }),
  });
}

// The account can no longer be used until the owner connects again. The useless tokens are wiped
// and the reason is stored so the dashboard shows it (never silent).
export async function markNeedsReauth(
  runtime: Pick<CalendarRuntime, "db" | "now">,
  accountId: string,
  reason: string,
): Promise<void> {
  await runtime.db
    .update(calendarAccounts)
    .set({
      status: "needs_reauth",
      accessTokenEnc: null,
      refreshTokenEnc: null,
      accessTokenExpiresAt: null,
      lastError: reason.slice(0, 300),
    })
    .where(and(eq(calendarAccounts.id, accountId), eq(calendarAccounts.status, "connected")));
}

// Returns a usable access token for the account, refreshing it when it is about to expire. The
// account row is re-read on every call, so disconnecting (or a revocation noticed elsewhere) stops
// all further Google calls immediately, even in the middle of a sync.
export async function getAccessToken(
  runtime: CalendarRuntime,
  accountId: string,
  options: { forceRefresh?: boolean } = {},
): Promise<string> {
  const [account] = await runtime.db
    .select()
    .from(calendarAccounts)
    .where(eq(calendarAccounts.id, accountId));
  if (!account || account.status === "revoked") {
    throw new CalendarError("not_connected", "Google Calendar is not connected.");
  }
  if (account.status === "needs_reauth") {
    throw new CalendarError("needs_reauth", "Google Calendar needs to be connected again.");
  }
  if (!account.accessTokenEnc || !account.refreshTokenEnc) {
    throw new CalendarError("not_connected", "Google Calendar is not connected.");
  }

  const now = runtimeNow(runtime);
  const valid =
    !options.forceRefresh &&
    account.accessTokenExpiresAt !== null &&
    account.accessTokenExpiresAt.getTime() - now.getTime() > REFRESH_MARGIN_MS;
  if (valid) {
    return decryptToken(
      runtime.tokenKey,
      tokenContext(accountId, "access"),
      account.accessTokenEnc,
    );
  }

  const refreshToken = decryptToken(
    runtime.tokenKey,
    tokenContext(accountId, "refresh"),
    account.refreshTokenEnc,
  );
  try {
    const fresh = await refreshAccessToken(
      {
        clientId: runtime.clientId,
        clientSecret: runtime.clientSecret,
        fetch: runtime.fetch,
        now: runtime.now,
      },
      refreshToken,
    );
    // Only write if the account is still connected, so a disconnect that happened during the
    // refresh is not undone by saving a fresh token.
    await runtime.db
      .update(calendarAccounts)
      .set({
        accessTokenEnc: encryptToken(
          runtime.tokenKey,
          tokenContext(accountId, "access"),
          fresh.accessToken,
        ),
        accessTokenExpiresAt: fresh.expiresAt,
        lastError: null,
      })
      .where(and(eq(calendarAccounts.id, accountId), eq(calendarAccounts.status, "connected")));
    const [still] = await runtime.db
      .select({ status: calendarAccounts.status })
      .from(calendarAccounts)
      .where(eq(calendarAccounts.id, accountId));
    if (still?.status !== "connected") {
      throw new CalendarError("not_connected", "Google Calendar is not connected.");
    }
    return fresh.accessToken;
  } catch (error) {
    if (error instanceof GoogleInvalidGrantError) {
      await markNeedsReauth(
        runtime,
        accountId,
        "Google rejected the saved authorization. Connect Google Calendar again.",
      );
      throw new CalendarError("needs_reauth", "Google Calendar needs to be connected again.");
    }
    throw error;
  }
}

export { GoogleTokenError };

// Disconnects every Google account of the owner: access stops first (tokens deleted, account
// revoked, imported events canceled), then the refresh token is revoked at Google. A revocation
// failure is reported but does not undo the local disconnect; the owner can also remove Epiphany
// at myaccount.google.com/permissions.
export async function disconnectAccounts(
  runtime: Pick<CalendarRuntime, "db" | "tokenKey" | "fetch">,
  actor: Actor,
): Promise<{ disconnected: number; revokedAtGoogle: boolean }> {
  const wiped = await wipeAccounts(runtime.db, actor);
  let revokedAtGoogle = true;
  for (const account of wiped) {
    const enc = account.refreshTokenEnc ?? account.accessTokenEnc;
    if (!enc) continue;
    const kind = account.refreshTokenEnc ? "refresh" : "access";
    let token: string;
    try {
      token = decryptToken(runtime.tokenKey, tokenContext(account.id, kind), enc);
    } catch {
      revokedAtGoogle = false;
      continue;
    }
    if (!(await revokeToken({ fetch: runtime.fetch }, token))) revokedAtGoogle = false;
  }
  return { disconnected: wiped.length, revokedAtGoogle };
}
