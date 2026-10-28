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
import type { Database, ActionHistoryEntry } from "@epiphany/core/db";
import { createServices, resolveDiscordPrincipal } from "@epiphany/core/services";
import { syncOverviews, type OverviewStore, type OverviewSurface } from "./overview-sync";
import { WORKSPACE_CATEGORY_NAME } from "./workspace";
import { errorDetails } from "../error-details";
import { plain } from "@epiphany/core/overview";
import { parseUpdateCursor, publishPlannerUpdates } from "./planner-updates";

const UNKNOWN_MESSAGE = 10008;
const NO_MENTIONS = { parse: [] as never[] };

function metadata(entry: ActionHistoryEntry): Record<string, unknown> {
  return entry.after && typeof entry.after === "object"
    ? (entry.after as Record<string, unknown>)
    : {};
}

function dateLabel(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    timeZone: timezone,
  }).format(value);
}

function timeLabel(value: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-US", {
    hour: "numeric",
    minute: "2-digit",
    timeZone: timezone,
  }).format(value);
}

function localDateKey(value: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: timezone,
  }).formatToParts(value);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((item) => item.type === type)?.value ?? "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

function eventTiming(after: Record<string, unknown>, ownerTimezone: string): string | null {
  if (typeof after.startsAt !== "string") return null;
  const startsAt = new Date(after.startsAt);
  if (Number.isNaN(startsAt.getTime())) return null;
  const timezone = typeof after.timezone === "string" ? after.timezone : ownerTimezone;
  if (after.allDay === true) return ` · ${dateLabel(startsAt, timezone)} (all day)`;
  if (typeof after.endsAt !== "string")
    return ` · ${dateLabel(startsAt, timezone)}, ${timeLabel(startsAt, timezone)}`;
  const endsAt = new Date(after.endsAt);
  if (Number.isNaN(endsAt.getTime())) return null;
  const date = dateLabel(startsAt, timezone);
  const endDate = dateLabel(endsAt, timezone);
  return localDateKey(startsAt, timezone) === localDateKey(endsAt, timezone)
    ? ` · ${date}, ${timeLabel(startsAt, timezone)}–${timeLabel(endsAt, timezone)}`
    : ` · ${date}, ${timeLabel(startsAt, timezone)}–${endDate}, ${timeLabel(endsAt, timezone)}`;
}

function addedItem(
  entry: ActionHistoryEntry,
  ownerTimezone: string,
): { kind: "task" | "todo" | "event"; title: string; detail: string } | null {
  const after = metadata(entry);
  if (
    (entry.action !== "task.create" && entry.action !== "event.create") ||
    (entry.entityType !== "task" && entry.entityType !== "event") ||
    typeof after.title !== "string"
  ) {
    return null;
  }
  const details: string[] = [];
  if (entry.entityType === "task") {
    if (typeof after.dueAt === "string") {
      const dueAt = new Date(after.dueAt);
      if (!Number.isNaN(dueAt.getTime())) {
        const due =
          after.dueDateOnly === true
            ? dateLabel(new Date(`${after.dueAt.slice(0, 10)}T12:00:00.000Z`), "UTC")
            : `${dateLabel(dueAt, ownerTimezone)}, ${timeLabel(dueAt, ownerTimezone)}`;
        details.push(`Due ${due}`);
      }
    }
    if (typeof after.estimatedMinutes === "number" && Number.isFinite(after.estimatedMinutes)) {
      details.push(`${after.estimatedMinutes} min`);
    }
    if (after.taskType !== "todo") {
      if (after.priority === "major") details.push("Major");
      else if (after.priority === "minor") details.push("Minor");
    }
  } else {
    const timing = eventTiming(after, ownerTimezone);
    if (timing) details.push(timing.trim().replace(/^·\s*/, ""));
  }
  return {
    kind: entry.entityType === "task" && after.taskType === "todo" ? "todo" : entry.entityType,
    title: plain(after.title.replace(/\s+/g, " ").trim().slice(0, 140)),
    detail: details.length ? ` (${details.join(" · ")})` : "",
  };
}

