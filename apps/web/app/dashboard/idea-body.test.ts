import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IdeaBody, recordPreview, RecordText, splitRecord } from "./idea-body";

describe("idea journal display", () => {
  it("renders organized headings, lists, and paragraphs without interpreting HTML", () => {
    const html = renderToStaticMarkup(
      createElement(RecordText, {
        body: "## Gifts\n- **Boots** in size 4\n- Coat: blue\n\nBring wrapping paper.\n\n1. Buy supplies\n2. Wrap gifts\n<script>alert('unsafe')</script>",
      }),
    );
    expect(html).toContain("<h3>Gifts</h3><ul>");
    expect(html).toContain("<strong>Boots</strong> in size 4");
    expect(html).toContain("<ol><li>Buy supplies</li><li>Wrap gifts</li></ol>");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });
  it("uses a note-specific collapsed details label", () => {
    const html = renderToStaticMarkup(
      createElement(IdeaBody, { body: "- First\n- Second", label: "Note details" }),
    );
    expect(html).toContain("Note details");
    expect(html).not.toContain("<details open");
    expect(html).not.toContain("Idea details");
  });
  it("keeps idea content in a native keyboard-accessible accordion, collapsed by default", () => {
    const html = renderToStaticMarkup(
      createElement(IdeaBody, { body: "- Goal: Keep the idea list compact" }),
    );
    expect(html).toMatch(/^<div[^>]*><details\b/);
    expect(html).toContain(">Idea details</span>");
    expect(html).not.toMatch(/<details[^>]*\bopen(?:[=\s>])/);
    expect(html).toContain("Keep the idea list compact");
    expect(html).toContain("</details>");
  });

  it("shows date groups, bullets, and flexible labels without repeating dates for each point", () => {
    const html = renderToStaticMarkup(
      createElement(IdeaBody, {
        body: "## 2026-10-21\n\n- Concern: Broken references\n- Goal: Explore reliable references\n- Custom label: Keep things simple\n\n## 2026-10-22\n\n- Open question: What should we try first?",
      }),
    );
    expect(html.match(/dateTime="2026-10-21"/gi)).toHaveLength(1);
    expect(html).toContain("Oct 21, 2026");
    expect(html).toContain("<strong>Concern:</strong>");
    expect(html).toContain("<strong>Custom label:</strong>");
    expect(html.match(/<li>/g)).toHaveLength(4);
    expect(html).not.toContain("## ");
  });

  it("preserves old prose and plain bullets, escaping rather than executing HTML", () => {
    const html = renderToStaticMarkup(
      createElement(IdeaBody, {
        body: "Original idea\n- Original feature\n- Concern: <script>alert(1)</script>",
      }),
    );
    expect(html).toContain("Original idea");
    expect(html).toContain("Original feature");
    expect(html).toContain("&lt;script&gt;");
    expect(html).not.toContain("<script>");
  });

  it("separates kept details from the dated update log in two collapsed dropdowns", () => {
    const body =
      "### Leo\n- OLED monitor: estimate cost\n\n## 2026-11-06\n\n- Add item: Fugglers\n\n## 2026-11-09\n\n- Update: Organized by person";
    const html = renderToStaticMarkup(createElement(IdeaBody, { body }));
    expect(html.match(/<details\b/g)).toHaveLength(2);
    expect(html).not.toMatch(/<details[^>]*\bopen(?:[=\s>])/);
    const [details, log] = html.split("</details>");
    expect(details).toContain(">Idea details</span>");
    expect(details).toContain("OLED monitor");
    expect(details).not.toContain("Fugglers");
    expect(log).toContain("Update log</span><small>2 days</small>");
    expect(log).toContain("Nov 6, 2026");
    expect(log).toContain("Organized by person");
    expect(recordPreview(body)).toBe("Leo OLED monitor: estimate cost");
  });

  it("shows a non-date section after a log day as kept details", () => {
    expect(
      splitRecord("## 2026-11-09\r\n- Add item: OLED\r\n## Shopping sets\r\n### Leo\r\n- OLED"),
    ).toEqual({
      details: "## Shopping sets\n### Leo\n- OLED",
      log: [{ date: "2026-11-09", text: "- Add item: OLED" }],
    });
  });

  it("leaves invalid date-looking text visible instead of crashing the idea card", () => {
    const html = renderToStaticMarkup(
      createElement(IdeaBody, { body: "## 2026-99-99\n- Concern: Unknown date" }),
    );
    expect(html).toContain("2026-99-99");
    expect(html).not.toContain('dateTime="2026-99-99"');
    expect(html).toContain("Unknown date");
  });
});
