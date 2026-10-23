import {
  ChannelType,
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits,
  type Client,
  type Guild,
} from "discord.js";
import type { Principal } from "@epiphany/core/services";
import type { WorkspaceCapability } from "@epiphany/core/assistant";
import {
  autoSetupWorkspace,
  offerWorkspace,
  type OfferPort,
  type OfferResult,
  type SetupPort,
} from "./offer";
import {
  applyWorkspacePlan,
  planEpiphanyWorkspace,
  WorkspaceCreateError,
  type ExistingWorkspaceChannel,
  type WorkspaceGuildPort,
  type WorkspacePermissionName,
} from "./workspace";

const FLAGS: Record<WorkspacePermissionName, bigint> = {
  viewChannel: PermissionFlagsBits.ViewChannel,
  sendMessages: PermissionFlagsBits.SendMessages,
  readMessageHistory: PermissionFlagsBits.ReadMessageHistory,
  manageChannels: PermissionFlagsBits.ManageChannels,
};

// Discord error codes for "Missing Access" and "Missing Permissions".
const MISSING_PERMISSION_CODES = new Set([50001, 50013]);

export function guildPort(
  guild: Guild,
  ownerUserId: string,
  botUserId: string,
): WorkspaceGuildPort {
  const subjects = { everyone: guild.roles.everyone.id, owner: ownerUserId, bot: botUserId };
  return {
    name: guild.name,

    async listChannels() {
      const fetched = await guild.channels.fetch();
      const channels: ExistingWorkspaceChannel[] = [];
      for (const channel of fetched.values()) {
        if (!channel) continue;
        if (channel.type === ChannelType.GuildCategory) {
          channels.push({ id: channel.id, name: channel.name, kind: "category", parentId: null });
        } else if (channel.type === ChannelType.GuildText) {
          channels.push({
            id: channel.id,
            name: channel.name,
            kind: "text",
            parentId: channel.parentId,
          });
        }
      }
      return channels;
    },

    async createChannel(spec) {
      try {
        const channel = await guild.channels.create({
          name: spec.name,
          type: spec.kind === "category" ? ChannelType.GuildCategory : ChannelType.GuildText,
          ...(spec.parentId ? { parent: spec.parentId } : {}),
          permissionOverwrites: spec.overwrites.map((entry) => ({
            id: subjects[entry.subject],
            type: entry.subject === "everyone" ? OverwriteType.Role : OverwriteType.Member,
            allow: entry.allow.map((name) => FLAGS[name]),
            deny: entry.deny.map((name) => FLAGS[name]),
          })),
          reason: "Epiphany workspace setup",
        });
        return { id: channel.id };
      } catch (error) {
        const missing =
          error instanceof DiscordAPIError && MISSING_PERMISSION_CODES.has(Number(error.code));
        throw new WorkspaceCreateError(missing ? "missing_permissions" : "failed");
      }
    },
  };
}

export function offerPort(
  client: Client,
  guild: Guild,
  ownerUserId: string,
  botUserId: string,
): OfferPort {
  return {
    async ownerIsMember() {
      try {
        await guild.members.fetch(ownerUserId);
        return true;
      } catch {
        return false;
      }
    },
    async missingResources() {
      const plan = planEpiphanyWorkspace(
        await guildPort(guild, ownerUserId, botUserId).listChannels(),
      );
      return plan.actions.length;
    },
    async alreadyOffered() {
      const owner = await client.users.fetch(ownerUserId);
      const dm = await owner.createDM();
      const recent = await dm.messages.fetch({ limit: 50 });
      return recent.some(
        (message) => message.author.id === botUserId && message.content.includes(`"${guild.name}"`),
      );
    },
    async sendOffer(text) {
      const owner = await client.users.fetch(ownerUserId);
      await owner.send(text);
    },
  };
}

function log(event: string, fields: Record<string, unknown> = {}): void {
  console.log(
    JSON.stringify({ time: new Date().toISOString(), service: "discord", event, ...fields }),
  );
}

