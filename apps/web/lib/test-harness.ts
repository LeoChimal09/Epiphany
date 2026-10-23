import { connectDatabase, type DatabaseHandle } from "@epiphany/core/db";
import type { AuthConfig } from "@epiphany/core";
import { runMigrations } from "@epiphany/core/db/migrate";
import { createSession } from "@epiphany/core/auth";
import { createOwner } from "@epiphany/core/db";
import { createTestDatabase, MIGRATIONS_FOLDER, type TestDatabase } from "@epiphany/core/testing";
import type { AuthDeps } from "./auth/handlers";
import type { DiscordClient } from "./auth/discord";

export const OWNER_DISCORD_ID = "100000000000000001";
export const STRANGER_DISCORD_ID = "999999999999999999";

export const baseConfig: AuthConfig = {
  discordClientId: "123456789012345678",
  discordClientSecret: "placeholder-client-secret",
  ownerDiscordUserId: OWNER_DISCORD_ID,
  appUrl: "http://localhost:3000",
  secureCookies: false,
  timezone: "America/Chicago",
  devBypass: false,
};

export interface FakeDiscord extends DiscordClient {
  exchanges: Array<{ code: string; verifier: string }>;
  revoked: number;
  // The Discord account the next exchange will report.
  signInAs: string | Error;
  // The name and avatar hash the next exchange will report.
  profile: { displayName: string | null; avatarHash: string | null };
}

export function fakeDiscord(): FakeDiscord {
  let counter = 0;
  const fake: FakeDiscord = {
    exchanges: [],
    revoked: 0,
    signInAs: OWNER_DISCORD_ID,
    profile: { displayName: null, avatarHash: null },
    newState: () => `state-${++counter}`,
    newVerifier: () => `verifier-${counter}`,
    authorizationUrl: (state) => new URL(`https://discord.example/authorize?state=${state}`),
    async exchange(code, verifier) {
      fake.exchanges.push({ code, verifier });
      if (fake.signInAs instanceof Error) throw fake.signInAs;
      return {
        userId: fake.signInAs,
        displayName: fake.profile.displayName,
        avatarHash: fake.profile.avatarHash,
        revoke: async () => {
          fake.revoked++;
        },
      };
    },
  };
  return fake;
}

export interface Harness {
  database: TestDatabase;
  handle: DatabaseHandle;
  deps: AuthDeps;
  discord: FakeDiscord;
  now: { current: Date };
  ownerId: string;
  setCookie: (token: string) => string;
  sessionFor: (ownerId: string) => Promise<string>;
  close: () => Promise<void>;
}

export async function createHarness(config: Partial<AuthConfig> = {}): Promise<Harness> {
  const database = await createTestDatabase();
  const handle = connectDatabase(database.url);
  await runMigrations(handle.pool, MIGRATIONS_FOLDER);
  const owner = await createOwner(handle.db, {
    displayName: "Owner",
    discordUserId: OWNER_DISCORD_ID,
  });
  const discord = fakeDiscord();
  const now = { current: new Date("2026-10-13T15:00:00.000Z") };
  const fullConfig = { ...baseConfig, ...config };
  const cookieName = fullConfig.secureCookies ? "__Host-epiphany_session" : "epiphany_session";

  return {
    database,
    handle,
    discord,
    now,
    ownerId: owner.id,
    deps: { db: handle.db, config: fullConfig, discord, clock: () => now.current },
    setCookie: (token) => `${cookieName}=${token}`,
    sessionFor: async (ownerId) => (await createSession(handle.db, ownerId, now.current)).token,
    async close() {
      await handle.close();
      await database.drop();
      if (await database.exists())
        throw new Error(`test database ${database.name} was not dropped`);
    },
  };
}
