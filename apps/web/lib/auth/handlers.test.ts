import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SESSION_TTL_MS } from "@epiphany/core/auth";
import { dbTestsEnabled } from "@epiphany/core/testing";
import {
  createHarness,
  OWNER_DISCORD_ID,
  STRANGER_DISCORD_ID,
  type Harness,
} from "../test-harness";
import { describeFailure, devLogin, finishLogin, logout, startLogin } from "./handlers";

const URL_BASE = "http://localhost:3000";

describe.skipIf(!dbTestsEnabled)("Discord sign-in flow", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  const cookiesOf = (response: Response) => response.headers.getSetCookie();
  const callback = (query: string, cookie?: string) =>
    new Request(`${URL_BASE}/api/auth/discord/callback?${query}`, {
      headers: cookie ? { cookie } : {},
    });
  const rows = async (sql: string, params: unknown[] = []) =>
    (await h.handle.pool.query(sql, params))[0] as Array<Record<string, unknown>>;
  const countSessions = async () => (await rows("SELECT id FROM sessions")).length;

  async function begin() {
    const response = await startLogin(new Request(`${URL_BASE}/api/auth/discord`), h.deps);
    const set = cookiesOf(response).find((c) => c.startsWith("epiphany_oauth="))!;
    return { response, cookie: set.split(";")[0]! };
  }

  it("starts by redirecting to Discord with a short-lived, HttpOnly state cookie", async () => {
    const { response, cookie } = await begin();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toContain(
      "https://discord.example/authorize?state=state-1",
    );
    const set = cookiesOf(response)[0]!;
    expect(set).toContain("HttpOnly");
    expect(set).toContain("SameSite=Lax");
    expect(set).toContain("Max-Age=600");
    expect(set).not.toContain("Secure");
    expect(cookie).toBe("epiphany_oauth=state-1.verifier-1");
  });

  it("stores the Discord name and avatar for the dashboard on sign-in", async () => {
    h.discord.profile = { displayName: "Leo", avatarHash: "d".repeat(32) };
    const { cookie } = await begin();
    const response = await finishLogin(callback("code=abc&state=state-1", cookie), h.deps);
    expect(response.status).toBe(303);
    expect(
      await rows("SELECT display_name, avatar_hash FROM owners WHERE id = ?", [h.ownerId]),
    ).toEqual([{ display_name: "Leo", avatar_hash: "d".repeat(32) }]);
  });

  it("signs the owner in: creates a hashed session and a hardened session cookie", async () => {
    const { cookie } = await begin();
    const response = await finishLogin(callback("code=abc&state=state-1", cookie), h.deps);

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${URL_BASE}/`);
    expect(h.discord.exchanges).toEqual([{ code: "abc", verifier: "verifier-1" }]);
    expect(h.discord.revoked).toBe(1);

    const set = cookiesOf(response);
    const session = set.find((c) => c.startsWith("epiphany_session="))!;
    expect(session).toMatch(/HttpOnly/);
    expect(session).toMatch(/SameSite=Lax/);
    expect(session).toMatch(/Path=\//);
    expect(session).toContain(
      `Expires=${new Date(h.now.current.getTime() + SESSION_TTL_MS).toUTCString()}`,
    );
    expect(set.find((c) => c.startsWith("epiphany_oauth="))).toContain("Max-Age=0");

    const token = session.split(";")[0]!.split("=")[1]!;
    const stored = await rows("SELECT id, owner_id FROM sessions");
    expect(stored).toHaveLength(1);
    expect(stored[0]?.owner_id).toBe(h.ownerId);
    expect(JSON.stringify(stored)).not.toContain(token);
  });

  it("refuses any other Discord account and creates nothing", async () => {
    h.discord.signInAs = STRANGER_DISCORD_ID;
    const { cookie } = await begin();
    const response = await finishLogin(callback("code=abc&state=state-1", cookie), h.deps);

    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`${URL_BASE}/login?error=not_authorized`);
    expect(cookiesOf(response).some((c) => c.startsWith("epiphany_session="))).toBe(false);
    expect(await countSessions()).toBe(0);
    expect(
      await rows("SELECT id FROM owners WHERE discord_user_id = ?", [STRANGER_DISCORD_ID]),
    ).toEqual([]);
  });

  it.each([
    ["no state cookie", "code=abc&state=state-1", undefined],
    ["state mismatch", "code=abc&state=attacker", "epiphany_oauth=state-1.verifier-1"],
    ["missing code", "state=state-1", "epiphany_oauth=state-1.verifier-1"],
    ["missing state", "code=abc", "epiphany_oauth=state-1.verifier-1"],
    ["malformed cookie", "code=abc&state=state-1", "epiphany_oauth=nodot"],
    ["empty verifier", "code=abc&state=state-1", "epiphany_oauth=state-1."],
  ])("rejects an invalid callback (%s) before contacting Discord", async (_name, query, cookie) => {
    const response = await finishLogin(callback(query, cookie), h.deps);
    expect(response.headers.get("location")).toBe(`${URL_BASE}/login?error=invalid`);
    expect(h.discord.exchanges).toEqual([]);
    expect(await countSessions()).toBe(0);
  });

  it("reports a canceled Discord prompt", async () => {
    const { cookie } = await begin();
    const response = await finishLogin(
      callback("error=access_denied&state=state-1", cookie),
      h.deps,
    );
    expect(response.headers.get("location")).toBe(`${URL_BASE}/login?error=denied`);
    expect(h.discord.exchanges).toEqual([]);
  });

  it("fails safely, without leaking details, when Discord or the exchange errors", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    h.discord.signInAs = new Error("Discord is down");
    const { cookie } = await begin();
    const response = await finishLogin(callback("code=SECRETCODE&state=state-1", cookie), h.deps);

    expect(response.headers.get("location")).toBe(`${URL_BASE}/login?error=unavailable`);
    expect(await countSessions()).toBe(0);
    const logged = log.mock.calls.flat().join(" ");
    expect(logged).toContain("sign_in_failed");
    expect(logged).not.toContain("SECRETCODE");
  });

  it("cannot replay a state cookie from a previous attempt after it was cleared", async () => {
    const { cookie } = await begin();
    const first = await finishLogin(callback("code=abc&state=state-1", cookie), h.deps);
    expect(cookiesOf(first).find((c) => c.startsWith("epiphany_oauth="))).toContain("Max-Age=0");
    const replay = await finishLogin(callback("code=abc&state=state-1"), h.deps);
    expect(replay.headers.get("location")).toContain("error=invalid");
  });

  describe("logout", () => {
    const post = (headers: Record<string, string>) =>
      new Request(`${URL_BASE}/api/auth/logout`, { method: "POST", headers });

    it("ends the session for a same-origin request", async () => {
      const token = await h.sessionFor(h.ownerId);
      const response = await logout(post({ origin: URL_BASE, cookie: h.setCookie(token) }), h.deps);
      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${URL_BASE}/login`);
      expect(cookiesOf(response)[0]).toContain("Max-Age=0");
      expect(await countSessions()).toBe(0);
    });

    it.each([
      ["no origin", {}],
      ["another origin", { origin: "https://evil.example" }],
      ["a lookalike origin", { origin: "http://localhost:3000.evil.example" }],
    ])("ignores a cross-site logout (%s) and keeps the session", async (_name, extra) => {
      const token = await h.sessionFor(h.ownerId);
      const response = await logout(post({ cookie: h.setCookie(token), ...extra }), h.deps);
      expect(response.status).toBe(403);
      expect(await countSessions()).toBe(1);
    });

    it("accepts a same-origin fetch identified by Sec-Fetch-Site", async () => {
      const token = await h.sessionFor(h.ownerId);
      const response = await logout(
        post({ "sec-fetch-site": "same-origin", cookie: h.setCookie(token) }),
        h.deps,
      );
      expect(response.status).toBe(303);
      expect(await countSessions()).toBe(0);
    });
  });

  it("sanity: the configured owner id is what the harness signs in", () => {
    expect(h.discord.signInAs).toBe(OWNER_DISCORD_ID);
  });
});

