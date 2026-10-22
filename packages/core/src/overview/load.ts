import { addDays, dateKeyOf, localWallToUtc } from "../planning/time";
import type { Principal, Services } from "../services";
import type { OverviewData } from "./render";

// Reads everything the overviews need through the permissioned services, so a Discord view can
// never show more than the owner could see in the dashboard.
export async function loadOverviewData(
  services: Services,
  principal: Principal,
  now: Date,
  timezone: string,
): Promise<OverviewData> {
  const todayKey = dateKeyOf(now, timezone);
  const from = localWallToUtc(todayKey, 0, timezone);
  const to = localWallToUtc(addDays(todayKey, 7), 0, timezone);
  const [openTasks, doneTasks, notes, events, blocks, history, categories, reminders] =
    await Promise.all([
      services.tasks.list(principal, { status: "open", limit: 100 }),
      services.tasks.list(principal, { status: "completed", limit: 50 }),
      services.notes.list(principal, { limit: 50 }),
      services.events.list(principal, { from, to, limit: 100 }),
      services.workBlocks.list(principal, { from, to, limit: 100 }),
      services.history.list(principal, 40),
      services.categories.list(principal),
      services.reminders.recent(principal, 60),
    ]);
  return {
    now,
    timezone,
    openTasks,
    knownTasks: [...openTasks, ...doneTasks],
    notes,
    events,
    blocks,
    history,
    reminders,
    categoryNames: new Map(categories.map((category) => [category.id, category.name])),
  };
}
