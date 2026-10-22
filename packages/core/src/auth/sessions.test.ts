import path from "node:path";
import { fileURLToPath } from "node:url";
import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseHandle } from "../db/client";
import { createOwner } from "../db/domain";
import { runMigrations } from "../db/migrate";
import { actionHistory, owners, sessions } from "../db/schema";
import { createTestDatabase, dbTestsEnabled, type TestDatabase } from "../db/test-support";
import { isPrincipal } from "../services/principal";
import {
  authenticateDevBypass,
  authenticateDiscordUser,
  createSession,
  destroySession,
  principalFromSession,
  purgeExpiredSessions,
  SESSION_TTL_MS,
  validateSession,
} from "./sessions";

const migrationsFolder = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));
const OWNER_DISCORD = "100000000000000001";
const identity = {
  configuredDiscordUserId: OWNER_DISCORD,
  displayName: "Owner",
  timezone: "America/Chicago",
};
const t0 = new Date("2026-10-13T15:00:00.000Z");

describe.skipIf(!dbTestsEnabled)("dashboard sessions and owner identity", () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;
  let ownerId: string;

  beforeEach(async () => {
    database = await createTestDatabase();
    handle = connectDatabase(database.url);
    await runMigrations(handle.pool, migrationsFolder);
    ownerId = (await createOwner(handle.db, { displayName: "Owner", discordUserId: OWNER_DISCORD }))
      .id;
  });

  afterEach(async () => {
    await handle.close();
    await database.drop();
    expect(await database.exists()).toBe(false);
  });

  it("stores only a hash of the token and validates it until exactly seven days later", async () => {
    const { token, expiresAt } = await createSession(handle.db, ownerId, t0);
    expect(expiresAt.getTime()).toBe(t0.getTime() + SESSION_TTL_MS);

    const rows = await handle.db.select().from(sessions);
    expect(rows).toHaveLength(1);
    expect(JSON.stringify(rows)).not.toContain(token);
    expect(rows[0]?.id).toMatch(/^[0-9a-f]{64}$/);

    expect(
      await validateSession(handle.db, token, new Date(expiresAt.getTime() - 1)),
    ).toMatchObject({ ownerId });
    expect(await validateSession(handle.db, token, expiresAt)).toBeNull();
  });

  it("gives every session a different unguessable token", async () => {
    const a = await createSession(handle.db, ownerId, t0);
    const b = await createSession(handle.db, ownerId, t0);
    expect(a.token).not.toBe(b.token);
    expect(a.token.length).toBeGreaterThanOrEqual(40);
  });

  it("rejects missing, malformed, unknown, and hash-as-token credentials", async () => {
    const { token } = await createSession(handle.db, ownerId, t0);
    const [row] = await handle.db.select().from(sessions);
    for (const bad of [undefined, "", "short", "x".repeat(300), "A".repeat(43), row!.id]) {
      expect(await validateSession(handle.db, bad, t0), String(bad).slice(0, 12)).toBeNull();
    }
    expect(await validateSession(handle.db, token, t0)).not.toBeNull();
  });

  it("ends a session on logout and purges expired ones", async () => {
    const a = await createSession(handle.db, ownerId, t0);
    const b = await createSession(handle.db, ownerId, new Date(t0.getTime() - 2 * SESSION_TTL_MS));
    await destroySession(handle.db, a.token);
    expect(await validateSession(handle.db, a.token, t0)).toBeNull();
    await destroySession(handle.db, undefined);

    expect(await handle.db.select().from(sessions)).toHaveLength(1);
    await purgeExpiredSessions(handle.db, t0);
    expect(await handle.db.select().from(sessions)).toHaveLength(0);
    expect(await validateSession(handle.db, b.token, t0)).toBeNull();
  });

  it("turns a valid session into a private, owner-initiated dashboard principal", async () => {
    const { token } = await createSession(handle.db, ownerId, t0);
    const principal = await principalFromSession(handle.db, token, t0);
    expect(isPrincipal(principal)).toBe(true);
    expect(principal).toMatchObject({
      ownerId,
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    expect(await principalFromSession(handle.db, "nope-nope-nope-nope-nope", t0)).toBeNull();
    expect(
      await principalFromSession(handle.db, token, new Date(t0.getTime() + SESSION_TTL_MS)),
    ).toBeNull();
  });

  describe("authenticateDevBypass", () => {
    const tz = "America/Chicago";
    const auditRows = async () =>
      (await handle.db.select().from(actionHistory)).filter(
        (h) => h.action === "auth.dev_bypass_sign_in",
      );

    it("maps to the real owner when a Discord owner ID is configured, so data matches a real sign-in", async () => {
      const id = await authenticateDevBypass(handle.db, {
        configuredDiscordUserId: OWNER_DISCORD,
        timezone: tz,
      });
      expect(id).toBe(ownerId);
      expect(await handle.db.select().from(owners)).toHaveLength(1);
    });

    it("creates the configured owner if none exists yet", async () => {
      for (const table of ["action_history", "categories", "owners"]) {
        await handle.pool.query(`DELETE FROM \`${table}\``);
      }
      const id = await authenticateDevBypass(handle.db, {
        configuredDiscordUserId: OWNER_DISCORD,
        timezone: tz,
      });
      const rows = await handle.db.select().from(owners);
      expect(rows).toEqual([expect.objectContaining({ id, discordUserId: OWNER_DISCORD })]);
    });

    it("uses one local 'Dev Owner' without a Discord ID, and reuses it every time", async () => {
      const a = await authenticateDevBypass(handle.db, {
        configuredDiscordUserId: null,
        timezone: tz,
      });
      const b = await authenticateDevBypass(handle.db, {
        configuredDiscordUserId: null,
        timezone: tz,
      });
      expect(a).toBe(b);
      expect(a).not.toBe(ownerId);
      const dev = (await handle.db.select().from(owners)).filter(
        (o) => o.displayName === "Dev Owner",
      );
      expect(dev).toEqual([expect.objectContaining({ id: a, discordUserId: null, timezone: tz })]);
    });

    it("never hands back a real owner's identity when no owner ID is configured", async () => {
      const id = await authenticateDevBypass(handle.db, {
        configuredDiscordUserId: null,
        timezone: tz,
      });
      expect(id).not.toBe(ownerId);
    });

    it("records an audit entry for each bypass sign-in", async () => {
      await authenticateDevBypass(handle.db, {
        configuredDiscordUserId: OWNER_DISCORD,
        timezone: tz,
      });
      await authenticateDevBypass(handle.db, {
        configuredDiscordUserId: OWNER_DISCORD,
        timezone: tz,
      });
      const rows = await auditRows();
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ source: "system", entityType: "owner", entityId: ownerId });
    });
  });

  describe("authenticateDiscordUser", () => {
    it("matches only the configured Discord account", async () => {
      expect(await authenticateDiscordUser(handle.db, OWNER_DISCORD, identity)).toBe(ownerId);
      expect(await authenticateDiscordUser(handle.db, "999999999999999999", identity)).toBeNull();
      expect(await authenticateDiscordUser(handle.db, "", identity)).toBeNull();
      expect(await handle.db.select().from(owners)).toHaveLength(1);
    });

    it("never matches an account that is not the configured owner, even if a row exists for it", async () => {
      const other = await createOwner(handle.db, {
        displayName: "Other",
        discordUserId: "300000000000000003",
      });
      expect(await authenticateDiscordUser(handle.db, "300000000000000003", identity)).toBeNull();
      expect(other.id).not.toBe(ownerId);
    });

    it("creates the owner on the first sign-in of the configured account, exactly once under a race", async () => {
      // Start with no owner at all: remove the fixture owner and its dependent rows.
      for (const table of ["action_history", "categories", "owners"]) {
        await handle.pool.query(`DELETE FROM \`${table}\``);
      }
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          authenticateDiscordUser(handle.db, OWNER_DISCORD, identity),
        ),
      );
      const rows = await handle.db
        .select()
        .from(owners)
        .where(eq(owners.discordUserId, OWNER_DISCORD));
      expect(rows).toHaveLength(1);
      expect(new Set(results)).toEqual(new Set([rows[0]!.id]));
      expect(rows[0]).toMatchObject({ displayName: "Owner", timezone: "America/Chicago" });
      const history = await handle.db
        .select()
        .from(actionHistory)
        .where(eq(actionHistory.entityId, rows[0]!.id));
      expect(history.filter((h) => h.action === "owner.create")).toHaveLength(1);
    });

    const HASH_A = "a".repeat(32);
    const HASH_B = "b".repeat(32);
    const ownerRow = async () =>
      (await handle.db.select().from(owners).where(eq(owners.id, ownerId)))[0]!;

    it("refreshes the Discord name and avatar on a later sign-in", async () => {
      await authenticateDiscordUser(handle.db, OWNER_DISCORD, {
        ...identity,
        displayName: "Leo",
        avatarHash: HASH_A,
      });
      expect(await ownerRow()).toMatchObject({ displayName: "Leo", avatarHash: HASH_A });

      await authenticateDiscordUser(handle.db, OWNER_DISCORD, {
        ...identity,
        displayName: "Leonardo",
        avatarHash: HASH_B,
      });
      expect(await ownerRow()).toMatchObject({ displayName: "Leonardo", avatarHash: HASH_B });
    });

    it("keeps the stored name when Discord sends none, and clears a removed avatar", async () => {
      await authenticateDiscordUser(handle.db, OWNER_DISCORD, {
        ...identity,
        displayName: "Leo",
        avatarHash: HASH_A,
      });
      await authenticateDiscordUser(handle.db, OWNER_DISCORD, {
        ...identity,
        displayName: null,
        avatarHash: null,
      });
      expect(await ownerRow()).toMatchObject({ displayName: "Leo", avatarHash: null });
    });

    it("leaves the stored avatar alone when the caller did not look at it", async () => {
      await authenticateDiscordUser(handle.db, OWNER_DISCORD, {
        ...identity,
        displayName: "Leo",
        avatarHash: HASH_A,
      });
      await authenticateDiscordUser(handle.db, OWNER_DISCORD, identity);
      expect(await ownerRow()).toMatchObject({ displayName: "Owner", avatarHash: HASH_A });
    });

    it("does not touch a non-owner account's record", async () => {
      const other = await createOwner(handle.db, {
        displayName: "Other",
        discordUserId: "300000000000000003",
      });
      await authenticateDiscordUser(handle.db, "300000000000000003", {
        ...identity,
        displayName: "Hijack",
        avatarHash: HASH_A,
      });
      const [row] = await handle.db.select().from(owners).where(eq(owners.id, other.id));
      expect(row).toMatchObject({ displayName: "Other", avatarHash: null });
    });
  });
});
