import { describe, expect, it } from "vitest";
import {
  applyWorkspacePlan,
  planEpiphanyWorkspace,
  privateWorkspacePermissions,
  WORKSPACE_TEXT_CHANNELS,
  WorkspaceCreateError,
  workspaceAudience,
  type ExistingWorkspaceChannel,
  type WorkspaceChannelSpec,
  type WorkspaceGuildPort,
} from "./workspace";

describe("Epiphany Discord workspace plan", () => {
  it("plans one private category and all dedicated channels for an empty server", () => {
    const plan = planEpiphanyWorkspace([]);
    expect(plan.categoryId).toBeNull();
    expect(plan.actions[0]).toEqual({ kind: "category", name: "epiphany", parentId: null });
    expect(plan.actions.slice(1)).toEqual(
      WORKSPACE_TEXT_CHANNELS.map((name) => ({
        kind: "text",
        name,
        parentId: "$epiphany-category",
      })),
    );
  });

  it("reuses the category and plans only missing text channels", () => {
    const channels: ExistingWorkspaceChannel[] = [
      { id: "category-1", name: "Epiphany", kind: "category", parentId: null },
      { id: "assistant-1", name: "assistant", kind: "text", parentId: "category-1" },
      { id: "schedule-1", name: "schedule", kind: "text", parentId: "category-1" },
    ];
    const plan = planEpiphanyWorkspace(channels);
    expect(plan.categoryId).toBe("category-1");
    expect(plan.actions).toEqual(
      WORKSPACE_TEXT_CHANNELS.filter((name) => !["assistant", "schedule"].includes(name)).map(
        (name) => ({ kind: "text", name, parentId: "category-1" }),
      ),
    );
  });

  it("is idempotent after every planned resource exists", () => {
    const channels: ExistingWorkspaceChannel[] = [
      { id: "category-1", name: "epiphany", kind: "category", parentId: null },
      ...WORKSPACE_TEXT_CHANNELS.map((name) => ({
        id: `channel-${name}`,
        name,
        kind: "text" as const,
        parentId: "category-1",
      })),
    ];
    expect(planEpiphanyWorkspace(channels)).toEqual({ categoryId: "category-1", actions: [] });
  });

  it("does not treat similarly named channels outside the category as owned resources", () => {
    const channels: ExistingWorkspaceChannel[] = [
      { id: "assistant-public", name: "assistant", kind: "text", parentId: null },
    ];
    const plan = planEpiphanyWorkspace(channels);
    expect(plan.actions).toContainEqual({
      kind: "text",
      name: "assistant",
      parentId: "$epiphany-category",
    });
  });

  it("never schedules rename, move, or delete actions", () => {
    const channels: ExistingWorkspaceChannel[] = [
      { id: "category-1", name: "epiphany", kind: "category", parentId: null },
      { id: "wrong-parent", name: "assistant", kind: "text", parentId: "another-category" },
    ];
    expect(planEpiphanyWorkspace(channels).actions.every((action) => action.kind === "text")).toBe(
      true,
    );
    expect(
      planEpiphanyWorkspace(channels).actions.some((action) => action.name === "assistant"),
    ).toBe(true);
  });
});

describe("private workspace permission policy", () => {
  it("denies the server-wide everyone role and allows only the owner and bot", () => {
    expect(privateWorkspacePermissions()).toEqual([
      { subject: "everyone", allow: [], deny: ["viewChannel"] },
      {
        subject: "owner",
        allow: ["viewChannel", "sendMessages", "readMessageHistory"],
        deny: [],
      },
      {
        subject: "bot",
        allow: ["viewChannel", "sendMessages", "readMessageHistory", "manageChannels"],
        deny: [],
      },
    ]);
  });
});

