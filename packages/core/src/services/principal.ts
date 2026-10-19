import { eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { owners, type ActionSource } from "../db/schema";
import { AccessDeniedError } from "./errors";

// private: only the owner can see the response (dashboard, DM, owner-only channel).
// shared: others may see it (any other channel); personal data is never served there.
export type Audience = "private" | "shared";
// owner: a control the owner used directly. assistant: Epi acting on the owner's conversation.
export type Initiator = "owner" | "assistant";

export interface Principal {
  readonly ownerId: string;
  readonly source: ActionSource;
  readonly audience: Audience;
  readonly initiator: Initiator;
}

// Principals are only created by issueOwnerPrincipal, so a caller cannot forge one by building
// an object with the right fields (for example from model output or pasted content).
const issued = new WeakSet<object>();

export function isPrincipal(value: unknown): value is Principal {
  return typeof value === "object" && value !== null && issued.has(value);
}

export function assertPrincipal(value: unknown): asserts value is Principal {
  if (!isPrincipal(value)) {
    throw new AccessDeniedError("access", "no authenticated owner");
  }
}

export interface PrincipalContext {
  source: ActionSource;
  audience: Audience;
  initiator: Initiator;
}

// Call only after the caller's identity has been authenticated (a validated dashboard session, or
// a Discord user ID matched to the owner). It confirms the owner exists; it does not authenticate.
export async function issueOwnerPrincipal(
  db: Database,
  ownerId: string,
  context: PrincipalContext,
): Promise<Principal> {
  const [row] = await db.select({ id: owners.id }).from(owners).where(eq(owners.id, ownerId));
  if (!row) throw new AccessDeniedError("access", "unknown owner");
  const principal: Principal = Object.freeze({ ownerId: row.id, ...context });
  issued.add(principal);
  return principal;
}

// Identity link: the linked Discord account is the owner. Anyone else gets null, never data.
export async function resolveDiscordPrincipal(
  db: Database,
  discordUserId: string,
  context: Omit<PrincipalContext, "source"> & { source?: "discord" | "voice" },
): Promise<Principal | null> {
  const [row] = await db
    .select({ id: owners.id })
    .from(owners)
    .where(eq(owners.discordUserId, discordUserId));
  if (!row) return null;
  return issueOwnerPrincipal(db, row.id, { ...context, source: context.source ?? "discord" });
}