describe.skipIf(!dbTestsEnabled)("secure (https) deployment cookies", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness({ appUrl: "https://epi.example.com", secureCookies: true });
  });
  afterEach(async () => h.close());

  it("uses __Host- prefixed Secure cookies", async () => {
    const start = await startLogin(new Request("https://epi.example.com/api/auth/discord"), h.deps);
    const oauth = start.headers.getSetCookie()[0]!;
    expect(oauth).toMatch(/^__Host-epiphany_oauth=state-1\.verifier-1;/);
    expect(oauth).toContain("Secure");

    const response = await finishLogin(
      new Request("https://epi.example.com/api/auth/discord/callback?code=c&state=state-1", {
        headers: { cookie: "__Host-epiphany_oauth=state-1.verifier-1" },
      }),
      h.deps,
    );
    expect(response.headers.get("location")).toBe("https://epi.example.com/");
    const session = response.headers
      .getSetCookie()
      .find((c) => c.startsWith("__Host-epiphany_session="))!;
    expect(session).toContain("Secure");
    expect(session).toContain("HttpOnly");
    expect(session).not.toMatch(/Domain=/i);
  });
});

describe("describeFailure", () => {
  it("surfaces the hidden network cause and explains certificate problems", () => {
    const tls = Object.assign(new Error("unable to get local issuer certificate"), {
      code: "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
    });
    const fetchFailed = new TypeError("fetch failed", { cause: tls });
    const wrapped = new Error("Failed to send request", { cause: fetchFailed });

    const result = describeFailure(wrapped);
    expect(result.message).toBe("Failed to send request");
    expect(result.cause).toContain("UNABLE_TO_GET_ISSUER_CERT_LOCALLY");
    expect(result.hint).toContain("NODE_EXTRA_CA_CERTS");
    expect(result.hint).toContain("ENV_BYPASS=dev");
  });

  it("gives no certificate hint for other errors, and tolerates non-errors", () => {
    expect(describeFailure(new Error("connect ECONNREFUSED"))).toEqual({
      message: "connect ECONNREFUSED",
    });
    expect(describeFailure("weird")).toEqual({ message: "unknown" });
    const cyclic = new Error("a");
    (cyclic as { cause?: unknown }).cause = cyclic;
    expect(describeFailure(cyclic).cause?.split(" <- ").length).toBeLessThanOrEqual(4);
  });
});

