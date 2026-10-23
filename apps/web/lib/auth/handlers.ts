import type { AuthConfig } from "@epiphany/core";
import type { Database } from "@epiphany/core/db";
import { isLoopbackHost } from "@epiphany/core";
import {
  authenticateDevBypass,
  authenticateDiscordUser,
  createSession,
  destroySession,
  principalFromSession,
} from "@epiphany/core/auth";
import type { Principal } from "@epiphany/core/services";
import { clearCookie, cookieNames, readCookie, safeEqual, setCookie } from "./cookies";
import type { DiscordClient } from "./discord";

export interface AuthDeps {
  db: Database;
  config: AuthConfig;
  // Null when Discord credentials are not configured (development bypass without Discord).
  discord: DiscordClient | null;
  clock?: () => Date;
}

const OAUTH_COOKIE_SECONDS = 10 * 60;

function redirect(config: AuthConfig, path: string, cookies: string[] = [], status = 302) {
  const headers = new Headers({ Location: `${config.appUrl}${path}`, "Cache-Control": "no-store" });
  for (const cookie of cookies) headers.append("Set-Cookie", cookie);
  return new Response(null, { status, headers });
}

const discordNotConfigured = () =>
  Response.json({ error: "discord_sign_in_not_configured" }, { status: 503 });

export async function startLogin(_request: Request, deps: AuthDeps): Promise<Response> {
  const { config, discord } = deps;
  if (!discord) return discordNotConfigured();
  const state = discord.newState();
  const verifier = discord.newVerifier();
  const names = cookieNames(config.secureCookies);
  const url = discord.authorizationUrl(state, verifier);

  const headers = new Headers({ Location: url.toString(), "Cache-Control": "no-store" });
  headers.append(
    "Set-Cookie",
    setCookie(names.oauth, `${state}.${verifier}`, {
      secure: config.secureCookies,
      maxAgeSeconds: OAUTH_COOKIE_SECONDS,
    }),
  );
  return new Response(null, { status: 302, headers });
}

export async function finishLogin(request: Request, deps: AuthDeps): Promise<Response> {
  const { config, db, discord } = deps;
  if (!discord || !config.ownerDiscordUserId) return discordNotConfigured();
  const clock = deps.clock ?? (() => new Date());
  const names = cookieNames(config.secureCookies);
  const clearOauth = clearCookie(names.oauth, config.secureCookies);
  const fail = (reason: string) => redirect(config, `/login?error=${reason}`, [clearOauth]);

  const params = new URL(request.url).searchParams;
  if (params.get("error")) return fail("denied");

  const code = params.get("code");
  const state = params.get("state");
  const stored = readCookie(request, names.oauth);
  if (!code || !state || !stored) return fail("invalid");

  const separator = stored.indexOf(".");
  const storedState = stored.slice(0, separator);
  const verifier = stored.slice(separator + 1);
  if (separator < 1 || !verifier || !safeEqual(storedState, state)) return fail("invalid");

  try {
    const signIn = await discord.exchange(code, verifier);
    void signIn.revoke().catch(() => undefined);

    const ownerId = await authenticateDiscordUser(db, signIn.userId, {
      configuredDiscordUserId: config.ownerDiscordUserId,
      displayName: signIn.displayName,
      avatarHash: signIn.avatarHash,
      timezone: config.timezone,
    });
    if (!ownerId) return fail("not_authorized");

    const session = await createSession(db, ownerId, clock());
    return redirect(
      config,
      "/",
      [
        clearOauth,
        setCookie(names.session, session.token, {
          secure: config.secureCookies,
          expires: session.expiresAt,
        }),
      ],
      303,
    );
  } catch (error) {
    console.error(
      JSON.stringify({ service: "web", event: "sign_in_failed", ...describeFailure(error) }),
    );
    return fail("unavailable");
  }
}

// Explains why a sign-in call failed without logging request or response bodies (which could hold
// codes or tokens). Walks the error causes because network errors hide their reason there.
export function describeFailure(error: unknown): {
  message: string;
  cause?: string;
  hint?: string;
} {
  const message = error instanceof Error ? error.message : "unknown";
  const causes: string[] = [];
  let current: unknown = error instanceof Error ? error.cause : undefined;
  for (let depth = 0; current && depth < 4; depth++) {
    const code = (current as { code?: unknown }).code;
    const text = current instanceof Error ? current.message : String(current);
    causes.push(typeof code === "string" ? `${code}: ${text}` : text);
    current = current instanceof Error ? current.cause : undefined;
  }
  const cause = causes.length ? causes.join(" <- ") : undefined;

  const certProblem = /UNABLE_TO_GET_ISSUER_CERT|SELF_SIGNED_CERT|CERT_|certificate/i.test(
    cause ?? message,
  );
  return {
    message,
    ...(cause ? { cause } : {}),
    ...(certProblem
      ? {
          hint: "The server does not trust Discord's TLS certificate, usually because a company proxy inspects HTTPS. Set NODE_EXTRA_CA_CERTS to the proxy's root certificate, or use ENV_BYPASS=dev for local development. See docs/local-development.md.",
        }
      : {}),
  };
}

// Mutating requests must come from the dashboard's own origin. SameSite=Lax cookies already
// stop cross-site POSTs; this is a second, independent check.
export function isSameOrigin(request: Request, config: AuthConfig): boolean {
  const origin = request.headers.get("origin");
  if (origin) return origin === config.appUrl;
  return request.headers.get("sec-fetch-site") === "same-origin";
}

export async function logout(request: Request, deps: AuthDeps): Promise<Response> {
  const { config, db } = deps;
  if (!isSameOrigin(request, config)) return new Response(null, { status: 403 });
  const names = cookieNames(config.secureCookies);
  await destroySession(db, readCookie(request, names.session));
  return redirect(config, "/login", [clearCookie(names.session, config.secureCookies)], 303);
}

export async function principalFromRequest(
  request: Request,
  deps: Pick<AuthDeps, "db" | "config" | "clock">,
): Promise<Principal | null> {
  const names = cookieNames(deps.config.secureCookies);
  return principalFromSession(
    deps.db,
    readCookie(request, names.session),
    deps.clock ? deps.clock() : new Date(),
  );
}

// ENV_BYPASS=dev: sign in as the owner without Discord. Only reachable when the configuration
// loader accepted the bypass (development, localhost), and re-checked here on every request.
// Answers 404 when the bypass is off, so a deployed build exposes nothing.
export async function devLogin(request: Request, deps: AuthDeps): Promise<Response> {
  const { config, db } = deps;
  if (!config.devBypass) return new Response(null, { status: 404 });
  if (request.method !== "POST") {
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  }
  if (!isSameOrigin(request, config)) return new Response(null, { status: 403 });

  // A development server reachable from the network must not hand out owner sessions: the
  // request has to be addressed to localhost, both by URL and by Host header.
  const host = (request.headers.get("host") ?? "").replace(/:\d+$/, "");
  if (!isLoopbackHost(new URL(request.url).hostname) || !isLoopbackHost(host)) {
    return new Response(null, { status: 403 });
  }

  const clock = deps.clock ?? (() => new Date());
  const names = cookieNames(config.secureCookies);
  const ownerId = await authenticateDevBypass(db, {
    configuredDiscordUserId: config.ownerDiscordUserId,
    timezone: config.timezone,
  });
  const session = await createSession(db, ownerId, clock());
  console.warn(JSON.stringify({ service: "web", event: "dev_bypass_sign_in", ownerId }));

  return redirect(
    config,
    "/",
    [setCookie(names.session, session.token, { secure: false, expires: session.expiresAt })],
    303,
  );
}
