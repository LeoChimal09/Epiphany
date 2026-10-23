import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IdeaBody } from "./idea-body";

describe("idea journal display", () => {
  it("keeps idea content in a native keyboard-accessible accordion, collapsed by default", () => {
    const html = renderToStaticMarkup(
      createElement(IdeaBody, { body: "- Goal: Keep the idea list compact" }),
    );
    expect(html).toMatch(/^<details\b/);
    expect(html).toContain(">Idea details</summary>");
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

  it("leaves invalid date-looking text visible instead of crashing the idea card", () => {
    const html = renderToStaticMarkup(
      createElement(IdeaBody, { body: "## 2026-99-99\n- Concern: Unknown date" }),
    );
    expect(html).toContain("## 2026-99-99");
    expect(html).toContain("Unknown date");
  });
});
