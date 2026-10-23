import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FakeGoogle } from "../calendar/fake-google";
import { scopesFor } from "../calendar/google/oauth";
import { connectDatabase, type DatabaseHandle } from "../db/client";
import { createOwner } from "../db/domain";
import { runMigrations } from "../db/migrate";
import {
  createTestDatabase,
  dbTestsEnabled,
  MIGRATIONS_FOLDER,
  type TestDatabase,
} from "../db/test-support";
import {
  AccessDeniedError,
  CalendarError,
  ConfirmationRequiredError,
  createServices,
  issueOwnerPrincipal,
  ValidationError,
  type Principal,
} from "./index";

const NOW = new Date("2026-10-20T15:00:00.000Z");

describe.skipIf(!dbTestsEnabled)("calendar services", () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;
  let ownerId: string;
  let otherId: string;
  const google = new FakeGoogle();

  const principal = (id: string, over: Partial<Parameters<typeof issueOwnerPrincipal>[2]> = {}) =>
    issueOwnerPrincipal(handle.db, id, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
      ...over,
    });
  const make = (configured = true) =>
    createServices(handle.db, {
      clock: () => NOW,
      ...(configured
        ? {
            calendar: {
              tokenKey: randomBytes(32),
              clientId: "client-id",
              clientSecret: "placeholder-client-secret",
              fetch: google.fetch,
            },
          }
        : {}),
    });
  const tokens = (sub = "sub-1") => ({
    providerAccountId: sub,
    email: "owner@example.test",
    scopes: scopesFor("readwrite"),
    accessToken: "access-token-value",
    refreshToken: "refresh-token-value",
    accessTokenExpiresAt: new Date(NOW.getTime() + 3600_000),
  });
  const consent = { oauthConsentCompleted: true } as const;

  beforeAll(async () => {
    database = await createTestDatabase();
    handle = connectDatabase(database.url);
    await runMigrations(handle.pool, MIGRATIONS_FOLDER);
  });
  afterAll(async () => {
    await handle.close();
    await database.drop();
    expect(await database.exists()).toBe(false);
  });
  beforeEach(async () => {
    for (const table of [
      "calendar_event_refs",
      "synced_calendars",
      "calendar_accounts",
      "action_history",
      "categories",
      "owners",
    ]) {
      await handle.pool.query(`DELETE FROM \`${table}\``);
    }
    ownerId = (await createOwner(handle.db, { displayName: "Owner" })).id;
    otherId = (await createOwner(handle.db, { displayName: "Other" })).id;
    google.revokedTokens.length = 0;
  });

  it("requires the owner's consent to connect: advice, shared channels, and forgeries are refused", async () => {
    const services = make();
    const owner = await principal(ownerId);
    await expect(services.calendar.connect(owner, tokens())).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    const assistant = await principal(ownerId, { initiator: "assistant", source: "discord" });
    await expect(services.calendar.connect(assistant, tokens(), consent)).rejects.toBeInstanceOf(
      ConfirmationRequiredError,
    );
    const shared = await principal(ownerId, { audience: "shared" });
    await expect(services.calendar.connect(shared, tokens(), consent)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    const forged = { ownerId, source: "dashboard", audience: "private", initiator: "owner" };
    await expect(services.calendar.connect(forged, tokens(), consent)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    await expect(services.calendar.overview(forged)).rejects.toBeInstanceOf(AccessDeniedError);
    expect(
      (await handle.pool.query("SELECT id FROM calendar_accounts"))[0] as unknown[],
    ).toHaveLength(0);

    await services.calendar.connect(owner, tokens(), consent);
    expect((await services.calendar.overview(owner)).account).toMatchObject({
      status: "connected",
      canWrite: true,
    });
  });

  it("fails closed with an actionable message when Google is not configured", async () => {
    const services = make(false);
    const owner = await principal(ownerId);
    await expect(services.calendar.connect(owner, tokens(), consent)).rejects.toMatchObject({
      code: "not_configured",
      message: expect.stringContaining("TOKEN_ENCRYPTION_KEY"),
    });
    expect((await services.calendar.overview(owner)).account).toBeNull();
  });

  it("never returns token material, and shared audiences see nothing", async () => {
    const services = make();
    const owner = await principal(ownerId);
    await services.calendar.connect(owner, tokens(), consent);
    const text = JSON.stringify(await services.calendar.overview(owner));
    expect(text).not.toMatch(/token|v1\.|access-token-value|refresh-token-value/i);
    const shared = await principal(ownerId, { audience: "shared" });
    await expect(services.calendar.overview(shared)).rejects.toBeInstanceOf(AccessDeniedError);
  });

  it("keeps each owner's connection private", async () => {
    const services = make();
    const owner = await principal(ownerId);
    const other = await principal(otherId);
    await services.calendar.connect(owner, tokens(), consent);
    expect((await services.calendar.overview(other)).account).toBeNull();
    await services.calendar.disconnect(other);
    expect((await services.calendar.overview(owner)).account?.status).toBe("connected");
    await expect(services.calendar.select(other, [])).resolves.toEqual({
      selected: 0,
      deselected: 0,
    });
    await expect(
      services.calendar.resolveConflict(
        other,
        "00000000-0000-4000-8000-000000000000",
        "keep_google",
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("validates calendar selection input", async () => {
    const services = make();
    const owner = await principal(ownerId);
    await expect(services.calendar.select(owner, ["not-an-id"])).rejects.toBeInstanceOf(
      ValidationError,
    );
    await expect(
      services.calendar.select(owner, ["00000000-0000-4000-8000-000000000000"]),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it("disconnects: revokes at Google, deletes the tokens, and records history", async () => {
    const services = make();
    const owner = await principal(ownerId);
    await services.calendar.connect(owner, tokens(), consent);
    const result = await services.calendar.disconnect(owner);
    expect(result).toEqual({ disconnected: 1, revokedAtGoogle: true });
    expect(google.revokedTokens).toEqual(["refresh-token-value"]);
    const [rows] = await handle.pool.query(
      "SELECT status, access_token_enc, refresh_token_enc FROM calendar_accounts",
    );
    expect(rows).toEqual([{ status: "revoked", access_token_enc: null, refresh_token_enc: null }]);
    const [history] = await handle.pool.query(
      "SELECT action FROM action_history WHERE action LIKE 'calendar.%' ORDER BY created_at, action",
    );
    expect((history as Array<{ action: string }>).map((h) => h.action).sort()).toEqual([
      "calendar.connect",
      "calendar.disconnect",
    ]);
    expect((await services.calendar.overview(owner)).account?.status).toBe("revoked");
    // Repeating is harmless.
    expect(await services.calendar.disconnect(owner)).toEqual({
      disconnected: 0,
      revokedAtGoogle: true,
    });
  });

  it("can still disconnect (deleting tokens) when Google settings were removed", async () => {
    const configured = make();
    const owner = await principal(ownerId);
    await configured.calendar.connect(owner, tokens(), consent);
    const result = await make(false).calendar.disconnect(owner);
    expect(result.disconnected).toBe(1);
    const [rows] = await handle.pool.query(
      "SELECT status, refresh_token_enc FROM calendar_accounts",
    );
    expect(rows).toEqual([{ status: "revoked", refresh_token_enc: null }]);
  });

  it("reports calendar errors as typed errors", () => {
    expect(new CalendarError("invalid", "x").code).toBe("invalid");
  });

  it("does not let the assistant resolve a calendar conflict without explicit scheduling intent", async () => {
    const services = make();
    const assistant: Principal = await principal(ownerId, {
      initiator: "assistant",
      source: "discord",
    });
    await expect(
      services.calendar.resolveConflict(
        assistant,
        "00000000-0000-4000-8000-000000000000",
        "overwrite_google",
      ),
    ).rejects.toBeInstanceOf(AccessDeniedError);
  });
});
