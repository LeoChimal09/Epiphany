import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServices, issueOwnerPrincipal, type Principal } from "@epiphany/core/services";
import { dbTestsEnabled } from "@epiphany/core/testing";
import { createOwner } from "@epiphany/core/db";
import { createHarness, type Harness } from "../../lib/test-harness";
import { getAuthDeps } from "../../lib/auth/deps";
import { verifySession } from "../../lib/auth/dal";
import { finishDashboardTask } from "./actions";
import { loadDashboardData } from "./server-data";
import { deadlineNotifications } from "./model";

vi.mock("server-only", () => ({}));
vi.mock("../../lib/auth/dal", () => ({ verifySession: vi.fn() }));
vi.mock("../../lib/auth/deps", () => ({ getAuthDeps: vi.fn() }));
vi.mock("./assistant-server", () => ({ askAssistant: vi.fn(), assistantAvailability: vi.fn() }));

describe.skipIf(!dbTestsEnabled)("notification completion through the dashboard action", () => {
  let h: Harness;
  let owner: Principal;
  let services: ReturnType<typeof createServices>;
  const now = new Date("2026-10-22T08:40:00-05:00");

  beforeEach(async () => {
    h = await createHarness();
    h.now.current = now;
    owner = await issueOwnerPrincipal(h.handle.db, h.ownerId, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    services = createServices(h.handle.db, { clock: () => now });
    vi.mocked(getAuthDeps).mockReturnValue(h.deps);
    vi.mocked(verifySession).mockResolvedValue(owner);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    await h.close();
  });

  it("keeps silence open, persists explicit completion, and removes it on reload without losing history", async () => {
    const record = await services.tasks.create(owner, {
      title: "Overdue fixture assignment",
      dueAt: "2026-10-21T23:59:00-05:00",
    });
    const snapshot = await loadDashboardData();
    expect(deadlineNotifications(snapshot.tasks, snapshot.timezone, now)[0]?.task.id).toBe(
      record.id,
    );
    expect((await services.tasks.get(owner, record.id)).status).toBe("open");

    const result = await finishDashboardTask(record.id);
    const stored = await services.tasks.get(owner, record.id);
    expect(result).toMatchObject({
      ok: true,
      task: { id: record.id, status: "completed", completedAt: stored.completedAt?.toISOString() },
    });
    expect(stored.status).toBe("completed");
    const reloaded = await loadDashboardData();
    expect(deadlineNotifications(reloaded.tasks, reloaded.timezone, now)).toEqual([]);
    expect(reloaded.tasks.find((task) => task.id === record.id)?.status).toBe("completed");
    expect((await finishDashboardTask(record.id)).ok).toBe(true);
    expect((await services.tasks.get(owner, record.id)).version).toBe(stored.version);
  });

  it("does not show another owner's task or allow completing it through a notification action", async () => {
    const other = await createOwner(h.handle.db, { displayName: "Other fixture owner" });
    const principal = await issueOwnerPrincipal(h.handle.db, other.id, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    const record = await services.tasks.create(principal, {
      title: "Other owner's overdue fixture",
      dueAt: "2026-10-21T23:59:00-05:00",
    });
    expect((await loadDashboardData()).tasks).toEqual([]);
    expect((await finishDashboardTask(record.id)).ok).toBe(false);
    expect((await services.tasks.get(principal, record.id)).status).toBe("open");
  });
});
