import { describe, expect, it } from "vitest";
import {
  planEpiphanyWorkspace,
  privateWorkspacePermissions,
  WORKSPACE_TEXT_CHANNELS,
  type ExistingWorkspaceChannel,
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
