import { beforeEach, describe, expect, it, vi } from "vitest";
import { proposeDashboardCategoryDeletion } from "./actions";

const mocks = vi.hoisted(() => ({
  context: vi.fn(),
  propose: vi.fn(),
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

const principal = { ownerId: "owner-fixture" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.context.mockResolvedValue({
    principal,
    services: { confirmations: { propose: mocks.propose } },
  });
});

describe("category deletion", () => {
  it("proposes deletion through the authenticated confirmation service", async () => {
    mocks.propose.mockResolvedValue({
      confirmationId: "proposal-fixture",
      payloadHash: "payload-hash",
      preview: {
        summary: 'Delete the category "School"',
        consequences: ["3 tasks and 2 notes move to the Inbox.", "The category is removed."],
      },
    });

    expect(await proposeDashboardCategoryDeletion("category-fixture")).toEqual({
      ok: true,
      proposal: {
        confirmationId: "proposal-fixture",
        payloadHash: "payload-hash",
        summary: 'Delete the category "School"',
        consequences: ["3 tasks and 2 notes move to the Inbox.", "The category is removed."],
      },
    });
    expect(mocks.propose).toHaveBeenCalledWith(principal, {
      action: "category.delete",
      payload: { categoryId: "category-fixture" },
    });
  });
});
