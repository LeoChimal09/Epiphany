import { describe, expect, it, vi } from "vitest";
import type { ActionHistoryEntry } from "@epiphany/core/db";
import { publishPlannerUpdates, type UpdateCursor } from "./planner-updates";

const now = new Date("2026-10-28T15:00:00Z");
const entry = (id: string, createdAt = now) => ({ id, createdAt }) as ActionHistoryEntry;

describe("visible planner updates", () => {
  function fixture(cursor: UpdateCursor | null = null) {
    const entries: ActionHistoryEntry[] = [];
    const post = vi.fn().mockResolvedValue(undefined);
    const read = vi.fn(async (_since: string, seen: string[]) =>
      entries.filter((item) => !seen.includes(item.id)),
    );
    const save = vi.fn(async (value: UpdateCursor) => {
      cursor = value;
    });
    const run = () =>
      publishPlannerUpdates({
        cursor,
        now,
        read,
        save,
        post,
        render: async (items) => items.map((item) => item.id).join(","),
      });
    return { entries, post, read, save, run, cursor: () => cursor };
  }

  it("starts without replaying old history, then posts a new message once", async () => {
    const f = fixture();
    f.entries.push(entry("baseline"));
    await f.run();
    expect(f.post).not.toHaveBeenCalled();
    f.entries.push(entry("new"));
    await f.run();
    expect(f.post).toHaveBeenCalledTimes(1);
    expect(f.post.mock.calls[0]?.[0]).toBe("new");
    await f.run();
    expect(f.post).toHaveBeenCalledTimes(1);
  });

  it("uses the saved checkpoint after restart, including same-timestamp changes", async () => {
    const f = fixture({ through: now.toISOString(), seen: ["old"] });
    f.entries.push(entry("old"), entry("new"));
    await f.run();
    expect(f.read).toHaveBeenCalledWith(now.toISOString(), ["old"]);
    expect(f.post.mock.calls[0]?.[0]).toBe("new");
    const restarted = fixture(f.cursor());
    restarted.entries.push(...f.entries);
    await restarted.run();
    expect(restarted.post).not.toHaveBeenCalled();
  });

  it("does not advance on failure and retries with the same deduplication nonce", async () => {
    const f = fixture({ through: now.toISOString(), seen: [] });
    f.entries.push(entry("new"));
    f.post.mockRejectedValueOnce(new Error("offline"));
    await expect(f.run()).rejects.toThrow("offline");
    expect(f.save).not.toHaveBeenCalled();
    await f.run();
    expect(f.post.mock.calls[0]?.[1]).toBe(f.post.mock.calls[1]?.[1]);
    expect(f.save).toHaveBeenCalledTimes(1);
  });

  it("reuses the nonce when delivery succeeds but persisting the checkpoint fails", async () => {
    const f = fixture({ through: now.toISOString(), seen: [] });
    f.entries.push(entry("new"));
    f.save.mockRejectedValueOnce(new Error("database down"));
    await expect(f.run()).rejects.toThrow("database down");
    await f.run();
    expect(f.post.mock.calls[0]).toEqual(f.post.mock.calls[1]);
  });
});
