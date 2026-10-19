import { afterEach, describe, expect, it, vi } from "vitest";
import type { AuthConfig } from "@epiphany/core";
import { createDiscordClient } from "./discord";

const config: AuthConfig = {
  discordClientId: "123456789012345678",
  discordClientSecret: "placeholder-client-secret",
  ownerDiscordUserId: "100000000000000001",
  appUrl: "http://localhost:3000",
  secureCookies: false,
  timezone: "America/Chicago",
  devBypass: false,
};

afterEach(() => vi.unstubAllGlobals());

// Arctic calls fetch(Request); the user lookup calls fetch(url, init). Normalize both.
async function describeCall(input: RequestInfo | URL, init?: RequestInit) {
  const isRequest = input instanceof Request;
  return {
    url: isRequest ? input.url : String(input),
    body: isRequest ? await input.clone().text() : String(init?.body ?? ""),
    headers: isRequest
      ? Object.fromEntries(input.headers)
      : (init?.headers as Record<string, string> | undefined),
  };
}

describe("Discord client", () => {
  it("asks only for the identify scope, with state, PKCE, and the exact redirect URI", () => {
    const client = createDiscordClient(config)!;
    const url = client.authorizationUrl("state-123", "verifier-456");
    expect(url.origin + url.pathname).toBe("https://discord.com/oauth2/authorize");
    expect(url.searchParams.get("client_id")).toBe(config.discordClientId);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3000/api/auth/discord/callback",
    );
    expect(url.searchParams.get("scope")).toBe("identify");
    expect(url.searchParams.get("state")).toBe("state-123");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("code_challenge")).toBeTruthy();
    expect(url.toString()).not.toContain(config.discordClientSecret);
    expect(url.toString()).not.toContain("verifier-456");
  });

  it("generates fresh state and verifier values", () => {
    const client = createDiscordClient(config)!;
    expect(client.newState()).not.toBe(client.newState());
    expect(client.newVerifier()).not.toBe(client.newVerifier());
  });

  it("exchanges the code with the verifier, reads only the user id, and revokes the token", async () => {
    const calls: Array<{ url: string; body: string; headers?: Record<string, string> }> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const call = await describeCall(input, init);
        calls.push(call);
        if (call.url.endsWith("/oauth2/token")) {
          return Response.json({
            access_token: "at-123",
            token_type: "Bearer",
            expires_in: 604800,
          });
        }
        if (call.url.endsWith("/users/@me"))
          return Response.json({ id: "100000000000000001", username: "someone" });
        return Response.json({});
      }),
    );

    const signIn = await createDiscordClient(config)!.exchange("auth-code", "verifier-456");
    expect(signIn.userId).toBe("100000000000000001");
    await signIn.revoke();

    const token = calls.find((c) => c.url.endsWith("/oauth2/token"))!;
    expect(token.body).toContain("grant_type=authorization_code");
    expect(token.body).toContain("code=auth-code");
    expect(token.body).toContain("code_verifier=verifier-456");
    expect(decodeURIComponent(token.body)).toContain(
      "redirect_uri=http://localhost:3000/api/auth/discord/callback",
    );
    expect(calls.find((c) => c.url.endsWith("/users/@me"))?.headers).toMatchObject({
      Authorization: "Bearer at-123",
    });
    expect(calls.some((c) => c.url.endsWith("/oauth2/token/revoke"))).toBe(true);
    expect(calls.every((c) => c.url.startsWith("https://discord.com/"))).toBe(true);
  });

  it("rejects an unexpected user payload", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) =>
        (await describeCall(input, init)).url.endsWith("/oauth2/token")
          ? Response.json({ access_token: "at", token_type: "Bearer", expires_in: 1 })
          : Response.json({ id: 12345 }),
      ),
    );
    await expect(createDiscordClient(config)!.exchange("c", "v")).rejects.toThrow(
      /unexpected user/,
    );
  });

  it("fails when Discord rejects the code", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ error: "invalid_grant" }, { status: 400 })),
    );
    await expect(createDiscordClient(config)!.exchange("bad", "v")).rejects.toThrow();
  });
});
