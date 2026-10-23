import { describe, expect, it } from "vitest";
import { emptyConversation, type PendingCapture } from "./assistant";
import { parseConversationState } from "./state";

const pendingCapture: PendingCapture = {
  ownerId: "owner-1",
  items: [
    { type: "task", title: "Lab report", dueDate: "2026-10-22", dueTime: "23:59" },
    { type: "idea", title: "Habit app", details: "Track study habits" },
  ],
  omitted: 0,
  sourceText: "lab report due 10/22 at 11:59pm and an app idea",
  sourceRef: "discord:channel/message",
  expiresAt: "2026-10-20T18:00:00.000Z",
};

describe("conversation state", () => {
  it("round-trips an owner-bound idea reference without accepting a client-supplied body", () => {
    const state = {
      ...emptyConversation(),
      activeIdea: { ownerId: "owner-1", noteId: "idea-1" },
    };
    expect(parseConversationState(JSON.parse(JSON.stringify(state)))).toEqual(state);
    expect(
      parseConversationState({ ...state, activeIdea: { ...state.activeIdea, body: "untrusted" } }),
    ).toBeNull();
  });

  it("continues existing conversations that predate import previews", () => {
    expect(parseConversationState(emptyConversation())).toEqual(emptyConversation());
  });

  it("round-trips a bounded, typed preview with its original source", () => {
    const state = { ...emptyConversation(), pendingCapture };
    expect(parseConversationState(JSON.parse(JSON.stringify(state)))).toEqual(state);
  });

  it.each([
    { ...pendingCapture, items: Array.from({ length: 31 }, () => pendingCapture.items[0]) },
    { ...pendingCapture, sourceText: "x".repeat(8001) },
    { ...pendingCapture, expiresAt: "not a date" },
    { ...pendingCapture, items: [{ type: "task", title: "Lab", dueTime: "12:00" }] },
    { ...pendingCapture, items: [{ type: "task", title: "Lab", dueDate: "2026-02-30" }] },
    { ...pendingCapture, items: [{ type: "task", title: "Lab", dueTime: "25:00" }] },
    { ...pendingCapture, items: [{ type: "delete_everything", title: "Lab" }] },
    { ...pendingCapture, items: [] },
  ])("rejects malformed or oversized preview state: %#", (invalid) => {
    expect(parseConversationState({ ...emptyConversation(), pendingCapture: invalid })).toBeNull();
  });
});
