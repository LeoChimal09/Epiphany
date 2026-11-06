import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BriefingSettings, SplitReminderFields, SplitReminderSettings } from "./settings";

vi.mock("./actions", () => ({ saveBriefingSetting: vi.fn(), saveSplitReminderSetting: vi.fn() }));

describe("optional split reminder controls", () => {
  it("offers split reminder fields that save with an item, not a nested workspace-settings form", () => {
    const html = renderToStaticMarkup(createElement(SplitReminderFields, { count: 5 }));
    expect(html).toContain('name="splitReminderMode"');
    expect(html).toContain('name="splitReminderCount"');
    expect(html).toContain('value="5"');
    expect(html).toContain("Saved with this item");
    expect(html).not.toContain("<form");
    expect(html).not.toContain("Save split reminder settings");
  });
  it("supports inheriting the workspace default or opting out for just this item", () => {
    expect(renderToStaticMarkup(createElement(SplitReminderFields, {}))).toContain(
      'value="default" selected',
    );
    expect(renderToStaticMarkup(createElement(SplitReminderFields, { count: 0 }))).toContain(
      'value="off" selected',
    );
  });
  it("does not offer task-only reminder settings for todos or imply events inherit task defaults", () => {
    const todo = renderToStaticMarkup(createElement(SplitReminderFields, { itemType: "todo" }));
    expect(todo).not.toContain("<select");
    expect(todo).not.toContain("<input");
    expect(todo).toContain("split reminders do not apply");
    const event = renderToStaticMarkup(createElement(SplitReminderFields, { itemType: "event" }));
    expect(event).toContain("Off (event default)");
    expect(event).not.toContain("Use workspace default");
    expect(event).not.toContain('name="splitReminderCount"');
  });
  it("shows the saved count in a compact row, without exposing a form until editing", () => {
    const html = renderToStaticMarkup(
      createElement(SplitReminderSettings, {
        value: { enabled: true, count: 5 },
        dailyLimit: 12,
        version: 3,
      }),
    );
    expect(html).toContain("5 extra per task");
    expect(html).toContain('aria-label="Edit extra task reminders"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("<form");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Save changes");
    expect(html).not.toContain("<details");
  });

  it("hides the count while split reminders are off", () => {
    const html = renderToStaticMarkup(
      createElement(SplitReminderSettings, {
        value: { enabled: false, count: 2 },
        dailyLimit: 12,
      }),
    );
    expect(html).not.toContain('type="number"');
    expect(html).not.toContain("checked");
    expect(html).toContain("Off · original alerts only");
  });
  it("does not mistake saved enabled reminders for an unsaved toggle", () => {
    const html = renderToStaticMarkup(
      createElement(SplitReminderSettings, {
        value: { enabled: true, count: 5 },
        dailyLimit: 20,
      }),
    );
    expect(html).toContain("5 extra per task");
    expect(html).not.toContain(">On<");
    expect(html).not.toContain('type="checkbox"');
  });
});

describe("morning briefing settings UI", () => {
  it("summarizes the saved local delivery time without a misleading On badge or save button", () => {
    const html = renderToStaticMarkup(
      createElement(BriefingSettings, {
        briefingTime: "07:30",
        timezone: "America/Chicago",
        version: 2,
      }),
    );
    expect(html).toContain("Morning briefing");
    expect(html).not.toContain("<details");
    expect(html).toContain("Daily at 7:30 AM");
    expect(html).toContain('aria-label="Edit morning briefing"');
    expect(html).toContain("lucide-sunrise");
    expect(html).not.toContain("<form");
    expect(html).not.toContain(">On<");
    expect(html).not.toContain("Save changes");
  });

  it("shows the briefing as disabled when its saved preference is off", () => {
    const html = renderToStaticMarkup(
      createElement(BriefingSettings, { briefingTime: null, timezone: "America/Chicago" }),
    );
    expect(html).not.toContain('type="time"');
    expect(html).toContain(">Off<");
    expect(html).toContain('aria-label="Edit morning briefing"');
  });
});
