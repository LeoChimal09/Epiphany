import { describe, expect, it, vi } from "vitest";
import { autoSetupWorkspace, offerWorkspace, type OfferPort, type SetupPort } from "./offer";
import type { WorkspaceApplyResult } from "./workspace";
import {
  SHARED_CHANNEL_REPLY,
  workspaceCreatedMessage,
  workspaceOffer,
  workspaceProblemMessage,
} from "./routing";

function port(over: Partial<OfferPort> = {}): OfferPort & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    ownerIsMember: async () => true,
    missingResources: async () => 8,
    alreadyOffered: async () => false,
    sendOffer: async (text) => {
      sent.push(text);
    },
    ...over,
  };
}

describe("offering the workspace", () => {
  it("DMs the owner once when Epi is in their server and nothing is set up", async () => {
    const fake = port();
    expect(await offerWorkspace(fake, "My Server")).toBe("offered");
    expect(fake.sent).toEqual([workspaceOffer("My Server")]);
    expect(fake.sent[0]).toContain('"My Server"');
  });

  it("sends nothing for a server the owner is not in", async () => {
    const sendOffer = vi.fn();
    expect(await offerWorkspace(port({ ownerIsMember: async () => false, sendOffer }), "X")).toBe(
      "not_member",
    );
    expect(sendOffer).not.toHaveBeenCalled();
  });

  it("does not repeat itself after a restart, or when the workspace already exists", async () => {
    const sendOffer = vi.fn();
    expect(await offerWorkspace(port({ alreadyOffered: async () => true, sendOffer }), "X")).toBe(
      "already_offered",
    );
    expect(await offerWorkspace(port({ missingResources: async () => 0, sendOffer }), "X")).toBe(
      "already_set_up",
    );
    expect(sendOffer).not.toHaveBeenCalled();
  });

  it("reports blocked DMs instead of throwing", async () => {
    const blocked = port({
      sendOffer: async () => {
        throw new Error("Cannot send messages to this user");
      },
    });
    expect(await offerWorkspace(blocked, "X")).toBe("dm_failed");
  });
});

describe("Epi's fixed messages", () => {
  it("point the owner to a DM for setup and never claim to have done anything", () => {
    expect(SHARED_CHANNEL_REPLY).toContain("DM");
    expect(SHARED_CHANNEL_REPLY).toContain("private");
    expect(workspaceOffer("S")).toContain("when you'd like me to set it up");
    expect(workspaceOffer("S")).not.toMatch(/\bI (created|set up) /);
  });
});

describe("automatic setup in a server the owner owns", () => {
  const made: WorkspaceApplyResult = {
    created: ["assistant", "today"],
    categoryCreated: true,
    problem: null,
  };
  function setup(over: Partial<SetupPort> = {}) {
    const sent: string[] = [];
    const applied = vi.fn(async () => made);
    const port: SetupPort = {
      ownerIsMember: async () => true,
      ownerOwnsServer: () => true,
      apply: applied,
      alreadyToldAboutProblem: async () => false,
      sendDm: async (text) => {
        sent.push(text);
      },
      ...over,
    };
    return { port, sent, applied };
  }

  it("creates the workspace and tells the owner what it made", async () => {
    const { port, sent } = setup();
    expect(await autoSetupWorkspace(port, "My Server")).toBe("created");
    expect(sent).toEqual([workspaceCreatedMessage("My Server", ["assistant", "today"])]);
    expect(sent[0]).toContain("#assistant, #today");
  });

  it("does nothing and says nothing when everything is already there (every later restart)", async () => {
    const { port, sent } = setup({
      apply: async () => ({ created: [], categoryCreated: false, problem: null }),
    });
    expect(await autoSetupWorkspace(port, "S")).toBe("already_set_up");
    expect(sent).toEqual([]);
  });

  it("does not act for a server the owner is not in, or merely belongs to", async () => {
    const stranger = setup({ ownerIsMember: async () => false });
    expect(await autoSetupWorkspace(stranger.port, "S")).toBe("not_member");
    expect(stranger.applied).not.toHaveBeenCalled();

    const guest = setup({ ownerOwnsServer: () => false });
    expect(await autoSetupWorkspace(guest.port, "S")).toBe("not_owner");
    expect(guest.applied).not.toHaveBeenCalled();
  });

  it("reports a permission problem once, naming what Epi needs, not at every restart", async () => {
    const blocked: WorkspaceApplyResult = {
      created: [],
      categoryCreated: false,
      problem: "missing_permissions",
    };
    const first = setup({ apply: async () => blocked });
    expect(await autoSetupWorkspace(first.port, "S")).toBe("problem_reported");
    expect(first.sent).toEqual([workspaceProblemMessage("S", [], "missing_permissions")]);
    expect(first.sent[0]).toContain("Manage Channels");
    expect(first.sent[0]).toContain("not Administrator");

    const again = setup({ apply: async () => blocked, alreadyToldAboutProblem: async () => true });
    expect(await autoSetupWorkspace(again.port, "S")).toBe("problem_known");
    expect(again.sent).toEqual([]);
  });

  it("still reports success honestly when the DM is blocked", async () => {
    const { port } = setup({
      sendDm: async () => {
        throw new Error("blocked");
      },
    });
    expect(await autoSetupWorkspace(port, "S")).toBe("dm_failed");
  });

  it("mentions what was created before a failure stopped setup", () => {
    expect(workspaceProblemMessage("S", ["assistant"], "failed")).toContain("#assistant");
  });
});
