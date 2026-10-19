import { createHash, randomBytes } from "node:crypto";
import { and, asc, eq, gt, isNull, lte } from "drizzle-orm";
import type { Database } from "../db/client";
import { ensureInbox, newId } from "../db/domain";
import { actionHistory, owners, sessions } from "../db/schema";
import { issueOwnerPrincipal, type Principal } from "../services/principal";

export const SESSION_TTL_MS = 7 * 24 * 60 * 60 * 1000;

const hashToken = (token: string) => createHash("sha256").update(token).digest("hex");

export interface CreatedSession {
  token: string;
  expiresAt: Date;
}

// The token is returned once, for the cookie. Only its hash is stored.
export async function createSession(
  db: Database,
  ownerId: string,
  now: Date = new Date(),
): Promise<CreatedSession> {
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + SESSION_TTL_MS);
  await db.insert(sessions).values({ id: hashToken(token), ownerId, expiresAt, createdAt: now });
  return { token, expiresAt };
}

export async function validateSession(
  db: Database,
  token: string | undefined,
  now: Date = new Date(),
): Promise<{ ownerId: string; expiresAt: Date } | null> {
  if (!token || token.length < 20 || token.length > 200) return null;
  const [row] = await db
    .select({ ownerId: sessions.ownerId, expiresAt: sessions.expiresAt })
    .from(sessions)
    .where(and(eq(sessions.id, hashToken(token)), gt(sessions.expiresAt, now)));
  return row ?? null;
}

export async function destroySession(db: Database, token: string | undefined): Promise<void> {
  if (!token) return;
  await db.delete(sessions).where(eq(sessions.id, hashToken(token)));
}

export async function purgeExpiredSessions(db: Database, now: Date = new Date()): Promise<void> {
  await db.delete(sessions).where(lte(sessions.expiresAt, now));
}

// The dashboard's authority: a valid session becomes a private, owner-initiated principal.
export async function principalFromSession(
  db: Database,
  token: string | undefined,
  now: Date = new Date(),
): Promise<Principal | null> {
  const session = await validateSession(db, token, now);
  if (!session) return null;
  return issueOwnerPrincipal(db, session.ownerId, {
    source: "dashboard",
    audience: "private",
    initiator: "owner",
  });
}

export interface OwnerIdentity {
  // The Discord account configured as the owner (OWNER_DISCORD_USER_ID).
  configuredDiscordUserId: string;
  displayName: string;
  timezone: string;
}

// Maps an authenticated Discord account to the owner, or null. Only the configured owner
// account can ever match: the first successful sign-in creates the owner record for it.
export async function authenticateDiscordUser(
  db: Database,
  discordUserId: string,
  identity: OwnerIdentity,
): Promise<string | null> {
  if (discordUserId !== identity.configuredDiscordUserId) return null;

  const [existing] = await db
    .select({ id: owners.id })
    .from(owners)
    .where(eq(owners.discordUserId, discordUserId));
  if (existing) return existing.id;

  const id = newId();
  try {
    await db.transaction(async (tx) => {
      await tx.insert(owners).values({
        id,
        displayName: identity.displayName,
        timezone: identity.timezone,
        discordUserId,
      });
      await ensureInbox(tx, id);
      await tx.insert(actionHistory).values({
        id: newId(),
        ownerId: id,
        source: "system",
        action: "owner.create",
        entityType: "owner",
        entityId: id,
      });
    });
    return id;
  } catch (error) {
    // A concurrent first sign-in created the owner between our check and insert.
    const [created] = await db
      .select({ id: owners.id })
      .from(owners)
      .where(eq(owners.discordUserId, discordUserId));
    if (created) return created.id;
    throw error;
  }
}

const DEV_OWNER_NAME = "Dev Owner";

// Development bypass: resolves the owner without Discord. With a configured Discord owner ID it
// maps to that same owner, so the data matches a real sign-in; otherwise it uses (or creates) a
// local "Dev Owner". Records an audit entry. Callers must have already verified the bypass is on.
export async function authenticateDevBypass(
  db: Database,
  options: { configuredDiscordUserId: string | null; timezone: string },
): Promise<string> {
  let ownerId: string | null;

  if (options.configuredDiscordUserId) {
    ownerId = await authenticateDiscordUser(db, options.configuredDiscordUserId, {
      configuredDiscordUserId: options.configuredDiscordUserId,
      displayName: DEV_OWNER_NAME,
      timezone: options.timezone,
    });
  } else {
    const [existing] = await db
      .select({ id: owners.id })
      .from(owners)
      .where(and(isNull(owners.discordUserId), eq(owners.displayName, DEV_OWNER_NAME)))
      .orderBy(asc(owners.createdAt))
      .limit(1);
    if (existing) {
      ownerId = existing.id;
    } else {
      ownerId = newId();
      const newOwnerId = ownerId;
      await db.transaction(async (tx) => {
        await tx.insert(owners).values({
          id: newOwnerId,
          displayName: DEV_OWNER_NAME,
          timezone: options.timezone,
          discordUserId: null,
        });
        await ensureInbox(tx, newOwnerId);
      });
    }
  }
  if (!ownerId) throw new Error("Could not resolve the development owner.");

  await db.insert(actionHistory).values({
    id: newId(),
    ownerId,
    source: "system",
    action: "auth.dev_bypass_sign_in",
    entityType: "owner",
    entityId: ownerId,
  });
  return ownerId;
}
