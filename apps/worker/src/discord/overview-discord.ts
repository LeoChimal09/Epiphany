import {
  ChannelType,
  DiscordAPIError,
  PermissionFlagsBits,
  type Client,
  type Guild,
  type TextChannel,
} from "discord.js";
import { loadOverviewData, marker, OVERVIEW_VIEWS, renderOverview } from "@epiphany/core/overview";
import type { OverviewView } from "@epiphany/core/overview";
import type { Database } from "@epiphany/core/db";
import { createServices, resolveDiscordPrincipal } from "@epiphany/core/services";
import { syncOverviews, type OverviewStore, type OverviewSurface } from "./overview-sync";
import { WORKSPACE_CATEGORY_NAME } from "./workspace";

const UNKNOWN_MESSAGE = 10008;
const NO_MENTIONS = { parse: [] as never[] };

// Overview messages go only into the workspace's own channels, and only while @everyone cannot see
// them: a channel that is public, or sits outside the category, is never written to.
export function guildSurface(guild: Guild, botUserId: string): OverviewSurface {
  const channelOf = (view: OverviewView): TextChannel | null => {
    const channel = guild.channels.cache.find(
      (candidate): candidate is TextChannel =>
        candidate.type === ChannelType.GuildText &&
        candidate.name === view &&
        candidate.parent?.name.toLowerCase() === WORKSPACE_CATEGORY_NAME,
    );
    if (!channel) return null;
    const everyoneCanView = channel
      .permissionsFor(guild.roles.everyone)
      ?.has(PermissionFlagsBits.ViewChannel);
    return everyoneCanView === false ? channel : null;
  };
  const byId = (channelId: string): TextChannel => {
    const channel = guild.channels.cache.get(channelId);
    if (!channel || channel.type !== ChannelType.GuildText) throw new Error("channel unavailable");
    return channel;
  };

  return {
    guildId: guild.id,
    async channelFor(view) {
      return channelOf(view)?.id ?? null;
    },
    async post(channelId, content) {
      const message = await byId(channelId).send({ content, allowedMentions: NO_MENTIONS });
      return message.id;
    },
    async edit(channelId, messageId, content) {
      try {
        const message = await byId(channelId).messages.fetch(messageId);
        if (message.author.id !== botUserId) return "missing";
        if (message.content !== content) {
          await message.edit({ content, allowedMentions: NO_MENTIONS });
        }
        return "edited";
      } catch (error) {
        if (error instanceof DiscordAPIError && Number(error.code) === UNKNOWN_MESSAGE) {
          return "missing";
        }
        throw error;
      }
    },
    async findOwn(channelId, view) {
      const recent = await byId(channelId).messages.fetch({ limit: 50 });
      const own = recent.find(
        (message) => message.author.id === botUserId && message.content.endsWith(marker(view)),
      );
      return own?.id ?? null;
    },
  };
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), service: "discord", event, ...fields }),
  );
}

export interface OverviewSync {
  // Brings every overview up to date now. Calls made while a run is in progress are folded into
  // one follow-up run, so a burst of changes never runs in parallel or piles up.
  run(options?: { verify?: boolean }): Promise<void>;
  start(intervalMs: number): void;
  stop(): void;
}

// Keeps the Discord overviews in step with the database. The dashboard and Discord both write to
// the same records, so one comparison (rendered text against what was last posted) covers a change
// from either side; nothing is posted when nothing changed.
export function createOverviewSync(options: {
  client: Client;
  db: Database;
  ownerUserId: string;
  timezone: string;
  clock?: () => Date;
}): OverviewSync {
  const { client, db, ownerUserId, timezone } = options;
  const clock = options.clock ?? (() => new Date());
  let running = false;
  let queued: { verify: boolean } | null = null;
  let timer: ReturnType<typeof setInterval> | undefined;
  const memberOf = new Set<string>();

  async function once(verify: boolean): Promise<void> {
    const botUserId = client.user?.id;
    if (!botUserId) return;
    const principal = await resolveDiscordPrincipal(db, ownerUserId, {
      audience: "private",
      initiator: "assistant",
    });
    if (!principal) return;

    const services = createServices(db, { clock });
    const store: OverviewStore = {
      get: (guildId, view) => services.overviews.get(principal, guildId, view),
      save: (binding) => services.overviews.save(principal, binding),
    };

    let contents: Record<OverviewView, string> | null = null;
    for (const guild of client.guilds.cache.values()) {
      if (!memberOf.has(guild.id)) {
        try {
          await guild.members.fetch(ownerUserId);
          memberOf.add(guild.id);
        } catch {
          continue;
        }
      }
      const surface = guildSurface(guild, botUserId);
      if (
        !(await Promise.all(OVERVIEW_VIEWS.map((view) => surface.channelFor(view)))).some(Boolean)
      ) {
        continue;
      }
      if (!contents) {
        const data = await loadOverviewData(services, principal, clock(), timezone);
        contents = Object.fromEntries(
          OVERVIEW_VIEWS.map((view) => [view, renderOverview(view, data)]),
        ) as Record<OverviewView, string>;
      }
      const results = await syncOverviews({ surface, store, contents, verify });
      const changed = Object.entries(results).filter(([, result]) => result !== "unchanged");
      if (changed.length > 0) {
        log("overview_sync", { guildId: guild.id, results: Object.fromEntries(changed) });
      }
    }
  }

  async function run(runOptions: { verify?: boolean } = {}): Promise<void> {
    if (running) {
      queued = { verify: (queued?.verify ?? false) || (runOptions.verify ?? false) };
      return;
    }
    running = true;
    try {
      let next: { verify: boolean } | null = { verify: runOptions.verify ?? false };
      while (next) {
        queued = null;
        try {
          await once(next.verify);
        } catch (error) {
          log("overview_sync_failed", { error: error instanceof Error ? error.name : "unknown" });
        }
        next = queued;
      }
    } finally {
      running = false;
    }
  }

  return {
    run,
    start(intervalMs) {
      timer ??= setInterval(() => void run(), intervalMs);
      timer.unref();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}
