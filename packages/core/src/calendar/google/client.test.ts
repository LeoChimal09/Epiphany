import { describe, expect, it } from "vitest";
import { FakeGoogle } from "../fake-google";
import { createGoogleCalendarClient } from "./client";
import {
  GoogleAuthError,
  GoogleConflictError,
  GoogleGoneError,
  GooglePreconditionError,
  GoogleRateLimitError,
  GoogleApiError,
  GoogleInvalidGrantError,
  GoogleTokenError,
  UncertainWriteError,
} from "./errors";
import { canWrite, refreshAccessToken, revokeToken, scopesFor } from "./oauth";

function setup(overrides: Partial<Parameters<typeof createGoogleCalendarClient>[0]> = {}) {
  const google = new FakeGoogle();
  google.validAccessTokens.add("good");
  const sleeps: number[] = [];
  let refreshes = 0;
  const client = createGoogleCalendarClient({
    getAccessToken: async (o) => {
      if (o?.forceRefresh) refreshes++;
      return "good";
    },
    fetch: google.fetch,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    random: () => 0.5,
    ...overrides,
  });
  return { google, client, sleeps, refreshes: () => refreshes };
}

const range = { timeMin: "2026-01-01T00:00:00Z", timeMax: "2027-01-01T00:00:00Z" };

describe("Google Calendar client", () => {
  it("lists calendars", async () => {
    const { client } = setup();
    expect(await client.listCalendars()).toEqual([
      {
        id: "owner@example.test",
        summary: "Owner",
        timeZone: "America/Chicago",
        accessRole: "owner",
        primary: true,
      },
    ]);
  });

  it("follows every page and returns the sync token from the last one", async () => {
    const { client, google } = setup();
    google.pageSize = 2;
    for (let i = 0; i < 5; i++) {
      google.addEvent("owner@example.test", { start: { dateTime: "2026-10-20T15:00:00Z" } });
    }
    const result = await client.listAllEvents("owner@example.test", range);
    expect(result.events).toHaveLength(5);
    expect(result.nextSyncToken).toMatch(/^st-/);
    expect(google.calls.filter((c) => c.path.endsWith("/events"))).toHaveLength(3);
  });

  it("uses the sync token for changes only and does not send a time window with it", async () => {
    const { client, google } = setup();
    google.addEvent("owner@example.test", { id: "a", start: { dateTime: "2026-10-20T15:00:00Z" } });
    const first = await client.listAllEvents("owner@example.test", range);
    google.addEvent("owner@example.test", { id: "b", start: { dateTime: "2026-10-21T15:00:00Z" } });
    google.clearCalls();
    const second = await client.listAllEvents("owner@example.test", {
      syncToken: first.nextSyncToken!,
      ...range,
    });
    expect(second.events.map((e) => e.id)).toEqual(["b"]);
    expect(google.calls[0]!.query.timeMin).toBeUndefined();
    expect(google.calls[0]!.query.syncToken).toBe(first.nextSyncToken);
  });

  it("reports 410 Gone for an expired sync token", async () => {
    const { client, google } = setup();
    const first = await client.listAllEvents("owner@example.test", range);
    google.expireSyncTokens();
    await expect(
      client.listAllEvents("owner@example.test", { syncToken: first.nextSyncToken! }),
    ).rejects.toBeInstanceOf(GoogleGoneError);
  });

  it("backs off on 429, honoring Retry-After, then succeeds", async () => {
    const { client, google, sleeps } = setup();
    google.fail(
      (c) => c.path === "/users/me/calendarList",
      {
        status: 429,
        headers: { "Retry-After": "3" },
      },
      2,
    );
    expect(await client.listCalendars()).toHaveLength(1);
    expect(sleeps).toEqual([3000, 3000]);
  });

  it("treats 403 rateLimitExceeded as a rate limit and gives up after bounded retries", async () => {
    const { client, google, sleeps } = setup({ maxAttempts: 3 });
    google.fail(
      (c) => c.path === "/users/me/calendarList",
      { status: 403, body: { error: { errors: [{ reason: "rateLimitExceeded" }] } } },
      10,
    );
    await expect(client.listCalendars()).rejects.toBeInstanceOf(GoogleRateLimitError);
    expect(google.calls).toHaveLength(3);
    expect(sleeps).toHaveLength(2);
  });

  it("does not retry other 403 errors", async () => {
    const { client, google } = setup();
    google.fail(
      (c) => c.path === "/users/me/calendarList",
      { status: 403, body: { error: { errors: [{ reason: "forbidden" }] } } },
      5,
    );
    await expect(client.listCalendars()).rejects.toBeInstanceOf(GoogleApiError);
    expect(google.calls).toHaveLength(1);
  });

  it("retries reads after a server error but never retries a write blindly", async () => {
    const { client, google } = setup();
    google.fail((c) => c.method === "GET", { status: 503 }, 1);
    expect(await client.listCalendars()).toHaveLength(1);

    google.clearCalls();
    google.fail((c) => c.method === "POST", { status: 503 }, 1);
    await expect(
      client.insertEvent("owner@example.test", {
        summary: "x",
        start: { dateTime: "2026-10-20T15:00:00Z" },
        end: { dateTime: "2026-10-20T16:00:00Z" },
      }),
    ).rejects.toBeInstanceOf(UncertainWriteError);
    expect(google.calls).toHaveLength(1);
  });

  it("reports a dropped connection on a write as uncertain", async () => {
    const { client, google } = setup();
    google.fail((c) => c.method === "POST", "timeout-after-apply");
    await expect(
      client.insertEvent("owner@example.test", {
        id: "abcde",
        summary: "x",
        start: { dateTime: "2026-10-20T15:00:00Z" },
        end: { dateTime: "2026-10-20T16:00:00Z" },
      }),
    ).rejects.toBeInstanceOf(UncertainWriteError);
    // The write did land even though the caller never heard back.
    expect(google.calendars.get("owner@example.test")!.events.has("abcde")).toBe(true);
  });

  it("sends If-Match and maps 412 and 409", async () => {
    const { client, google } = setup();
    const body = {
      id: "abcde",
      summary: "x",
      start: { dateTime: "2026-10-20T15:00:00Z" },
      end: { dateTime: "2026-10-20T16:00:00Z" },
    };
    const created = await client.insertEvent("owner@example.test", body);
    await expect(client.insertEvent("owner@example.test", body)).rejects.toBeInstanceOf(
      GoogleConflictError,
    );
    google.editEvent("owner@example.test", "abcde", { summary: "edited elsewhere" });
    await expect(
      client.updateEvent("owner@example.test", "abcde", body, created.etag!),
    ).rejects.toBeInstanceOf(GooglePreconditionError);
    expect(google.calls.at(-1)!.ifMatch).toBe(created.etag);
    expect(google.calendars.get("owner@example.test")!.events.get("abcde")!.summary).toBe(
      "edited elsewhere",
    );
  });

  it("refreshes once after a 401 and then gives up", async () => {
    const google = new FakeGoogle();
    google.validAccessTokens.add("fresh");
    let calls = 0;
    const client = createGoogleCalendarClient({
      getAccessToken: async (o) => (o?.forceRefresh ? "fresh" : (calls++, "stale")),
      fetch: google.fetch,
      sleep: async () => undefined,
    });
    expect(await client.listCalendars()).toHaveLength(1);
    expect(calls).toBe(1);

    const denied = createGoogleCalendarClient({
      getAccessToken: async () => "never-valid",
      fetch: google.fetch,
      sleep: async () => undefined,
    });
    await expect(denied.listCalendars()).rejects.toBeInstanceOf(GoogleAuthError);
  });

  it("finds an event by its private idempotency key", async () => {
    const { client, google } = setup();
    google.addEvent("owner@example.test", {
      id: "mine",
      extendedProperties: { private: { epiphanyKey: "wb:1" } },
    });
    google.addEvent("owner@example.test", { id: "other" });
    expect((await client.findEventByKey("owner@example.test", "wb:1"))?.id).toBe("mine");
    expect(await client.findEventByKey("owner@example.test", "wb:2")).toBeNull();
  });
});

