import { describe, expect, it } from "vitest";
import { canonicalJson, hashProposal } from "./confirmations";
import { AccessDeniedError, ConfirmationRequiredError } from "./errors";
import { ACTIONS, authorize, decide, type ActionName } from "./permissions";

const owner = { audience: "private", initiator: "owner" } as const;
const assistant = { audience: "private", initiator: "assistant" } as const;
const shared = { audience: "shared", initiator: "assistant" } as const;

const names = Object.keys(ACTIONS) as ActionName[];
const byKind = (kind: string) => names.filter((name) => ACTIONS[name].kind === kind);

describe("permission matrix", () => {
  it.each(byKind("read"))("%s: reading is allowed and not undoable", (action) => {
    expect(decide(owner, action)).toEqual({ kind: "allow", undoable: false });
    expect(decide(assistant, action)).toEqual({ kind: "allow", undoable: false });
  });

  it.each(byKind("apply"))("%s: clear explicit changes apply and are undoable", (action) => {
    expect(decide(assistant, action)).toEqual({ kind: "allow", undoable: true });
  });

  it("requires confirmation to cancel an externally synced event", () => {
    expect(decide(assistant, "event.cancel", { external: true }).kind).toBe("confirm");
    expect(decide(assistant, "event.cancel", { external: false }).kind).toBe("allow");
  });

  it.each(byKind("schedule"))("%s: advice is not consent for the assistant", (action) => {
    expect(decide(assistant, action).kind).toBe("deny");
    expect(decide(assistant, action, { intent: "advice" }).kind).toBe("deny");
    expect(decide(assistant, action, { intent: "explicit" }).kind).toBe("allow");
    expect(decide(owner, action).kind).toBe("allow");
  });

  it.each([...byKind("external"), ...byKind("destructive")])("%s needs confirmation", (action) => {
    expect(decide(owner, action).kind).toBe("confirm");
    expect(decide(assistant, action, { intent: "explicit" }).kind).toBe("confirm");
  });

  it.each(byKind("escalate"))("%s needs explicit consent", (action) => {
    expect(decide(owner, action).kind).toBe("consent");
  });

  it("denies unknown actions", () => {
    expect(decide(owner, "everything.delete")).toEqual({ kind: "deny", reason: "unknown action" });
  });

  it("denies every action for a shared audience", () => {
    expect(names.length).toBeGreaterThan(20);
    for (const action of names) {
      expect(decide(shared, action, { intent: "explicit" }).kind, action).toBe("deny");
      expect(decide({ audience: "shared", initiator: "owner" }, action).kind, action).toBe("deny");
    }
  });
});

describe("authorize", () => {
  it("returns the decision when allowed", () => {
    expect(authorize(owner, "task.complete")).toEqual({ kind: "allow", undoable: true });
  });

  it("throws AccessDeniedError when denied", () => {
    expect(() => authorize(shared, "task.read")).toThrow(AccessDeniedError);
    expect(() => authorize(assistant, "work_block.create")).toThrow(/not consent/);
  });

  it("throws ConfirmationRequiredError for confirm and consent actions", () => {
    expect(() => authorize(owner, "note.delete")).toThrow(ConfirmationRequiredError);
    try {
      authorize(owner, "tracking.enable");
    } catch (error) {
      expect(error).toMatchObject({ kind: "consent" });
    }
  });
});

describe("proposal hashing", () => {
  const base = {
    ownerId: "o1",
    action: "note.delete",
    payload: { noteId: "n1" },
    targets: [{ entityType: "note", entityId: "n1", version: 1 }],
  };

  it("ignores key order", () => {
    expect(canonicalJson({ b: 1, a: { d: 2, c: 3 } })).toBe(
      canonicalJson({ a: { c: 3, d: 2 }, b: 1 }),
    );
  });

  it("changes when the version, target, payload, action, or owner changes", () => {
    const hash = hashProposal(base);
    expect(hashProposal({ ...base })).toBe(hash);
    expect(hashProposal({ ...base, targets: [{ ...base.targets[0]!, version: 2 }] })).not.toBe(
      hash,
    );
    expect(hashProposal({ ...base, payload: { noteId: "n2" } })).not.toBe(hash);
    expect(hashProposal({ ...base, action: "task.delete" })).not.toBe(hash);
    expect(hashProposal({ ...base, ownerId: "o2" })).not.toBe(hash);
  });
});
