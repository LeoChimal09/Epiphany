import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createOwner } from "@epiphany/core/db";
import { SESSION_TTL_MS } from "@epiphany/core/auth";
import { dbTestsEnabled } from "@epiphany/core/testing";
import { createHarness, type Harness } from "../test-harness";
import { completeTask, createTask, listTasks } from "./tasks";

const ORIGIN = "http://localhost:3000";

describe.skipIf(!dbTestsEnabled)("tasks API", () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await h.close();
  });

  const rows = async (sql: string, params: unknown[] = []) =>
    (await h.handle.pool.query(sql, params))[0] as Array<Record<string, unknown>>;
  const get = (cookie?: string, query = "") =>
    new Request(`${ORIGIN}/api/tasks${query}`, { headers: cookie ? { cookie } : {} });
  const post = (url: string, body: unknown, headers: Record<string, string> = {}) =>
    new Request(`${ORIGIN}${url}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: ORIGIN, ...headers },
      body: JSON.stringify(body),
    });

  async function signedIn(ownerId = h.ownerId) {
    return h.setCookie(await h.sessionFor(ownerId));
  }
  async function taskCount() {
    return (await rows("SELECT id FROM tasks")).length;
  }

  describe("unauthorized callers", () => {
    it("get 401 with no cookie, a made-up cookie, or a hash copied from the database", async () => {
      const real = await h.sessionFor(h.ownerId);
      const [{ id: storedHash }] = (await rows("SELECT id FROM sessions")) as [{ id: string }];
      for (const cookie of [
        undefined,
        "epiphany_session=",
        "epiphany_session=A".padEnd(60, "A"),
        `epiphany_session=${storedHash}`,
        "other_cookie=" + real,
      ]) {
        const response = await listTasks(get(cookie), h.deps);
        expect(response.status, String(cookie).slice(0, 30)).toBe(401);
        expect(await response.json()).toEqual({ error: "unauthenticated" });
      }
    });

    it("get 401 once the session has expired, and a valid one works up to the last moment", async () => {
      const token = await h.sessionFor(h.ownerId);
      h.now.current = new Date(h.now.current.getTime() + SESSION_TTL_MS - 1);
      expect((await listTasks(get(h.setCookie(token)), h.deps)).status).toBe(200);
      h.now.current = new Date(h.now.current.getTime() + 1);
      expect((await listTasks(get(h.setCookie(token)), h.deps)).status).toBe(401);
    });

    it("cannot create or complete anything without a session, and nothing changes", async () => {
      const task = await (
        await createTask(
          post("/api/tasks", { title: "Mine" }, { cookie: await signedIn() }),
          h.deps,
        )
      ).json();
      const before = await taskCount();

      const create = await createTask(post("/api/tasks", { title: "Intruder" }), h.deps);
      const complete = await completeTask(
        post(`/api/tasks/${task.id}/complete`, {}),
        h.deps,
        task.id,
      );
      expect([create.status, complete.status]).toEqual([401, 401]);
      expect(await taskCount()).toBe(before);
      expect((await rows("SELECT status FROM tasks WHERE id = ?", [task.id]))[0]?.status).toBe(
        "open",
      );
    });
  });

  describe("the owner", () => {
    it("creates a task and gets back exactly what MySQL stored", async () => {
      const response = await createTask(
        post(
          "/api/tasks",
          {
            title: "  Chemistry lab report ",
            dueAt: "2026-10-16T04:59:59.123Z",
            estimatedMinutes: 90,
          },
          { cookie: await signedIn() },
        ),
        h.deps,
      );
      expect(response.status).toBe(201);
      expect(response.headers.get("cache-control")).toBe("no-store");
      const body = await response.json();
      expect(body).toMatchObject({
        title: "Chemistry lab report",
        status: "open",
        version: 1,
        estimatedMinutes: 90,
        ownerId: h.ownerId,
      });

      const [stored] = await rows("SELECT * FROM tasks WHERE id = ?", [body.id]);
      expect(stored).toMatchObject({
        title: "Chemistry lab report",
        status: "open",
        estimated_minutes: 90,
      });
      expect(new Date(body.dueAt).toISOString()).toBe("2026-10-16T04:59:59.123Z");
      const [inbox] = await rows(
        "SELECT id FROM categories WHERE system_key = 'inbox' AND owner_id = ?",
        [h.ownerId],
      );
      expect(body.categoryId).toBe(inbox?.id);
    });

    it("lists their tasks, filterable by status, with limits applied", async () => {
      const cookie = await signedIn();
      const a = await (
        await createTask(post("/api/tasks", { title: "A" }, { cookie }), h.deps)
      ).json();
      await createTask(post("/api/tasks", { title: "B" }, { cookie }), h.deps);
      await completeTask(post(`/api/tasks/${a.id}/complete`, {}, { cookie }), h.deps, a.id);

      const open = await (await listTasks(get(cookie), h.deps)).json();
      expect(open.map((t: { title: string }) => t.title)).toEqual(["B"]);
      const all = await (await listTasks(get(cookie, "?status=all"), h.deps)).json();
      expect(all).toHaveLength(2);
      const limited = await (await listTasks(get(cookie, "?status=all&limit=1"), h.deps)).json();
      expect(limited).toHaveLength(1);
      expect((await listTasks(get(cookie, "?limit=0"), h.deps)).status).toBe(422);
      expect((await listTasks(get(cookie, "?status=bogus"), h.deps)).status).toBe(422);
    });

    it("completes a task and the response matches the stored row; repeating changes nothing", async () => {
      const cookie = await signedIn();
      const task = await (
        await createTask(post("/api/tasks", { title: "Finish" }, { cookie }), h.deps)
      ).json();

      const first = await completeTask(
        post(`/api/tasks/${task.id}/complete`, {}, { cookie }),
        h.deps,
        task.id,
      );
      expect(first.status).toBe(200);
      const body = await first.json();
      expect(body.changed).toBe(true);
      expect(body.task).toMatchObject({ id: task.id, status: "completed", version: 2 });
      const [stored] = await rows("SELECT status, version FROM tasks WHERE id = ?", [task.id]);
      expect(stored).toMatchObject({ status: "completed", version: 2 });

      const again = await (
        await completeTask(post(`/api/tasks/${task.id}/complete`, {}, { cookie }), h.deps, task.id)
      ).json();
      expect(again.changed).toBe(false);
      expect(again.task.version).toBe(2);
      expect(
        await rows("SELECT id FROM action_history WHERE action = 'task.complete'"),
      ).toHaveLength(1);
    });

    it("gets clear errors for bad input and persists nothing", async () => {
      const cookie = await signedIn();
      const cases: Array<[string, Request]> = [
        ["empty title", post("/api/tasks", { title: "" }, { cookie })],
        ["unknown field", post("/api/tasks", { title: "x", ownerId: "someone" }, { cookie })],
        ["bad date", post("/api/tasks", { title: "x", dueAt: "soon" }, { cookie })],
        [
          "not json",
          new Request(`${ORIGIN}/api/tasks`, {
            method: "POST",
            headers: { "content-type": "application/json", origin: ORIGIN, cookie },
            body: "{nope",
          }),
        ],
        [
          "wrong content type",
          new Request(`${ORIGIN}/api/tasks`, {
            method: "POST",
            headers: { "content-type": "text/plain", origin: ORIGIN, cookie },
            body: "title=x",
          }),
        ],
        ["huge body", post("/api/tasks", { title: "x", details: "d".repeat(200_000) }, { cookie })],
      ];
      for (const [name, request] of cases) {
        const response = await createTask(request, h.deps);
        expect(response.status, name).toBe(422);
        expect((await response.json()).issues.length, name).toBeGreaterThan(0);
      }
      expect(await taskCount()).toBe(0);
      const missing = await completeTask(
        post("/api/tasks/not-a-uuid/complete", {}, { cookie }),
        h.deps,
        "not-a-uuid",
      );
      expect(missing.status).toBe(422);
      const unknown = "00000000-0000-4000-8000-000000000000";
      expect(
        (
          await completeTask(
            post(`/api/tasks/${unknown}/complete`, {}, { cookie }),
            h.deps,
            unknown,
          )
        ).status,
      ).toBe(404);
    });
  });

  describe("another owner", () => {
    it("never sees or completes the first owner's tasks, and learns nothing about them", async () => {
      const task = await (
        await createTask(
          post("/api/tasks", { title: "Private essay" }, { cookie: await signedIn() }),
          h.deps,
        )
      ).json();
      const other = await createOwner(h.handle.db, {
        displayName: "Other",
        discordUserId: "300000000000000003",
      });
      const otherCookie = await signedIn(other.id);

      expect(await (await listTasks(get(otherCookie, "?status=all"), h.deps)).json()).toEqual([]);
      const attempt = await completeTask(
        post(`/api/tasks/${task.id}/complete`, {}, { cookie: otherCookie }),
        h.deps,
        task.id,
      );
      expect(attempt.status).toBe(404);
      expect(JSON.stringify(await attempt.json())).not.toContain("Private essay");
      expect((await rows("SELECT status FROM tasks WHERE id = ?", [task.id]))[0]?.status).toBe(
        "open",
      );
    });
  });

  describe("cross-site requests", () => {
    it.each([
      ["no origin", {}],
      ["another site", { origin: "https://evil.example" }],
    ])("are refused even with a valid session (%s)", async (_name, headers) => {
      const cookie = await signedIn();
      const request = new Request(`${ORIGIN}/api/tasks`, {
        method: "POST",
        headers: { "content-type": "application/json", cookie, ...headers },
        body: JSON.stringify({ title: "Forged" }),
      });
      const response = await createTask(request, h.deps);
      expect(response.status).toBe(403);
      expect(await taskCount()).toBe(0);
    });

    it("do not block reads, which never change anything", async () => {
      expect((await listTasks(get(await signedIn()), h.deps)).status).toBe(200);
    });
  });

  it("answers 500 without internal details when something unexpected fails", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const cookie = await signedIn();
    await h.handle.pool.query("DROP TABLE calendar_event_refs");
    await h.handle.pool.query("DROP TABLE work_blocks");
    await h.handle.pool.query("DROP TABLE tasks").catch(() => undefined);
    const response = await listTasks(get(cookie), h.deps);
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ error: "internal" });
    expect(JSON.stringify(log.mock.calls)).toContain("api_error");
  });
});
