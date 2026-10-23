import { randomBytes } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { scopesFor, SCOPE_READ, type GoogleTokens } from "@epiphany/core/calendar";
import { FakeGoogle } from "@epiphany/core/calendar/testing";
import { dbTestsEnabled } from "@epiphany/core/testing";
import { createHarness, type Harness } from "../test-harness";
import { disconnect, finishConnect, startConnect, type GoogleDeps } from "./handlers";
import type { GoogleOAuthClient } from "./oauth";

const BASE = "http://localhost:3000";

interface FakeOAuth extends GoogleOAuthClient {
  exchanges: Array<{ code: string; verifier: string }>;
  modes: string[];
  result: GoogleTokens | Error;
}

describe.skipIf(!dbTestsEnabled)("Google Calendar connect flow", () => {
  let h: Harness;
  let google: FakeGoogle;
  let oauth: FakeOAuth;
  let deps: GoogleDeps;
  let session: string;

  const tokens = (over: Partial<GoogleTokens> = {}): GoogleTokens => ({
    providerAccountId: "google-sub-1",
    email: "owner@example.test",
    scopes: scopesFor("readwrite"),
    accessToken: "SECRET-ACCESS-TOKEN",
    refreshToken: "SECRET-REFRESH-TOKEN",
    accessTokenExpiresAt: new Date("2026-10-13T16:00:00.000Z"),
    ...over,
  });

  beforeEach(async () => {
    h = await createHarness();
    google = new FakeGoogle();
    let counter = 0;
    oauth = {
      exchanges: [],
      modes: [],
      result: tokens(),
      newState: () => `gstate-${++counter}`,
      newVerifier: () => `gverifier-${counter}`,
      authorizationUrl: (state, _verifier, mode) => {
        oauth.modes.push(mode);
        return new URL(`https://accounts.example/auth?state=${state}`);
      },
      async exchange(code, verifier) {
        oauth.exchanges.push({ code, verifier });
        if (oauth.result instanceof Error) throw oauth.result;
        return oauth.result;
      },
    };
    deps = {
      auth: h.deps,
      oauth,
      calendar: {
        tokenKey: randomBytes(32),
        clientId: "client-id",
        clientSecret: "placeholder-client-secret",
        fetch: google.fetch,
      },
    };
    session = h.setCookie(await h.sessionFor(h.ownerId));
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  const rows = async (sql: string, params: unknown[] = []) =>
    (await h.handle.pool.query(sql, params))[0] as Array<Record<string, unknown>>;
  const cookiesOf = (response: Response) => response.headers.getSetCookie();
  const connectRequest = (query = "", cookie = session) =>
    new Request(`${BASE}/api/google/connect${query}`, { headers: cookie ? { cookie } : {} });
  const callback = (query: string, cookie?: string) =>
    new Request(`${BASE}/api/google/callback?${query}`, {
      headers: { cookie: [session, cookie].filter(Boolean).join("; ") },
    });
  const location = (response: Response) => response.headers.get("location");

  async function begin(query = "") {
    const response = await startConnect(connectRequest(query), deps);
    const set = cookiesOf(response).find((c) => c.startsWith("epiphany_google_oauth="))!;
    return { response, cookie: set.split(";")[0]! };
  }

  describe("starting", () => {
    it("redirects the signed-in owner to Google with a short-lived HttpOnly state cookie", async () => {
      const { response, cookie } = await begin();
      expect(response.status).toBe(302);
      expect(location(response)).toBe("https://accounts.example/auth?state=gstate-1");
      const set = cookiesOf(response)[0]!;
      expect(set).toContain("HttpOnly");
      expect(set).toContain("SameSite=Lax");
      expect(set).toContain("Max-Age=600");
      expect(cookie).toBe("epiphany_google_oauth=gstate-1.gverifier-1.readwrite");
      expect(oauth.modes).toEqual(["readwrite"]);
    });

    it("offers a read-only choice", async () => {
      const { cookie } = await begin("?mode=read");
      expect(cookie.endsWith(".read")).toBe(true);
      expect(oauth.modes).toEqual(["read"]);
    });

    it("sends anyone who is not signed in to the login page and starts nothing", async () => {
      for (const cookie of ["", "epiphany_session=forged"]) {
        const response = await startConnect(connectRequest("", cookie), deps);
        expect(location(response)).toBe(`${BASE}/login`);
        expect(cookiesOf(response)).toEqual([]);
      }
      expect(oauth.modes).toEqual([]);
    });

    it("fails closed with an actionable message when Google is not configured", async () => {
      const response = await startConnect(connectRequest(), {
        ...deps,
        oauth: null,
        calendar: null,
      });
      expect(location(response)).toBe(`${BASE}/dashboard/calendars?notice=not_configured`);
      expect(cookiesOf(response)).toEqual([]);
    });
  });

  describe("finishing", () => {
    it("stores the connection with encrypted tokens and clears the state cookie", async () => {
      const { cookie } = await begin();
      const response = await finishConnect(callback("code=abc&state=gstate-1", cookie), deps);
      expect(response.status).toBe(303);
      expect(location(response)).toBe(`${BASE}/dashboard/calendars?notice=connected`);
      expect(cookiesOf(response)[0]).toContain("Max-Age=0");
      expect(oauth.exchanges).toEqual([{ code: "abc", verifier: "gverifier-1" }]);

      const accounts = await rows("SELECT * FROM calendar_accounts");
      expect(accounts).toHaveLength(1);
      expect(accounts[0]).toMatchObject({ owner_id: h.ownerId, status: "connected" });
      const stored = JSON.stringify(accounts);
      expect(stored).not.toContain("SECRET-ACCESS-TOKEN");
      expect(stored).not.toContain("SECRET-REFRESH-TOKEN");
      expect(String(accounts[0]!.refresh_token_enc)).toMatch(/^v1\./);
      expect(
        await rows("SELECT action FROM action_history WHERE action = 'calendar.connect'"),
      ).toHaveLength(1);
    });

    it("keeps read-only access read-only when Google grants only the read scope", async () => {
      oauth.result = tokens({ scopes: [SCOPE_READ, "openid", "https://example.test/other"] });
      const { cookie } = await begin();
      await finishConnect(callback("code=abc&state=gstate-1", cookie), deps);
      const [account] = await rows("SELECT scopes FROM calendar_accounts");
      expect(String(account!.scopes)).toBe(`${SCOPE_READ} openid`);
    });

    it("refuses a grant that cannot read calendars", async () => {
      oauth.result = tokens({ scopes: ["openid", "email"] });
      const { cookie } = await begin();
      const response = await finishConnect(callback("code=abc&state=gstate-1", cookie), deps);
      expect(location(response)).toContain("notice=scope_missing");
      expect(await rows("SELECT id FROM calendar_accounts")).toEqual([]);
    });

    it.each([
      ["no state cookie", "code=abc&state=gstate-1", undefined],
      [
        "state mismatch",
        "code=abc&state=attacker",
        "epiphany_google_oauth=gstate-1.gverifier-1.read",
      ],
      ["missing code", "state=gstate-1", "epiphany_google_oauth=gstate-1.gverifier-1.read"],
      ["missing state", "code=abc", "epiphany_google_oauth=gstate-1.gverifier-1.read"],
      ["malformed cookie", "code=abc&state=gstate-1", "epiphany_google_oauth=nodot"],
      ["empty verifier", "code=abc&state=gstate-1", "epiphany_google_oauth=gstate-1..read"],
      [
        "a Discord sign-in state cookie",
        "code=abc&state=state-1",
        "epiphany_oauth=state-1.verifier-1",
      ],
    ])(
      "rejects an invalid callback (%s) before contacting Google",
      async (_name, query, cookie) => {
        const response = await finishConnect(callback(query, cookie), deps);
        expect(location(response)).toBe(`${BASE}/dashboard/calendars?notice=invalid`);
        expect(oauth.exchanges).toEqual([]);
        expect(await rows("SELECT id FROM calendar_accounts")).toEqual([]);
      },
    );

    it("only completes for the signed-in owner", async () => {
      const { cookie } = await begin();
      const anonymous = new Request(`${BASE}/api/google/callback?code=abc&state=gstate-1`, {
        headers: { cookie },
      });
      const response = await finishConnect(anonymous, deps);
      expect(location(response)).toBe(`${BASE}/login`);
      expect(oauth.exchanges).toEqual([]);
      expect(await rows("SELECT id FROM calendar_accounts")).toEqual([]);
    });

    it("reports a canceled consent screen", async () => {
      const { cookie } = await begin();
      const response = await finishConnect(
        callback("error=access_denied&state=gstate-1", cookie),
        deps,
      );
      expect(location(response)).toContain("notice=denied");
      expect(oauth.exchanges).toEqual([]);
    });

    it("reports missing offline access and a second Google account", async () => {
      oauth.result = tokens({ refreshToken: null });
      let { cookie } = await begin();
      expect(
        location(await finishConnect(callback("code=abc&state=gstate-1", cookie), deps)),
      ).toContain("notice=no_offline_access");
      expect(await rows("SELECT id FROM calendar_accounts")).toEqual([]);

      oauth.result = tokens();
      ({ cookie } = await begin());
      await finishConnect(callback("code=abc&state=gstate-2", cookie), deps);
      oauth.result = tokens({ providerAccountId: "someone-else" });
      ({ cookie } = await begin());
      const response = await finishConnect(callback("code=abc&state=gstate-3", cookie), deps);
      expect(location(response)).toContain("notice=other_account");
      expect(await rows("SELECT id FROM calendar_accounts")).toHaveLength(1);
    });

    it("fails safely, without logging codes or tokens, when the exchange errors", async () => {
      const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
      oauth.result = new Error("Google is down");
      const { cookie } = await begin();
      const response = await finishConnect(
        callback("code=SECRETCODE&state=gstate-1", cookie),
        deps,
      );
      expect(location(response)).toContain("notice=failed");
      expect(await rows("SELECT id FROM calendar_accounts")).toEqual([]);
      const logged = log.mock.calls.flat().join(" ");
      expect(logged).toContain("google_connect_failed");
      expect(logged).not.toContain("SECRETCODE");
    });

    it("cannot replay a state cookie after it was cleared", async () => {
      const { cookie } = await begin();
      await finishConnect(callback("code=abc&state=gstate-1", cookie), deps);
      const replay = await finishConnect(callback("code=abc&state=gstate-1"), deps);
      expect(location(replay)).toContain("notice=invalid");
      expect(oauth.exchanges).toHaveLength(1);
    });
  });

  describe("disconnecting", () => {
    const post = (headers: Record<string, string>) =>
      new Request(`${BASE}/api/google/disconnect`, { method: "POST", headers });

    async function connected() {
      const { cookie } = await begin();
      await finishConnect(callback("code=abc&state=gstate-1", cookie), deps);
    }

    it("revokes at Google, deletes the tokens, and answers with a notice", async () => {
      await connected();
      const response = await disconnect(post({ origin: BASE, cookie: session }), deps);
      expect(response.status).toBe(303);
      expect(location(response)).toBe(`${BASE}/dashboard/calendars?notice=disconnected`);
      expect(google.revokedTokens).toEqual(["SECRET-REFRESH-TOKEN"]);
      expect(
        await rows("SELECT status, access_token_enc, refresh_token_enc FROM calendar_accounts"),
      ).toEqual([{ status: "revoked", access_token_enc: null, refresh_token_enc: null }]);
    });

    it("still disconnects when Google cannot be reached, and says the revoke did not happen", async () => {
      await connected();
      deps.calendar!.fetch = (async () => {
        throw new TypeError("fetch failed");
      }) as never;
      const response = await disconnect(post({ origin: BASE, cookie: session }), deps);
      expect(location(response)).toContain("notice=disconnected_unrevoked");
      expect((await rows("SELECT status FROM calendar_accounts"))[0]).toEqual({
        status: "revoked",
      });
    });

    it.each([
      ["no origin", {}],
      ["another origin", { origin: "https://evil.example" }],
    ])("ignores a cross-site request (%s)", async (_name, extra) => {
      await connected();
      const response = await disconnect(post({ cookie: session, ...extra }), deps);
      expect(response.status).toBe(403);
      expect((await rows("SELECT status FROM calendar_accounts"))[0]).toEqual({
        status: "connected",
      });
    });

    it("refuses anyone who is not the signed-in owner", async () => {
      await connected();
      const response = await disconnect(
        post({ origin: BASE, cookie: "epiphany_session=forged" }),
        deps,
      );
      expect(response.status).toBe(401);
      expect((await rows("SELECT status FROM calendar_accounts"))[0]).toEqual({
        status: "connected",
      });
    });
  });
});
