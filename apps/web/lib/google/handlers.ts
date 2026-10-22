import {
  CalendarError,
  SCOPE_READ,
  scopesFor,
  type CalendarAccessMode,
  type GoogleTokens,
} from "@epiphany/core/calendar";
import { createServices, type CalendarServiceOptions } from "@epiphany/core/services";
import { clearCookie, cookieNames, readCookie, safeEqual, setCookie } from "../auth/cookies";
import {
  describeFailure,
  isSameOrigin,
  principalFromRequest,
  type AuthDeps,
} from "../auth/handlers";
import type { GoogleOAuthClient } from "./oauth";

export interface GoogleDeps {
  auth: AuthDeps;
  // Null until GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY are valid.
  oauth: GoogleOAuthClient | null;
  calendar: CalendarServiceOptions | null;
}

const OAUTH_COOKIE_SECONDS = 10 * 60;
const CALENDARS_PAGE = "/dashboard/calendars";

function redirect(deps: GoogleDeps, path: string, cookies: string[] = [], status = 302) {
  const headers = new Headers({
    Location: `${deps.auth.config.appUrl}${path}`,
    "Cache-Control": "no-store",
  });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

const notice = (deps: GoogleDeps, code: string, cookies: string[] = []) =>
  redirect(deps, `${CALENDARS_PAGE}?notice=${code}`, cookies, 303);

const toLogin = (deps: GoogleDeps, cookies: string[] = []) =>
  redirect(deps, "/login", cookies, 302);

function parseMode(value: string | null): CalendarAccessMode {
  return value === "read" ? "read" : "readwrite";
}

// Only the signed-in owner can start a connection. Starting is a navigation (a link), so it only
// sets a short-lived state cookie and redirects; nothing is stored until the callback verifies it.
export async function startConnect(request: Request, deps: GoogleDeps): Promise<Response> {
  const principal = await principalFromRequest(request, deps.auth);
  if (!principal) return toLogin(deps);
  if (!deps.oauth || !deps.calendar) return notice(deps, "not_configured");

  const mode = parseMode(new URL(request.url).searchParams.get("mode"));
  const state = deps.oauth.newState();
  const verifier = deps.oauth.newVerifier();
  const url = deps.oauth.authorizationUrl(state, verifier, mode);
  const names = cookieNames(deps.auth.config.secureCookies);

  const headers = new Headers({ Location: url.toString(), "Cache-Control": "no-store" });
  headers.append(
    "Set-Cookie",
    setCookie(names.googleOauth, `${state}.${verifier}.${mode}`, {
      secure: deps.auth.config.secureCookies,
      maxAgeSeconds: OAUTH_COOKIE_SECONDS,
    }),
  );
  return new Response(null, { status: 302, headers });
}

export async function finishConnect(request: Request, deps: GoogleDeps): Promise<Response> {
  const config = deps.auth.config;
  const names = cookieNames(config.secureCookies);
  const clearOauth = clearCookie(names.googleOauth, config.secureCookies);

  const principal = await principalFromRequest(request, deps.auth);
  if (!principal) return toLogin(deps, [clearOauth]);
  if (!deps.oauth || !deps.calendar) return notice(deps, "not_configured", [clearOauth]);

  const params = new URL(request.url).searchParams;
  if (params.get("error")) return notice(deps, "denied", [clearOauth]);

  const code = params.get("code");
  const state = params.get("state");
  const stored = readCookie(request, names.googleOauth);
  if (!code || !state || !stored) return notice(deps, "invalid", [clearOauth]);

  const [storedState, verifier, mode] = stored.split(".");
  if (!storedState || !verifier || !mode || !safeEqual(storedState, state)) {
    return notice(deps, "invalid", [clearOauth]);
  }

  try {
    const tokens = await deps.oauth.exchange(code, verifier);
    // Google may grant fewer scopes than asked for (the owner can untick one); keep what was
    // granted, and refuse a grant that cannot even read calendars.
    const requested = new Set(scopesFor(parseMode(mode)));
    const granted = tokens.scopes.filter((scope) => requested.has(scope));
    if (!granted.includes(SCOPE_READ)) {
      return notice(deps, "scope_missing", [clearOauth]);
    }
    const services = createServices(deps.auth.db, {
      clock: deps.auth.clock,
      calendar: deps.calendar,
    });
    const connectTokens: GoogleTokens = { ...tokens, scopes: granted };
    await services.calendar.connect(principal, connectTokens, { oauthConsentCompleted: true });
    return notice(deps, "connected", [clearOauth]);
  } catch (error) {
    if (error instanceof CalendarError) {
      const code =
        error.code === "account_mismatch"
          ? "other_account"
          : error.code === "no_refresh_token"
            ? "no_offline_access"
            : "failed";
      return notice(deps, code, [clearOauth]);
    }
    console.error(
      JSON.stringify({ service: "web", event: "google_connect_failed", ...describeFailure(error) }),
    );
    return notice(deps, "failed", [clearOauth]);
  }
}

// Revokes the token at Google (best effort), deletes the stored tokens, and stops every later
// call. Same-origin POST from the signed-in owner only.
export async function disconnect(request: Request, deps: GoogleDeps): Promise<Response> {
  if (!isSameOrigin(request, deps.auth.config)) return new Response(null, { status: 403 });
  const principal = await principalFromRequest(request, deps.auth);
  if (!principal) return new Response(null, { status: 401 });
  try {
    const services = createServices(deps.auth.db, {
      clock: deps.auth.clock,
      ...(deps.calendar ? { calendar: deps.calendar } : {}),
    });
    const result = await services.calendar.disconnect(principal);
    return notice(deps, result.revokedAtGoogle ? "disconnected" : "disconnected_unrevoked");
  } catch {
    console.error(JSON.stringify({ service: "web", event: "google_disconnect_failed" }));
    return notice(deps, "failed");
  }
}
