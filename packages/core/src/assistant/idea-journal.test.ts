import { describe, expect, it } from "vitest";
import { appendIdeaPoints } from "./idea-journal";

describe("dated idea points", () => {
  it("groups flexible labeled additions under the creation date without repeating it", () => {
    const first = appendIdeaPoints(
      "- Feature: A neighborhood tool library",
      ["Concern: Borrowed tools may not be returned", "Goal: Explore manageable return tracking"],
      "2026-10-21",
      "2026-10-21",
    );
    const second = appendIdeaPoints(
      first.body,
      ["Maintenance question: Who repairs damaged tools?"],
      "2026-10-21",
      "2026-10-21",
    );
    expect(second.body.match(/## 2026-10-21/g)).toHaveLength(1);
    expect(second.body).toContain("- Concern: Borrowed tools may not be returned");
    expect(second.body).toContain("- Goal: Explore manageable return tracking");
    expect(second.body).toContain("- Maintenance question: Who repairs damaged tools?");
    expect(second.body).toContain("- Feature: A neighborhood tool library");
  });

  it("preserves a legacy idea and separates additions on later days", () => {
    const first = appendIdeaPoints(
      "Original paragraph.",
      ["Goal: Pilot a small library"],
      "2026-10-20",
      "2026-10-21",
    );
    expect(first.body).toBe(
      "## 2026-10-20\n\nOriginal paragraph.\n\n## 2026-10-21\n\n- Goal: Pilot a small library",
    );
    const next = appendIdeaPoints(
      first.body,
      ["Concern: Storage space"],
      "2026-10-20",
      "2026-10-22",
    );
    expect(next.body).toContain("## 2026-10-22\n\n- Concern: Storage space");
    const earlier = appendIdeaPoints(
      next.body,
      ["Constraint: Limited budget"],
      "2026-10-20",
      "2026-10-21",
    );
    expect(earlier.body.match(/## 2026-10-21/g)).toHaveLength(1);
    expect(earlier.body.indexOf("Constraint: Limited budget")).toBeLessThan(
      earlier.body.indexOf("## 2026-10-22"),
    );
  });

  it("deduplicates existing points even if relabeled and does not create empty date sections", () => {
    const body = "- Track returns\n- Concern: Limited space";
    expect(
      appendIdeaPoints(
        body,
        ["Feature: Track returns", "- Problem: Limited space"],
        "2026-10-20",
        "2026-10-21",
      ),
    ).toEqual({ body, additions: [] });
    const result = appendIdeaPoints(
      body,
      ["- Custom label: New point", "new detail", "Goal: NEW DETAIL"],
      "2026-10-20",
      "2026-10-21",
    );
    expect(result.additions).toEqual(["Custom label: New point", "Note: new detail"]);
  });
});