// Finds the servers Epi shares with the owner (only those: a stranger who adds Epi to their own
// server gets nothing created) and sets up the private workspace in the right one.
export function createDiscordWorkspaceCapability(
  client: Client,
  ownerUserId: string,
): WorkspaceCapability {
  return {
    async setup(_principal: Principal, server) {
      const botUserId = client.user?.id;
      if (!botUserId) return { status: "unavailable" };

      const shared: Guild[] = [];
      for (const guild of client.guilds.cache.values()) {
        try {
          await guild.members.fetch(ownerUserId);
          shared.push(guild);
        } catch {
          // Not a member of this server (or not visible to Epi): not a candidate.
        }
      }
      if (shared.length === 0) return { status: "no_server" };

      const wanted = server?.trim().toLowerCase();
      const target = wanted
        ? (shared.find((guild) => guild.name.toLowerCase() === wanted) ??
          shared.find((guild) => guild.name.toLowerCase().includes(wanted)))
        : shared.length === 1
          ? shared[0]
          : undefined;
      if (!target) return { status: "choose", servers: shared.map((guild) => guild.name) };

      const result = await applyWorkspacePlan(guildPort(target, ownerUserId, botUserId));
      log("workspace_setup", {
        guildId: target.id,
        created: result.created,
        categoryCreated: result.categoryCreated,
        problem: result.problem,
      });
      if (result.problem) {
        return {
          status: "blocked",
          server: target.name,
          created: result.created,
          categoryCreated: result.categoryCreated,
          reason: result.problem,
        };
      }
      return {
        status: "ready",
        server: target.name,
        created: result.created,
        categoryCreated: result.categoryCreated,
      };
    },
  };
}

// Offers the workspace in one server, logging the outcome so it is visible in the worker's logs.
export async function offerWorkspaceInGuild(
  client: Client,
  guild: Guild,
  ownerUserId: string,
): Promise<OfferResult | "error"> {
  const botUserId = client.user?.id;
  if (!botUserId) return "error";
  try {
    const result = await offerWorkspace(
      offerPort(client, guild, ownerUserId, botUserId),
      guild.name,
    );
    log("workspace_offer", { guildId: guild.id, result });
    return result;
  } catch (error) {
    log("workspace_offer_failed", {
      guildId: guild.id,
      error: error instanceof Error ? error.name : "unknown",
    });
    return "error";
  }
}

export function setupPort(
  client: Client,
  guild: Guild,
  ownerUserId: string,
  botUserId: string,
): SetupPort {
  const offer = offerPort(client, guild, ownerUserId, botUserId);
  return {
    ownerIsMember: offer.ownerIsMember,
    ownerOwnsServer: () => guild.ownerId === ownerUserId,
    apply: () => applyWorkspacePlan(guildPort(guild, ownerUserId, botUserId)),
    // A problem message always names the server in quotes, as does the offer; either counts.
    alreadyToldAboutProblem: offer.alreadyOffered,
    sendDm: offer.sendOffer,
  };
}

// What to do when Epi is in a server: set it up automatically if the owner owns the server (adding
// Epi there is the approval), otherwise offer by DM. Every outcome is logged.
export async function prepareServer(
  client: Client,
  guild: Guild,
  ownerUserId: string,
): Promise<void> {
  const botUserId = client.user?.id;
  if (!botUserId) return;
  try {
    const outcome = await autoSetupWorkspace(
      setupPort(client, guild, ownerUserId, botUserId),
      guild.name,
    );
    log("workspace_auto_setup", { guildId: guild.id, outcome });
    if (outcome === "not_owner") await offerWorkspaceInGuild(client, guild, ownerUserId);
  } catch (error) {
    log("workspace_auto_setup_failed", {
      guildId: guild.id,
      error: error instanceof Error ? error.name : "unknown",
    });
  }
}
