import { createHash } from "node:crypto";
import type { OverviewView } from "@epiphany/core/overview";

export interface OverviewBindingRecord {
  guildId: string;
  viewKey: string;
  channelId: string;
  messageId: string;
  contentHash: string;
}

// The few Discord operations an overview needs, so the logic can be tested without Discord.
export interface OverviewSurface {
  guildId: string;
  // The id of the view's channel, or null when it does not exist or is not private.
  channelFor(view: OverviewView): Promise<string | null>;
  post(
    channelId: string,
    content: string,
    options?: { notifyUserId: string; nonce: string },
  ): Promise<string>;
  edit(channelId: string, messageId: string, content: string): Promise<"edited" | "missing">;
  // An earlier message of Epi's for this view (found by its marker), for example one whose
  // binding was lost, so it is reused instead of duplicated.
  findOwn(channelId: string, view: OverviewView): Promise<string | null>;
}

export interface OverviewStore {
  get(guildId: string, view: OverviewView): Promise<OverviewBindingRecord | null>;
  save(binding: OverviewBindingRecord): Promise<void>;
}

export type ViewResult =
  "unchanged" | "edited" | "posted" | "adopted" | "recreated" | "no_channel" | "failed";

export const hashContent = (content: string) => createHash("sha256").update(content).digest("hex");

export interface SyncOptions {
  surface: OverviewSurface;
  store: OverviewStore;
  contents: Readonly<Record<OverviewView, string>>;
  // Also confirm that an unchanged message still exists (after a delete, or at start-up).
  verify?: boolean;
}

// Brings one server's overview messages in line with the current records. Each view has exactly
// one message: it is edited when the content changed, recreated if it was deleted (the records
// are never touched), and an orphaned message from a lost binding is adopted, not duplicated. A
// failure in one view does not stop the others, and running it again is always safe.
export async function syncOverviews(
  options: SyncOptions,
): Promise<Record<OverviewView, ViewResult>> {
  const { surface, store, contents } = options;
  const results = {} as Record<OverviewView, ViewResult>;

  for (const view of Object.keys(contents) as OverviewView[]) {
    try {
      results[view] = await syncOne(view);
    } catch {
      results[view] = "failed";
    }
  }
  return results;

  async function syncOne(view: OverviewView): Promise<ViewResult> {
    const channelId = await surface.channelFor(view);
    if (!channelId) return "no_channel";
    const content = contents[view];
    const contentHash = hashContent(content);
    const binding = await store.get(surface.guildId, view);
    const bound = binding && binding.channelId === channelId ? binding : null;

    if (bound) {
      if (bound.contentHash === contentHash && !options.verify) return "unchanged";
      const outcome = await surface.edit(channelId, bound.messageId, content);
      if (outcome === "edited") {
        if (bound.contentHash === contentHash) return "unchanged";
        await save(view, channelId, bound.messageId, contentHash);
        return "edited";
      }
    }

    const existing = await surface.findOwn(channelId, view);
    if (existing && (await surface.edit(channelId, existing, content)) === "edited") {
      await save(view, channelId, existing, contentHash);
      return "adopted";
    }
    const messageId = await surface.post(channelId, content);
    await save(view, channelId, messageId, contentHash);
    return bound ? "recreated" : "posted";
  }

  function save(view: OverviewView, channelId: string, messageId: string, contentHash: string) {
    return store.save({
      guildId: surface.guildId,
      viewKey: view,
      channelId,
      messageId,
      contentHash,
    });
  }
}
