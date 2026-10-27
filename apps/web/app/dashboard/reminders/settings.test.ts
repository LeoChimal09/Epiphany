import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { BriefingSettings } from "./settings";

vi.mock("./actions", () => ({ saveBriefingSetting: vi.fn() }));

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
