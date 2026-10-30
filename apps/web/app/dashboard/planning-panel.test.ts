import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AvailabilityPanel } from "./planning-panel";
import { PlanningSettings } from "./planning/settings";
import { defaultPlanningPreferences } from "@epiphany/core/planning";
import { calendarSyncWarning } from "./planning-model";
import type { CalendarOverview } from "@epiphany/core/calendar";
import type { ScheduleData } from "./schedule";

vi.mock("./planning/actions", () => ({ savePlanningSetting: vi.fn() }));

const schedule: ScheduleData = {
  weekStart: "2026-10-19",
  events: [],
  blocks: [],
  truncated: false,
  planningPreferences: defaultPlanningPreferences("America/Chicago"),
};
const props = {
  schedule,
  tasks: [],
  timezone: "America/Chicago",
  from: "2026-10-22",
  to: "2026-10-22",
  now: new Date("2026-10-22T17:00:00Z"),
};

describe("planning UI", () => {
  it("keeps availability and suggestions in a collapsed accordion and never offers a booking control", () => {
    const html = renderToStaticMarkup(createElement(AvailabilityPanel, props));
    expect(html).toContain("<details");
    expect(html).not.toContain("<details open");
    expect(html).toContain("Available windows");
    expect(html).toContain("Preparation milestones");
    expect(html).toContain("not booked time");
    expect(html).toContain("/dashboard/planning");
    expect(html).not.toContain("<button");
  });
  it("shows sync and truncated-task warnings and withholds incomplete calendar windows", () => {
    const html = renderToStaticMarkup(
      createElement(AvailabilityPanel, {
        ...props,
        tasksTruncated: true,
        schedule: { ...schedule, syncWarning: "Waiting for sync." },
      }),
    );
    expect(html).toContain("Availability is tentative");
    expect(html).toContain("Some deadlines are missing");
    const incomplete = renderToStaticMarkup(
      createElement(AvailabilityPanel, {
        ...props,
        schedule: { ...schedule, truncated: true },
      }),
    );
    expect(incomplete).toContain("cannot be calculated");
    expect(incomplete).not.toContain("<h3>Available windows");
  });
  it("renders compact, separately saved controls using 12-hour time fields", () => {
    const html = renderToStaticMarkup(
      createElement(PlanningSettings, {
        preferences: schedule.planningPreferences!,
        versions: {},
      }),
    );
    expect(html.match(/<details/g)).toHaveLength(10);
    expect(html).toContain("Work hours");
    expect(html).toContain("Daily routine");
    expect(html).toContain("More planning options");
    expect(html).toContain("Protect sleep every day");
    expect(html).toContain("Protected time");
    expect(html).toContain("Travel before events");
    expect(html).toContain("Minimum usable minutes");
    expect(html).toContain("Save work hours");
    expect(html).toContain("Start (AM/PM)");
    expect(html).toContain("End (AM/PM)");
    expect(html).toContain('aria-label="End time"');
    expect(html).not.toContain("<details open");
    expect(html).toContain('data-tone="work"');
    expect(html).toContain('data-tone="routine"');
    expect(html).toContain('data-tone="advanced"');
    expect(html).toContain("Sleep, meals, and protected personal time");
  });
});

describe("visible calendar sync state", () => {
  const overview: CalendarOverview = {
    account: {
      id: "account",
      provider: "google",
      email: null,
      status: "connected",
      canWrite: false,
      hasEpiphanyCalendar: false,
      lastError: null,
      connectedAt: new Date("2026-10-22T12:00:00Z"),
      disconnectedAt: null,
    },
    calendars: [],
    blocks: [],
    conflicts: 0,
  };
  const calendar = {
    id: "calendar",
    accountId: "account",
    summary: "Personal",
    kind: "external" as const,
    selected: true,
    isPrimary: true,
    timeZone: null,
    accessRole: "owner",
    syncStatus: "ok" as const,
    lastSyncedAt: new Date("2026-10-22T12:00:00Z"),
    lastError: null,
  };
  it("distinguishes no connection, pending, stale, failed and revoked access", () => {
    expect(calendarSyncWarning({ ...overview, account: null })).toBeNull();
    expect(calendarSyncWarning(overview)).toContain("first sync");
    expect(calendarSyncWarning({ ...overview, calendars: [calendar] })).toBeNull();
    expect(
      calendarSyncWarning({ ...overview, calendars: [{ ...calendar, syncStatus: "stale" }] }),
    ).toContain("out of date");
    expect(
      calendarSyncWarning({ ...overview, calendars: [{ ...calendar, syncStatus: "error" }] }),
    ).toContain("sync problem");
    expect(
      calendarSyncWarning({
        ...overview,
        account: { ...overview.account!, status: "needs_reauth" },
      }),
    ).toContain("reconnecting");
    expect(
      calendarSyncWarning({ ...overview, account: { ...overview.account!, status: "revoked" } }),
    ).toBeNull();
  });
});
