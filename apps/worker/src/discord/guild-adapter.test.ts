import {
  ChannelType,
  DiscordAPIError,
  OverwriteType,
  PermissionFlagsBits,
  type Guild,
} from "discord.js";
import { describe, expect, it } from "vitest";
import { guildPort } from "./guild-adapter";
import { privateWorkspacePermissions, WorkspaceCreateError } from "./workspace";

function fakeGuild(createImpl: (options: Record<string, unknown>) => Promise<{ id: string }>) {
  const created: Array<Record<string, unknown>> = [];
  const guild = {
    id: "guild-1",
    name: "Test Server",
    roles: { everyone: { id: "everyone-role" } },
    channels: {
      async fetch() {
        return new Map<string, unknown>([
          ["1", { id: "1", name: "epiphany", type: ChannelType.GuildCategory, parentId: null }],
          ["2", { id: "2", name: "assistant", type: ChannelType.GuildText, parentId: "1" }],
          ["3", { id: "3", name: "voice", type: ChannelType.GuildVoice, parentId: "1" }],
          ["4", null],
        ]);
      },
      async create(options: Record<string, unknown>) {
        created.push(options);
        return createImpl(options);
      },
    },
  };
  return { guild: guild as unknown as Guild, created };
}

describe("Discord guild adapter", () => {
  it("lists only categories and text channels", async () => {
    const { guild } = fakeGuild(async () => ({ id: "x" }));
    expect(await guildPort(guild, "owner-1", "bot-1").listChannels()).toEqual([
      { id: "1", name: "epiphany", kind: "category", parentId: null },
      { id: "2", name: "assistant", kind: "text", parentId: "1" },
    ]);
  });

  it("creates a channel hidden from @everyone and open only to the owner and Epi", async () => {
    const { guild, created } = fakeGuild(async () => ({ id: "new-1" }));
    const port = guildPort(guild, "owner-1", "bot-1");
    expect(
      await port.createChannel({
        kind: "text",
        name: "assistant",
        parentId: "1",
        overwrites: privateWorkspacePermissions(),
      }),
    ).toEqual({ id: "new-1" });

    const options = created[0]!;
    expect(options).toMatchObject({ name: "assistant", type: ChannelType.GuildText, parent: "1" });
    const overwrites = options.permissionOverwrites as Array<{
      id: string;
      type: OverwriteType;
      allow: bigint[];
      deny: bigint[];
    }>;
    expect(overwrites).toEqual([
      {
        id: "everyone-role",
        type: OverwriteType.Role,
        allow: [],
        deny: [PermissionFlagsBits.ViewChannel],
      },
      {
        id: "owner-1",
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
        ],
        deny: [],
      },
      {
        id: "bot-1",
        type: OverwriteType.Member,
        allow: [
          PermissionFlagsBits.ViewChannel,
          PermissionFlagsBits.SendMessages,
          PermissionFlagsBits.ReadMessageHistory,
          PermissionFlagsBits.ManageChannels,
        ],
        deny: [],
      },
    ]);
  });

  it("creates a category without a parent", async () => {
    const { guild, created } = fakeGuild(async () => ({ id: "cat" }));
    await guildPort(guild, "owner-1", "bot-1").createChannel({
      kind: "category",
      name: "epiphany",
      parentId: null,
      overwrites: [],
    });
    expect(created[0]).toMatchObject({ type: ChannelType.GuildCategory });
    expect(created[0]).not.toHaveProperty("parent");
  });

  it("maps Discord's permission errors to a missing-permissions problem and hides other errors", async () => {
    const denied = fakeGuild(async () => {
      throw new DiscordAPIError(
        { code: 50013, message: "Missing Permissions" },
        50013,
        403,
        "POST",
        "url",
        {},
      );
    });
    await expect(
      guildPort(denied.guild, "o", "b").createChannel({
        kind: "text",
        name: "x",
        parentId: null,
        overwrites: [],
      }),
    ).rejects.toMatchObject({ name: "WorkspaceCreateError", reason: "missing_permissions" });

    const broken = fakeGuild(async () => {
      throw new Error("token=abc leaked");
    });
    const error = await guildPort(broken.guild, "o", "b")
      .createChannel({ kind: "text", name: "x", parentId: null, overwrites: [] })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(WorkspaceCreateError);
    expect((error as WorkspaceCreateError).reason).toBe("failed");
    expect((error as Error).message).not.toContain("token");
  });
});