describe("applying the workspace plan", () => {
  function fakeGuild(
    initial: ExistingWorkspaceChannel[] = [],
    failAt?: { name: string; error: Error },
  ) {
    const channels = [...initial];
    const specs: WorkspaceChannelSpec[] = [];
    let next = 1;
    const guild: WorkspaceGuildPort = {
      name: "Test Server",
      async listChannels() {
        return channels.map((channel) => ({ ...channel }));
      },
      async createChannel(spec) {
        await Promise.resolve();
        if (failAt && spec.name === failAt.name) throw failAt.error;
        specs.push(spec);
        const id = `new-${next++}`;
        channels.push({ id, name: spec.name, kind: spec.kind, parentId: spec.parentId });
        return { id };
      },
    };
    return { guild, channels, specs };
  }

  it("creates the category first, then every channel inside it, all private", async () => {
    const { guild, specs, channels } = fakeGuild();
    const result = await applyWorkspacePlan(guild);
    expect(result).toEqual({
      created: [...WORKSPACE_TEXT_CHANNELS],
      categoryCreated: true,
      problem: null,
    });
    expect(specs[0]).toMatchObject({ kind: "category", name: "epiphany", parentId: null });
    const categoryId = channels.find((channel) => channel.kind === "category")!.id;
    expect(specs.slice(1).every((spec) => spec.parentId === categoryId)).toBe(true);
    for (const spec of specs) {
      expect(spec.overwrites).toEqual(privateWorkspacePermissions());
      expect(spec.overwrites.find((entry) => entry.subject === "everyone")?.deny).toContain(
        "viewChannel",
      );
    }
  });

  it("creates nothing the second time, even when two requests arrive together", async () => {
    const { guild, specs } = fakeGuild();
    const [first, second] = await Promise.all([
      applyWorkspacePlan(guild),
      applyWorkspacePlan(guild),
    ]);
    expect(first).toBe(second);
    expect(specs).toHaveLength(1 + WORKSPACE_TEXT_CHANNELS.length);

    const again = await applyWorkspacePlan(guild);
    expect(again).toEqual({ created: [], categoryCreated: false, problem: null });
    expect(specs).toHaveLength(1 + WORKSPACE_TEXT_CHANNELS.length);
  });

  it("repairs a deleted channel without touching the rest", async () => {
    const { guild, specs } = fakeGuild([
      { id: "cat", name: "epiphany", kind: "category", parentId: null },
      ...WORKSPACE_TEXT_CHANNELS.filter((name) => name !== "today").map(
        (name, index): ExistingWorkspaceChannel => ({
          id: `c${index}`,
          name,
          kind: "text",
          parentId: "cat",
        }),
      ),
    ]);
    const result = await applyWorkspacePlan(guild);
    expect(result).toEqual({ created: ["today"], categoryCreated: false, problem: null });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ name: "today", parentId: "cat" });
  });

  it("stops at a permission failure, reports what it made, and continues on the next run", async () => {
    const denied = fakeGuild([], {
      name: "schedule",
      error: new WorkspaceCreateError("missing_permissions"),
    });
    const result = await applyWorkspacePlan(denied.guild);
    expect(result).toEqual({
      created: ["assistant", "today"],
      categoryCreated: true,
      problem: "missing_permissions",
    });

    const resumed = fakeGuild(denied.channels);
    const rest = await applyWorkspacePlan(resumed.guild);
    expect(rest.problem).toBeNull();
    expect(rest.categoryCreated).toBe(false);
    expect(rest.created).toEqual(WORKSPACE_TEXT_CHANNELS.slice(2));
  });

  it("reports an unexpected failure as a generic problem without leaking its message", async () => {
    const { guild } = fakeGuild([], { name: "epiphany", error: new Error("secret detail") });
    const result = await applyWorkspacePlan(guild);
    expect(result).toEqual({ created: [], categoryCreated: false, problem: "failed" });
    expect(JSON.stringify(result)).not.toContain("secret");
  });
});

describe("which conversations count as private", () => {
  it("accepts DMs and private assistant/check-ins channels in the Epiphany category only", () => {
    expect(workspaceAudience({ isDm: true })).toBe("private");
    const ok = { isDm: false, name: "assistant", parentName: "epiphany", everyoneCanView: false };
    expect(workspaceAudience(ok)).toBe("private");
    expect(workspaceAudience({ ...ok, name: "Assistant", parentName: "Epiphany" })).toBe("private");
    expect(workspaceAudience({ ...ok, name: "check-ins" })).toBe("private");
  });

  it("treats a visible, misplaced, or unknown channel as shared", () => {
    const ok = { isDm: false, name: "assistant", parentName: "epiphany", everyoneCanView: false };
    expect(workspaceAudience({ ...ok, everyoneCanView: true })).toBe("shared");
    expect(workspaceAudience({ ...ok, everyoneCanView: undefined })).toBe("shared");
    expect(workspaceAudience({ ...ok, parentName: "general" })).toBe("shared");
    expect(workspaceAudience({ ...ok, parentName: null })).toBe("shared");
    expect(workspaceAudience({ ...ok, name: "today" })).toBe("shared");
    expect(workspaceAudience({ isDm: false, name: "general" })).toBe("shared");
  });
});
