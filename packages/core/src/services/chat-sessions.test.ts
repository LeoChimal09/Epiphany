import { eq } from "drizzle-orm";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseHandle } from "../db/client";
import { createOwner } from "../db/domain";
import { runMigrations } from "../db/migrate";
import { actionHistory, chatSessions } from "../db/schema";
import { createTestDatabase, MIGRATIONS_FOLDER, type TestDatabase } from "../db/test-support";
import { createServices, issueOwnerPrincipal, type Principal, type Services } from "./index";

describe("durable owner conversations", () => {
  let fixture: TestDatabase;
  let handle: DatabaseHandle;
  let services: Services;
  let owner: Principal;
  let other: Principal;
  let now: Date;

  beforeEach(async () => {
    fixture = await createTestDatabase();
    handle = connectDatabase(fixture.url);
    await runMigrations(handle.pool, MIGRATIONS_FOLDER);
    now = new Date("2026-11-09T15:00:00Z");
    services = createServices(handle.db, { clock: () => now });
    const principal = async (displayName: string) => {
      const record = await createOwner(handle.db, { displayName });
      return issueOwnerPrincipal(handle.db, record.id, {
        source: "dashboard",
        audience: "private",
        initiator: "owner",
      });
    };
    owner = await principal("Fixture owner");
    other = await principal("Other fixture");
  });
  afterEach(async () => {
    await handle.close();
    await fixture.drop();
    expect(await fixture.exists()).toBe(false);
  });

  it("restores a full transcript, exact focus, and pending context after a database restart", async () => {
    const note = await services.notes.create(owner, {
      title: "Supplies",
      kind: "note",
      body: "Original",
    });
    const chat = await services.conversations.create(owner, {
      kind: "note",
      id: note.id,
      label: "idea",
      title: "Incorrect client title",
    });
    expect(chat.data.topic).toMatchObject({ label: "note", title: "Supplies" });
    const message = "- Choice with full details\n".repeat(90);
    const claimed = await services.conversations.claim(owner, chat.id, message);
    const data = {
      ...claimed.session.data,
      conversation: {
        ...claimed.session.data.conversation,
        turns: [{ role: "user" as const, text: message }],
        pendingSetting: { key: "planning.weekStart", valueJson: "1", summary: "Monday start" },
      },
      messages: [
        ...claimed.session.data.messages,
        { id: 2, role: "epi" as const, text: "Ready to review." },
      ],
    };
    await services.conversations.finish(owner, chat.id, claimed.token, data);
    await handle.close();
    handle = connectDatabase(fixture.url);
    services = createServices(handle.db, { clock: () => now });
    const restored = await services.conversations.get(owner, chat.id);
    expect(restored.data).toEqual(data);
    expect(restored.busy).toBe(false);
    await services.conversations.create(owner);
    expect(await services.conversations.list(owner)).toHaveLength(2);
    expect((await services.conversations.get(owner, chat.id)).data.messages).toHaveLength(2);
  });

  it("denies forged/shared principals and foreign sessions and focused records", async () => {
    const chat = await services.conversations.create(owner);
    const note = await services.notes.create(owner, { body: "Owner-only", kind: "idea" });
    const shared = await issueOwnerPrincipal(handle.db, owner.ownerId, {
      source: "discord",
      audience: "shared",
      initiator: "owner",
    });
    for (const principal of [{ ...owner }, shared]) {
      await expect(services.conversations.list(principal)).rejects.toThrow();
      await expect(services.conversations.create(principal)).rejects.toThrow();
    }
    expect(await services.conversations.list(other)).toEqual([]);
    await expect(services.conversations.get(other, chat.id)).rejects.toThrow();
    await expect(services.conversations.claim(other, chat.id, "hello")).rejects.toThrow();
    await expect(
      services.conversations.create(other, {
        kind: "note",
        id: note.id,
        title: "Fake",
        label: "note",
      }),
    ).rejects.toThrow();
    const turn = await services.conversations.claim(owner, chat.id, "Hello");
    await expect(
      services.conversations.finish(other, chat.id, turn.token, turn.session.data),
    ).rejects.toThrow();
  });

  it("allows only one overlapping turn and requires its exact token to finish", async () => {
    const chat = await services.conversations.create(owner);
    const results = await Promise.allSettled([
      services.conversations.claim(owner, chat.id, "First"),
      services.conversations.claim(owner, chat.id, "Second"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    const result = results.find((item) => item.status === "fulfilled")!;
    if (result.status !== "fulfilled") throw new Error("Missing winning turn");
    expect((await services.conversations.get(owner, chat.id)).data.messages).toHaveLength(1);
    await expect(
      services.conversations.finish(owner, chat.id, "wrong-token", result.value.session.data),
    ).rejects.toThrow();
    await services.conversations.finish(owner, chat.id, result.value.token, {
      ...result.value.session.data,
      messages: [...result.value.session.data.messages, { id: 2, role: "epi", text: "Finished" }],
    });
    await expect(
      services.conversations.finish(owner, chat.id, result.value.token, result.value.session.data),
    ).rejects.toThrow();
  });

  it("marks interrupted turns uncertain without replay and prevents a late result overwriting a new turn", async () => {
    const chat = await services.conversations.create(owner);
    const first = await services.conversations.claim(owner, chat.id, "Add supplies");
    expect((await services.conversations.get(owner, chat.id)).busy).toBe(true);
    now = new Date(now.getTime() + 5 * 60_000);
    const interrupted = await services.conversations.get(owner, chat.id);
    expect(interrupted.busy).toBe(false);
    expect(interrupted.data.messages.at(-1)).toMatchObject({ role: "epi", outcome: "uncertain" });
    expect((await services.conversations.get(owner, chat.id)).data.messages).toEqual(
      interrupted.data.messages,
    );
    const next = await services.conversations.claim(owner, chat.id, "Check the record first");
    expect(next.session.data.messages).toHaveLength(3);
    await expect(
      services.conversations.finish(owner, chat.id, first.token, first.session.data),
    ).rejects.toThrow();
    expect((await services.conversations.get(owner, chat.id)).data.messages.at(-1)?.text).toBe(
      "Check the record first",
    );
  });

  it("reuses an unused blank conversation instead of creating duplicates", async () => {
    const blank = await services.conversations.create(owner);
    expect((await services.conversations.create(owner)).id).toBe(blank.id);
    await services.conversations.claim(owner, blank.id, "Plan groceries");
    const fresh = await services.conversations.create(owner);
    expect(fresh.id).not.toBe(blank.id);
    expect(await services.conversations.list(owner)).toHaveLength(2);
  });

  it("deletes only the owner's idle conversation and records it", async () => {
    const chat = await services.conversations.create(owner);
    const turn = await services.conversations.claim(owner, chat.id, "Hello");
    await expect(services.conversations.remove(owner, chat.id)).rejects.toThrow();
    await expect(services.conversations.remove(other, chat.id)).rejects.toThrow();
    await services.conversations.finish(owner, chat.id, turn.token, turn.session.data);
    await services.conversations.remove(owner, chat.id);
    expect(await handle.db.select().from(chatSessions).where(eq(chatSessions.id, chat.id))).toEqual(
      [],
    );
    const [audit] = await handle.db
      .select()
      .from(actionHistory)
      .where(eq(actionHistory.action, "conversation.delete"));
    expect(audit).toMatchObject({ ownerId: owner.ownerId, entityId: chat.id });
    await expect(services.conversations.remove(owner, chat.id)).rejects.toThrow();
  });

  it("expires at ninety days and physically removes expired data on the next owner access", async () => {
    const chat = await services.conversations.create(owner);
    const foreign = await services.conversations.create(other);
    now = new Date(now.getTime() + 90 * 86_400_000);
    expect(await services.conversations.list(owner)).toEqual([]);
    expect(await handle.db.select().from(chatSessions).where(eq(chatSessions.id, chat.id))).toEqual(
      [],
    );
    expect(
      await handle.db.select().from(chatSessions).where(eq(chatSessions.id, foreign.id)),
    ).toHaveLength(1);
    await expect(services.conversations.get(owner, chat.id)).rejects.toThrow();
  });
});