export function announcementText(entries: ActionHistoryEntry[], timezone = "UTC"): string {
  const onlyAdditions = entries.every((entry) =>
    ["task.create", "event.create"].includes(entry.action),
  );
  const lines = entries.flatMap((entry) => {
    const item = addedItem(entry, timezone);
    if (item)
      return [
        `• ${item.kind === "task" ? "Task" : item.kind === "todo" ? "To-do" : "Event"}: ${item.title}${item.detail}`,
      ];
    const verbs: Record<string, string> = {
      "task.update": "Updated",
      "task.complete": "Completed",
      "task.reopen": "Reopened",
      "event.cancel": "Canceled",
      "event.acknowledge": "Check-ins stopped for",
      "note.create": "Saved",
      "note.update": "Updated",
      "note.delete": "Deleted",
      "work_block.create": "Scheduled",
      "work_block.remove": "Removed",
    };
    const verb = verbs[entry.action];
    if (!verb) return [];
    const after = metadata(entry);
    const title =
      typeof after.title === "string"
        ? plain(after.title.slice(0, 140))
        : entry.entityType.replaceAll("_", " ");
    const fields = Array.isArray(after.fields)
      ? after.fields.filter((field): field is string => typeof field === "string")
      : [];
    const fieldDetail = fields.length
      ? ` (${fields.map((field) => plain(field.replace(/[A-Z]/g, (letter) => ` ${letter.toLowerCase()}`))).join(", ")})`
      : "";
    const timing =
      entry.action === "task.update"
        ? (addedItem({ ...entry, action: "task.create" }, timezone)?.detail ?? "")
        : "";
    return [
      `• ${verb} ${after.taskType === "todo" ? "to-do" : entry.entityType.replaceAll("_", " ")}: ${title}${fieldDetail}${timing}`,
    ];
  });
  if (!lines.length) return "";
  const shown = lines.slice(0, 8);
  if (lines.length > shown.length) shown.push(`• And ${lines.length - shown.length} more`);
  return `✨ ${onlyAdditions ? "Added to your planner" : "Planner updates"}:\n${shown.join("\n")}`.slice(
    0,
    1850,
  );
}

// Overview messages go only into the workspace's own channels, and only while @everyone cannot see
// them: a channel that is public, or sits outside the category, is never written to.
export function guildSurface(
  guild: Guild,
  botUserId: string,
  ownerUserId?: string,
): OverviewSurface {
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
    if (ownerUserId && !channel.permissionsFor(ownerUserId)?.has(PermissionFlagsBits.ViewChannel))
      return null;
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
    async post(channelId, content, options) {
      const message = await byId(channelId).send({
        content: options ? `<@${options.notifyUserId}> ${content}` : content,
        allowedMentions: options ? { parse: [], users: [options.notifyUserId] } : NO_MENTIONS,
        ...(options ? { nonce: options.nonce, enforceNonce: true } : {}),
      });
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

// Keeps Discord overviews current and announces new tasks/events in the private #today channel.
// Announcement text is a fixed template over persisted history; it does not call the AI provider.
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
      const surface = guildSurface(guild, botUserId, ownerUserId);
      const channels = await Promise.all(OVERVIEW_VIEWS.map((view) => surface.channelFor(view)));
      if (!channels.some(Boolean)) {
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
      const todayChannel = channels[OVERVIEW_VIEWS.indexOf("today")];
      if (todayChannel) {
        try {
          const key = `discord.updates.${guild.id}`;
          const cursor = parseUpdateCursor((await services.preferences.get(principal, key))?.value);
          await publishPlannerUpdates({
            cursor,
            now: clock(),
            read: (since, seen) => services.history.changes(principal, since, seen),
            render: async (entries) => {
              const hydrated = await Promise.all(
                entries.map(async (entry) => {
                  let record;
                  try {
                    record =
                      entry.entityType === "task"
                        ? await services.tasks.get(principal, entry.entityId!)
                        : entry.entityType === "event"
                          ? await services.events.get(principal, entry.entityId!)
                          : entry.entityType === "note"
                            ? await services.notes.get(principal, entry.entityId!)
                            : entry.entityType === "work_block"
                              ? await services.workBlocks.get(principal, entry.entityId!)
                              : null;
                  } catch (error) {
                    if (!(error instanceof Error) || error.name !== "NotFoundError") throw error;
                  }
                  return {
                    ...entry,
                    after: {
                      ...metadata(entry),
                      ...(record
                        ? {
                            title: record.title ?? "Untitled",
                            ...("taskType" in record
                              ? {
                                  taskType: record.taskType,
                                  priority: record.priority,
                                  dueAt: record.dueAt?.toISOString() ?? null,
                                  dueDateOnly: record.dueDateOnly,
                                  estimatedMinutes: record.estimatedMinutes,
                                }
                              : {}),
                            ...("timezone" in record
                              ? {
                                  startsAt: record.startsAt.toISOString(),
                                  endsAt: record.endsAt.toISOString(),
                                  timezone: record.timezone,
                                  allDay: record.allDay,
                                }
                              : {}),
                          }
                        : {}),
                    },
                  };
                }),
              );
              return announcementText(hydrated, timezone);
            },
            post: async (content, nonce) => {
              await surface.post(todayChannel, content, { notifyUserId: ownerUserId, nonce });
            },
            save: async (value) => {
              await services.preferences.set(principal, { key, value, status: "confirmed" });
            },
          });
        } catch (error) {
          log("planner_notice_failed", { guildId: guild.id, ...errorDetails(error) });
        }
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
          log("overview_sync_failed", errorDetails(error));
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
