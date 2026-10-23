import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectDatabase, type DatabaseHandle } from "../db/client";
import { createOwner } from "../db/domain";
import { runMigrations } from "../db/migrate";
import { createTestDatabase, dbTestsEnabled, type TestDatabase } from "../db/test-support";
import {
  AccessDeniedError,
  createServices,
  issueOwnerPrincipal,
  type Principal,
} from "../services";
import { loadOverviewData } from "./load";
import { renderOverview } from "./render";

const migrationsFolder = path.resolve(fileURLToPath(new URL("../../drizzle", import.meta.url)));
const TZ = "America/Chicago";
const NOW = new Date("2026-10-14T15:00:00.000Z");

describe.skipIf(!dbTestsEnabled)("overviews built from real records", () => {
  let database: TestDatabase;
  let handle: DatabaseHandle;
  let ownerId: string;
  let services: ReturnType<typeof createServices>;
  let dashboard: Principal;
  let discord: Principal;

  const principal = (source: "dashboard" | "discord", audience: "private" | "shared" = "private") =>
    issueOwnerPrincipal(handle.db, ownerId, { source, audience, initiator: "owner" });
  const render = async (view: Parameters<typeof renderOverview>[0]) =>
    renderOverview(view, await loadOverviewData(services, dashboard, NOW, TZ));

  beforeEach(async () => {
    database = await createTestDatabase();
    handle = connectDatabase(database.url);
    await runMigrations(handle.pool, migrationsFolder);
    services = createServices(handle.db, { clock: () => NOW });
    ownerId = (await createOwner(handle.db, { displayName: "Owner" })).id;
    dashboard = await principal("dashboard");
    discord = await principal("discord");
  });

  afterEach(async () => {
    await handle.close();
    await database.drop();
    expect(await database.exists()).toBe(false);
  });

  it("shows a completion made in Discord, and a dashboard edit, in the next render", async () => {
    const task = await services.tasks.create(dashboard, {
      title: "Chemistry lab report",
      dueAt: "2026-10-16T22:00:00.000Z",
    });
    const before = await render("priorities");
    expect(before).toContain("Chemistry lab report");

    await services.tasks.complete(discord, task.id);
    const afterComplete = await render("priorities");
    expect(afterComplete).not.toContain("Chemistry lab report");
    expect(afterComplete).not.toBe(before);
    expect(await render("activity-log")).toContain('Completed "Chemistry lab report" (discord)');

    const other = await services.tasks.create(dashboard, { title: "History essay" });
    await services.tasks.update(dashboard, other.id, { title: "History essay, final draft" });
    expect(await render("priorities")).toContain("History essay, final draft");
    expect(await render("activity-log")).toContain(
      'Edited "History essay, final draft" (dashboard)',
    );
  });

  it("renders the same message for the same records, so an unchanged view is never re-posted", async () => {
    await services.tasks.create(dashboard, { title: "Same", dueAt: "2026-10-16T22:00:00.000Z" });
    expect(await render("today")).toBe(await render("today"));
    expect(await render("schedule")).toBe(await render("schedule"));
  });

  it("only shows what the owner could see: nothing for a shared audience or another owner", async () => {
    await services.tasks.create(dashboard, { title: "Private thing" });
    const shared = await principal("discord", "shared");
    await expect(loadOverviewData(services, shared, NOW, TZ)).rejects.toBeInstanceOf(
      AccessDeniedError,
    );
    const stranger = await createOwner(handle.db, { displayName: "Stranger" });
    const theirs = await issueOwnerPrincipal(handle.db, stranger.id, {
      source: "dashboard",
      audience: "private",
      initiator: "owner",
    });
    const text = renderOverview("priorities", await loadOverviewData(services, theirs, NOW, TZ));
    expect(text).not.toContain("Private thing");
    expect(text).toContain("No open tasks");
  });
});
