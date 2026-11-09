import { beforeEach, describe, expect, it, vi } from "vitest";
import { emptyConversation } from "@epiphany/core/assistant";
import { VersionConflictError } from "@epiphany/core/services";
import {
  createDashboardChat,
  deleteDashboardChat,
  loadDashboardChats,
  openDashboardChat,
  sendDashboardChat,
} from "./actions";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  create: vi.fn(),
  claim: vi.fn(),
  finish: vi.fn(),
  remove: vi.fn(),
  ask: vi.fn(),
}));
vi.mock("./server-data", () => ({
  dashboardContext: mocks.context,
  categoryForDashboard: vi.fn(),
  eventForSchedule: vi.fn(),
  loadDashboardData: vi.fn(),
  loadSchedule: vi.fn(),
  noteForDashboard: vi.fn(),
  taskForDashboard: vi.fn(),
}));
vi.mock("./assistant-server", () => ({
  askAssistant: mocks.ask,
  assistantAvailability: () => "ready",
}));

const principal = { ownerId: "owner-fixture" };
const session = {
  id: "session-fixture",
  title: "Gift list",
  updatedAt: "2026-11-09T15:00:00Z",
  busy: true,
  data: {
    topic: { kind: "note", id: "note-fixture", label: "note", title: "Gift list" },
    conversation: { ...emptyConversation(), focus: { kind: "note", id: "note-fixture" } },
    messages: [{ id: 1, role: "user", text: "Add these supplies" }],
  },
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({
    principal,
    services: {
      conversations: {
        list: mocks.list,
        get: mocks.get,
        create: mocks.create,
        claim: mocks.claim,
        finish: mocks.finish,
        remove: mocks.remove,
      },
    },
  });
  mocks.claim.mockResolvedValue({ session, token: "server-only-token" });
});

describe("saved dashboard conversations", () => {
  it("uses authenticated services for listing, opening, and creating sessions", async () => {
    mocks.list.mockResolvedValue([{ id: session.id }]);
    mocks.get.mockResolvedValue(session);
    mocks.create.mockResolvedValue(session);
    expect(await loadDashboardChats()).toMatchObject({ ok: true, session });
    expect(await openDashboardChat(session.id)).toMatchObject({ ok: true, session });
    expect(
      await createDashboardChat(session.data.topic as Parameters<typeof createDashboardChat>[0]),
    ).toMatchObject({ ok: true });
    expect(mocks.list).toHaveBeenCalledWith(principal);
    expect(mocks.get).toHaveBeenCalledWith(principal, session.id);
    expect(mocks.create).toHaveBeenCalledWith(principal, session.data.topic);
    expect(mocks.ask).not.toHaveBeenCalled();
  });

  it("deletes through the authenticated service and returns the next conversation", async () => {
    mocks.list.mockResolvedValue([]);
    expect(await deleteDashboardChat(session.id)).toEqual({
      ok: true,
      sessions: [],
      session: null,
    });
    expect(mocks.remove).toHaveBeenCalledWith(principal, session.id);
    mocks.remove.mockRejectedValue(new VersionConflictError("Conversation", 1));
    expect(await deleteDashboardChat(session.id)).toMatchObject({
      ok: false,
      error: expect.stringContaining("busy"),
    });
  });

  it("resumes only server-stored context, then saves the reply and updated focus", async () => {
    mocks.ask.mockResolvedValue({
      reply: { text: "Updated note.", outcome: "completed", changed: true },
      state: session.data.conversation,
      budgetNote: null,
    });
    mocks.finish.mockResolvedValue({ ...session, busy: false });
    expect(await sendDashboardChat("Add these supplies", session.id)).toMatchObject({
      ok: true,
      changed: true,
    });
    expect(mocks.claim).toHaveBeenCalledWith(principal, session.id, "Add these supplies");
    expect(mocks.ask).toHaveBeenCalledWith(
      principal.ownerId,
      "Add these supplies",
      session.data.conversation,
    );
    expect(mocks.finish).toHaveBeenCalledWith(
      principal,
      session.id,
      "server-only-token",
      expect.objectContaining({
        topic: session.data.topic,
        messages: [
          session.data.messages[0],
          expect.objectContaining({ role: "epi", text: "Updated note.", changed: true }),
        ],
      }),
    );
  });

  it("does not call AI or replay a request when another turn owns the session", async () => {
    mocks.claim.mockRejectedValue(new Error("Busy"));
    expect(await sendDashboardChat("Add again", session.id)).toMatchObject({ ok: false });
    expect(mocks.ask).not.toHaveBeenCalled();
    expect(mocks.finish).not.toHaveBeenCalled();
  });

  it("does not claim nothing changed if persistence fails after a domain update", async () => {
    mocks.ask.mockResolvedValue({
      reply: { text: "Updated note.", outcome: "completed", changed: true },
      state: session.data.conversation,
      budgetNote: null,
    });
    mocks.finish.mockRejectedValue(new Error("Connection interrupted"));
    const result = await sendDashboardChat("Add these supplies", session.id);
    expect(result).toMatchObject({
      ok: false,
      error: expect.stringContaining("check the saved record"),
    });
    expect(JSON.stringify(result)).not.toContain("Nothing was changed");
    expect(mocks.ask).toHaveBeenCalledTimes(1);
  });

  it("persists an uncertain reply rather than a false negative after an unexpected assistant error", async () => {
    mocks.ask.mockRejectedValue(new Error("Unknown result"));
    mocks.finish.mockResolvedValue(session);
    await sendDashboardChat("Add these supplies", session.id);
    expect(mocks.finish).toHaveBeenCalledWith(
      principal,
      session.id,
      "server-only-token",
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({
            outcome: "uncertain",
            text: expect.not.stringContaining("Nothing was changed"),
          }),
        ]),
      }),
    );
  });
});