describe("OAuth token calls", () => {
  const credentials = { clientId: "id", clientSecret: "placeholder-secret" };

  it("refreshes an access token", async () => {
    const google = new FakeGoogle();
    const token = await refreshAccessToken(
      { ...credentials, fetch: google.fetch, now: () => new Date("2026-10-20T00:00:00Z") },
      "refresh",
    );
    expect(token.accessToken).toMatch(/^access-/);
    expect(token.expiresAt.toISOString()).toBe("2026-10-20T01:00:00.000Z");
  });

  it("maps invalid_grant to a reconnect-needed error and other failures to transient ones", async () => {
    const google = new FakeGoogle();
    google.refreshInvalidGrant = true;
    await expect(
      refreshAccessToken({ ...credentials, fetch: google.fetch }, "refresh"),
    ).rejects.toBeInstanceOf(GoogleInvalidGrantError);
    google.refreshInvalidGrant = false;
    google.refreshFailureStatus = 503;
    await expect(
      refreshAccessToken({ ...credentials, fetch: google.fetch }, "refresh"),
    ).rejects.toBeInstanceOf(GoogleTokenError);
  });

  it("revokes, reporting failure instead of throwing", async () => {
    const google = new FakeGoogle();
    expect(await revokeToken({ fetch: google.fetch }, "tok")).toBe(true);
    expect(google.revokedTokens).toEqual(["tok"]);
    const broken = async () => {
      throw new TypeError("fetch failed");
    };
    expect(await revokeToken({ fetch: broken as unknown as typeof fetch }, "tok")).toBe(false);
  });

  it("asks only for read access plus the app-created calendar scope", () => {
    expect(canWrite(scopesFor("read").join(" "))).toBe(false);
    expect(canWrite(scopesFor("readwrite").join(" "))).toBe(true);
    expect(scopesFor("readwrite").join(" ")).not.toMatch(/auth\/calendar(\s|$)/);
  });
});
