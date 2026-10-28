import type { ActionHistoryEntry } from "@epiphany/core/db";
import { hashContent } from "./overview-sync";

export interface UpdateCursor {
  through: string;
  seen: string[];
}

export function parseUpdateCursor(value: unknown): UpdateCursor | null {
  if (!value || typeof value !== "object") return null;
  const cursor = value as UpdateCursor;
  return typeof cursor.through === "string" &&
    Number.isFinite(Date.parse(cursor.through)) &&
    Array.isArray(cursor.seen) &&
    cursor.seen.every((id) => typeof id === "string")
    ? cursor
    : null;
}

// Persist the checkpoint only after delivery. A deterministic Discord nonce covers a retry
// after delivery succeeded but saving the checkpoint failed.
export async function publishPlannerUpdates(options: {
  cursor: UpdateCursor | null;
  now: Date;
  read: (since: string, seen: string[]) => Promise<ActionHistoryEntry[]>;
  render: (entries: ActionHistoryEntry[]) => Promise<string>;
  post: (content: string, nonce: string) => Promise<void>;
  save: (cursor: UpdateCursor) => Promise<void>;
}): Promise<void> {
  if (!options.cursor) {
    const through = options.now.toISOString();
    const entries = await options.read(through, []);
    await options.save({
      through,
      seen: entries
        .filter((entry) => entry.createdAt.toISOString() === through)
        .map((entry) => entry.id),
    });
    return;
  }
  const { cursor } = options;
  const entries = (await options.read(cursor.through, cursor.seen)).filter(
    (entry) => entry.createdAt.toISOString() > cursor.through || !cursor.seen.includes(entry.id),
  );
  if (!entries.length) return;
  const content = await options.render(entries);
  if (content)
    await options.post(
      content,
      hashContent(entries.map((entry) => entry.id).join(":")).slice(0, 24),
    );
  const through = entries.at(-1)!.createdAt.toISOString();
  await options.save({
    through,
    seen: [
      ...(through === cursor.through ? cursor.seen : []),
      ...entries
        .filter((entry) => entry.createdAt.toISOString() === through)
        .map((entry) => entry.id),
    ],
  });
}
