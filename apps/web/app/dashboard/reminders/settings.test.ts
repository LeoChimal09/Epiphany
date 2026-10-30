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
  it("shows an editable count rather than hardcoded reminder choices", () => {
    const html = renderToStaticMarkup(
      createElement(SplitReminderSettings, {
        value: { enabled: true, count: 5 },
        dailyLimit: 12,
        version: 3,
      }),
    );
    expect(html).toContain('type="number"');
    expect(html).toContain('value="5"');
    expect(html).toContain("checked");
    expect(html).toContain("original deadline and event alerts stay unchanged");
    expect(html).toContain("daily limit of 12");
    expect(html).toContain("Save split reminder settings");
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
    expect(html).toContain(">Off<");
  });
  it("shows a required count when split reminders are enabled", () => {
    const html = renderToStaticMarkup(
      createElement(SplitReminderSettings, {
        value: { enabled: true, count: 5 },
        dailyLimit: 20,
      }),
    );
    expect(html).toContain('type="number"');
    expect(html).toContain('value="5"');
    expect(html).toContain('required=""');
    expect(html).toContain(">On<");
  });
});

describe("morning briefing settings UI", () => {
  it("shows a local-time control initialized to the effective briefing time", () => {
    const html = renderToStaticMarkup(
      createElement(BriefingSettings, {
        briefingTime: "07:30",
        timezone: "America/Chicago",
        version: 2,
      }),
    );
    expect(html).toContain("Morning briefing");
    expect(html).toContain("Times use America/Chicago.");
    expect(html).toContain('type="time"');
    expect(html).toContain('value="07:30"');
    expect(html).toContain("Send morning briefing");
    expect(html).toContain("Save briefing settings");
    expect(html).toContain("Delivery time (AM/PM)");
    expect(html).toContain("If today&#x27;s was already sent");
  });

  it("shows the briefing as disabled when its saved preference is off", () => {
    const html = renderToStaticMarkup(
      createElement(BriefingSettings, { briefingTime: null, timezone: "America/Chicago" }),
    );
    expect(html).not.toContain('type="time"');
    expect(html).toContain("Send morning briefing");
  });
});