describe.skipIf(!dbTestsEnabled)("development bypass sign-in (ENV_BYPASS=dev)", () => {
  let h: Harness;
  const rows = async (sql: string, params: unknown[] = []) =>
    (await h.handle.pool.query(sql, params))[0] as Array<Record<string, unknown>>;
  const post = (
    headers: Record<string, string> = {},
    url = `${URL_BASE}/api/auth/dev`,
    method = "POST",
  ) =>
    new Request(url, { method, headers: { origin: URL_BASE, host: "localhost:3000", ...headers } });

  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  describe("when the bypass is off (the default)", () => {
    beforeEach(async () => {
      h = await createHarness();
    });

    it("does not exist: 404, no session, no owner change", async () => {
      const response = await devLogin(post(), h.deps);
      expect(response.status).toBe(404);
      expect(response.headers.getSetCookie()).toEqual([]);
      expect(await rows("SELECT id FROM sessions")).toEqual([]);
      expect(await rows("SELECT id FROM owners")).toHaveLength(1);
    });
  });

  describe("when the bypass is on", () => {
    beforeEach(async () => {
      h = await createHarness({
        devBypass: true,
        ownerDiscordUserId: null,
        discordClientId: null,
        discordClientSecret: null,
      });
      h.deps.discord = null;
    });

    it("signs in as a local Dev Owner with a hardened session cookie, and audits it", async () => {
      const log = vi.spyOn(console, "warn").mockImplementation(() => undefined);
      const response = await devLogin(post(), h.deps);

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe(`${URL_BASE}/`);
      const cookie = response.headers
        .getSetCookie()
        .find((c) => c.startsWith("epiphany_session="))!;
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");

      const dev = await rows("SELECT id FROM owners WHERE display_name = 'Dev Owner'");
      expect(dev).toHaveLength(1);
      const sessionRows = await rows("SELECT owner_id FROM sessions");
      expect(sessionRows).toEqual([{ owner_id: dev[0]!.id }]);
      expect(
        await rows("SELECT id FROM action_history WHERE action = 'auth.dev_bypass_sign_in'"),
      ).toHaveLength(1);
      expect(log.mock.calls.flat().join(" ")).toContain("dev_bypass_sign_in");
    });

    it("produces a session that actually works as an owner principal", async () => {
      const response = await devLogin(post(), h.deps);
      const token = response.headers.getSetCookie()[0]!.split(";")[0]!.split("=")[1]!;
      const { principalFromRequest } = await import("./handlers");
      const principal = await principalFromRequest(
        new Request(`${URL_BASE}/api/tasks`, { headers: { cookie: h.setCookie(token) } }),
        h.deps,
      );
      expect(principal).toMatchObject({
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
    });

    it("signs in as the real owner when an owner Discord ID is configured", async () => {
      h.deps.config = { ...h.deps.config, ownerDiscordUserId: OWNER_DISCORD_ID };
      await devLogin(post(), h.deps);
      expect(await rows("SELECT owner_id FROM sessions")).toEqual([{ owner_id: h.ownerId }]);
      expect(await rows("SELECT id FROM owners WHERE display_name = 'Dev Owner'")).toEqual([]);
    });

    it.each(["GET", "PUT", "DELETE"])(
      "rejects %s, so a link or image tag can never sign in",
      async (method) => {
        const response = await devLogin(post({}, `${URL_BASE}/api/auth/dev`, method), h.deps);
        expect(response.status).toBe(405);
        expect(await rows("SELECT id FROM sessions")).toEqual([]);
      },
    );

    it.each([
      ["no origin", { origin: "" }],
      ["a foreign origin", { origin: "https://evil.example" }],
    ])("refuses a cross-site request (%s)", async (_name, headers) => {
      const request = new Request(`${URL_BASE}/api/auth/dev`, {
        method: "POST",
        headers: { host: "localhost:3000", ...(headers.origin ? headers : {}) },
      });
      expect((await devLogin(request, h.deps)).status).toBe(403);
      expect(await rows("SELECT id FROM sessions")).toEqual([]);
    });

    it.each([
      ["a LAN address in the URL", `http://10.1.2.3:3000/api/auth/dev`, { host: "10.1.2.3:3000" }],
      [
        "a LAN address in the URL but a spoofed localhost Host header",
        `http://10.1.2.3:3000/api/auth/dev`,
        { host: "localhost:3000" },
      ],
      ["a LAN Host header", `${URL_BASE}/api/auth/dev`, { host: "10.1.2.3:3000" }],
      ["a public hostname", `http://epi.example.com/api/auth/dev`, { host: "epi.example.com" }],
      ["a lookalike host", `${URL_BASE}/api/auth/dev`, { host: "localhost.evil.example" }],
      ["a missing Host header", `${URL_BASE}/api/auth/dev`, { host: "" }],
    ])("refuses a request addressed to %s", async (_name, url, headers) => {
      const request = new Request(url, {
        method: "POST",
        headers: { origin: URL_BASE, ...(headers.host ? headers : {}) },
      });
      expect((await devLogin(request, h.deps)).status).toBe(403);
      expect(await rows("SELECT id FROM sessions")).toEqual([]);
    });

    it("accepts 127.0.0.1 and [::1] when APP_URL is that origin", async () => {
      for (const [origin, host] of [
        ["http://127.0.0.1:3000", "127.0.0.1:3000"],
        ["http://[::1]:3000", "[::1]:3000"],
      ] as const) {
        h.deps.config = { ...h.deps.config, appUrl: origin };
        const response = await devLogin(
          new Request(`${origin}/api/auth/dev`, { method: "POST", headers: { origin, host } }),
          h.deps,
        );
        expect(response.status, origin).toBe(303);
      }
    });

    it("leaves Discord sign-in unavailable (503) until credentials are configured", async () => {
      const start = await startLogin(new Request(`${URL_BASE}/api/auth/discord`), h.deps);
      expect(start.status).toBe(503);
      expect(await start.json()).toEqual({ error: "discord_sign_in_not_configured" });
      const finish = await finishLogin(
        new Request(`${URL_BASE}/api/auth/discord/callback?code=a&state=b`),
        h.deps,
      );
      expect(finish.status).toBe(503);
    });
  });
});
