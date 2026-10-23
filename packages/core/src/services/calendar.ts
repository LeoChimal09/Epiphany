import { z } from "zod";
import type { Database } from "../db/client";
import type { CalendarRuntime } from "../calendar/access";
import { connectAccount, disconnectAccounts } from "../calendar/access";
import {
  CalendarError,
  loadBlockStates,
  loadCalendarOverview,
  selectCalendars,
  wipeAccounts,
  type BlockSyncView,
  type CalendarOverview,
} from "../calendar/store";
import type { FetchLike } from "../calendar/google/oauth";
import { resolveBlockConflict, type ConflictChoice } from "../calendar/sync";
import { AccessDeniedError, ConfirmationRequiredError, ValidationError } from "./errors";
import { authorize, decide, type ActionName } from "./permissions";
import { assertPrincipal } from "./principal";
import { idInput, parseInput } from "./schemas";

// What the calendar services need to touch tokens. Absent when Google Calendar is not configured:
// reading status and disconnecting still work (disconnecting only needs the database to delete
// tokens), but connecting and conflict resolution report that setup is missing.
export interface CalendarServiceOptions {
  tokenKey: Buffer;
  clientId: string;
  clientSecret: string;
  fetch?: FetchLike;
}

const connectInput = z
  .object({
    providerAccountId: z.string().trim().min(1).max(255),
    email: z.string().trim().max(320).nullable(),
    scopes: z.array(z.string().min(1).max(300)).min(1).max(20),
    accessToken: z.string().min(1).max(4096),
    refreshToken: z.string().min(1).max(4096).nullable(),
    accessTokenExpiresAt: z.date(),
  })
  .strict();

export interface OAuthConsent {
  // The owner completed Google's consent screen in this very request.
  oauthConsentCompleted: true;
}

export function createCalendarService(
  db: Database,
  clock: () => Date,
  options: CalendarServiceOptions | undefined,
) {
  function gate(principal: unknown, action: ActionName) {
    assertPrincipal(principal);
    authorize(principal, action);
    return {
      principal,
      actor: { ownerId: principal.ownerId, source: principal.source, now: clock() },
    };
  }

  function runtime(): CalendarRuntime {
    if (!options) {
      throw new CalendarError(
        "not_configured",
        "Google Calendar is not set up. Add GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET and TOKEN_ENCRYPTION_KEY, then restart.",
      );
    }
    return { db, now: clock, ...options };
  }

  return {
    // Connection status, calendars (with sync state), and work blocks waiting to sync. Contains
    // no tokens.
    async overview(principal: unknown): Promise<CalendarOverview> {
      const { principal: p } = gate(principal, "calendar.read");
      return loadCalendarOverview(db, p.ownerId, clock());
    },

    async blockStates(principal: unknown, limit: unknown = 50): Promise<BlockSyncView[]> {
      const { principal: p } = gate(principal, "calendar.read");
      return loadBlockStates(
        db,
        p.ownerId,
        clock(),
        parseInput(z.number().int().min(1).max(200), limit),
      );
    },

    // Stores the tokens from a completed OAuth flow. Connecting expands what Epi can access, so it
    // needs the owner's explicit consent: only the owner (never the assistant) completing Google's
    // consent screen counts.
    async connect(principal: unknown, tokens: unknown, consent?: OAuthConsent): Promise<string> {
      assertPrincipal(principal);
      const decision = decide(principal, "calendar.connect");
      if (decision.kind === "deny")
        throw new AccessDeniedError("calendar.connect", decision.reason);
      if (
        decision.kind !== "allow" &&
        (principal.initiator !== "owner" || consent?.oauthConsentCompleted !== true)
      ) {
        throw new ConfirmationRequiredError(
          "calendar.connect",
          "consent",
          "the owner must approve access on Google's consent screen",
        );
      }
      const rt = runtime();
      const input = parseInput(connectInput, tokens);
      return connectAccount(
        rt,
        { ownerId: principal.ownerId, source: principal.source, now: clock() },
        input,
      );
    },

    // Chooses which discovered calendars are read (internal IDs from `overview`).
    async select(principal: unknown, calendarIds: unknown) {
      const { actor } = gate(principal, "calendar.select");
      const ids = parseInput(z.array(idInput).max(200), calendarIds);
      try {
        return await selectCalendars(db, actor, ids);
      } catch (error) {
        if (error instanceof CalendarError) throw new ValidationError([error.message]);
        throw error;
      }
    },

    // Ends calendar access: tokens are deleted and the provider is told to revoke them (best
    // effort). Works even when Google Calendar is unconfigured, because deleting needs no key.
    async disconnect(principal: unknown) {
      const { actor } = gate(principal, "calendar.disconnect");
      if (!options) {
        const wiped = await wipeAccounts(db, actor);
        return { disconnected: wiped.length, revokedAtGoogle: false };
      }
      return disconnectAccounts({ db, tokenKey: options.tokenKey, fetch: options.fetch }, actor);
    },

    // The owner's decision for a block whose Google event was changed elsewhere.
    async resolveConflict(principal: unknown, blockId: unknown, choice: unknown) {
      const { actor } = gate(principal, "calendar.resolve_conflict");
      const id = parseInput(idInput, blockId);
      const picked = parseInput(
        z.enum(["overwrite_google", "keep_google"]),
        choice,
      ) as ConflictChoice;
      try {
        return await resolveBlockConflict(runtime(), actor, id, picked);
      } catch (error) {
        if (error instanceof CalendarError && error.code === "invalid") {
          throw new ValidationError([error.message]);
        }
        throw error;
      }
    },
  };
}
