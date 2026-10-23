import { describe, expect, it } from "vitest";
import type { OverviewView } from "@epiphany/core/overview";
import {
  hashContent,
  syncOverviews,
  type OverviewBindingRecord,
  type OverviewStore,
  type OverviewSurface,
} from "./overview-sync";

const VIEWS: OverviewView[] = ["today", "priorities"];
const contents = (suffix = "") => ({
  today: `today text${suffix}\n-# epi:today`,
  schedule: "unused",
  priorities: `priorities text${suffix}\n-# epi:priorities`,
  "notes-and-ideas": "unused",
  "check-ins": "unused",
  "activity-log": "unused",
});

// A fake server: channels by view, messages by id, in-memory bindings, and switches for failures.
function fake() {
  const messages = new Map<string, { channelId: string; content: string; view: OverviewView }>();
  const bindings = new Map<string, OverviewBindingRecord>();
  const log: string[] = [];
  let next = 1;
  const failSave = { on: false };
  const privateViews = new Set<OverviewView>(VIEWS);

  const surface: OverviewSurface = {
    guildId: "100000000000000001",
    async channelFor(view) {
      return privateViews.has(view) ? `ch-${view}` : null;
    },
    async post(channelId, content) {
      const id = `m${next++}`;
      const view = (content.match(/epi:([a-z-]+)$/)?.[1] ?? "today") as OverviewView;
      messages.set(id, { channelId, content, view });
      log.push(`post ${id}`);
      return id;
    },
    async edit(channelId, messageId, content) {
      const existing = messages.get(messageId);
      if (!existing || existing.channelId !== channelId) return "missing";
      existing.content = content;
      log.push(`edit ${messageId}`);
      return "edited";
    },
    async findOwn(channelId, view) {
      for (const [id, message] of messages) {
        if (message.channelId === channelId && message.view === view) return id;
      }
      return null;
    },
  };
  const store: OverviewStore = {
    async get(guildId, view) {
      return bindings.get(`${guildId}/${view}`) ?? null;
    },
    async save(binding) {
      if (failSave.on) throw new Error("database down");
      bindings.set(`${binding.guildId}/${binding.viewKey}`, binding);
    },
  };
  return { surface, store, messages, bindings, log, failSave, privateViews };
}

const run = (f: ReturnType<typeof fake>, suffix = "", verify = false) =>
  syncOverviews({ surface: f.surface, store: f.store, contents: contents(suffix), verify });

describe("syncing Discord overviews", () => {
  it("posts one message per view the first time and remembers it", async () => {
    const f = fake();
    const first = await run(f);
    expect(first).toMatchObject({ today: "posted", priorities: "posted" });
    expect(f.messages.size).toBe(2);
    expect(f.bindings.get("100000000000000001/today")?.contentHash).toBe(
      hashContent(contents().today),
    );
  });

  it("does nothing at all when the records have not changed", async () => {
    const f = fake();
    await run(f);
    f.log.length = 0;
    expect(await run(f)).toMatchObject({ today: "unchanged", priorities: "unchanged" });
    expect(f.log).toEqual([]);
  });

  it("edits the same message in place when a record changed, without reposting", async () => {
    const f = fake();
    await run(f);
    const ids = [...f.messages.keys()];
    expect(await run(f, " v2")).toMatchObject({ today: "edited", priorities: "edited" });
    expect([...f.messages.keys()]).toEqual(ids);
    expect(f.messages.get(ids[0]!)?.content).toContain("v2");
  });

  it("recreates a deleted message, leaving everything else alone", async () => {
    const f = fake();
    await run(f);
    const deleted = f.bindings.get("100000000000000001/today")!.messageId;
    f.messages.delete(deleted);
    const result = await run(f, "", true);
    expect(result).toMatchObject({ today: "recreated", priorities: "unchanged" });
    expect(f.messages.size).toBe(2);
    expect(f.bindings.get("100000000000000001/today")?.messageId).not.toBe(deleted);
  });

  it("does not notice a deletion until asked to verify, then fixes it on the next content change", async () => {
    const f = fake();
    await run(f);
    f.messages.delete(f.bindings.get("100000000000000001/today")!.messageId);
    expect((await run(f)).today).toBe("unchanged");
    expect((await run(f, " v2")).today).toBe("recreated");
  });

  it("adopts an existing message after losing its binding instead of duplicating it", async () => {
    const f = fake();
    f.failSave.on = true;
    const failed = await run(f);
    expect(failed).toMatchObject({ today: "failed", priorities: "failed" });
    expect(f.messages.size).toBe(2);

    f.failSave.on = false;
    expect(await run(f)).toMatchObject({ today: "adopted", priorities: "adopted" });
    expect(f.messages.size).toBe(2);
    expect(f.bindings.size).toBe(2);
  });

  it("retries after a failure without duplicating anything", async () => {
    const f = fake();
    for (let attempt = 0; attempt < 4; attempt++) {
      f.failSave.on = attempt % 2 === 0;
      await run(f);
    }
    f.failSave.on = false;
    await run(f);
    expect(f.messages.size).toBe(2);
  });

  it("skips views whose channel is missing or not private, and keeps going", async () => {
    const f = fake();
    f.privateViews.delete("today");
    const result = await run(f);
    expect(result).toMatchObject({ today: "no_channel", priorities: "posted" });
    expect([...f.messages.values()].some((m) => m.view === "today")).toBe(false);
  });

  it("moves to the new message when the channel was recreated", async () => {
    const f = fake();
    await run(f);
    const old = f.bindings.get("100000000000000001/today")!;
    f.bindings.set("100000000000000001/today", { ...old, channelId: "old-channel" });
    const result = await run(f);
    expect(result.today).toBe("adopted");
    expect(f.bindings.get("100000000000000001/today")?.channelId).toBe("ch-today");
  });
});
