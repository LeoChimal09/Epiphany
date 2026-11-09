import { describe, expect, it } from "vitest";
import { appendIdeaPoints, reviseRecordBody, splitRecordBody } from "./idea-journal";

describe("dated idea points", () => {
  it("preserves distinct labeled items that share a value", () => {
    const result = appendIdeaPoints("Gift list", ["Boots: size 4", "Shoes: size 4"], "2026-10-21");
    expect(result.additions).toEqual(["Boots: size 4", "Shoes: size 4"]);
  });

  it("groups same-day additions under one dated log heading", () => {
    const first = appendIdeaPoints(
      "- Feature: A neighborhood tool library",
      ["Concern: Borrowed tools may not be returned", "Goal: Explore manageable return tracking"],
      "2026-10-21",
    );
    const second = appendIdeaPoints(
      first.body,
      ["Maintenance question: Who repairs damaged tools?"],
      "2026-10-21",
    );
    expect(second.body.match(/## 2026-10-21/g)).toHaveLength(1);
    expect(second.body).toContain("- Concern: Borrowed tools may not be returned");
    expect(second.body).toContain("- Maintenance question: Who repairs damaged tools?");
    expect(second.body.startsWith("- Feature: A neighborhood tool library")).toBe(true);
  });

  it("keeps undated text as details and separates additions on later days", () => {
    const first = appendIdeaPoints(
      "Original paragraph.",
      ["Goal: Pilot a small library"],
      "2026-10-21",
    );
    expect(first.body).toBe(
      "Original paragraph.\n\n## 2026-10-21\n\n- Goal: Pilot a small library",
    );
    expect(splitRecordBody(first.body)).toEqual({
      details: "Original paragraph.",
      log: "## 2026-10-21\n\n- Goal: Pilot a small library",
    });
    const next = appendIdeaPoints(first.body, ["Concern: Storage space"], "2026-10-22");
    expect(next.body).toContain("## 2026-10-22\n\n- Concern: Storage space");
    const earlier = appendIdeaPoints(next.body, ["Constraint: Limited budget"], "2026-10-21");
    expect(earlier.body.match(/## 2026-10-21/g)).toHaveLength(1);
    expect(earlier.body.indexOf("Constraint: Limited budget")).toBeLessThan(
      earlier.body.indexOf("## 2026-10-22"),
    );
  });

  it("deduplicates existing points even if relabeled and does not create empty date sections", () => {
    const body = "- Track returns\n- Concern: Limited space";
    expect(
      appendIdeaPoints(body, ["Feature: Track returns", "- Problem: Limited space"], "2026-10-21"),
    ).toEqual({ body, additions: [] });
    const result = appendIdeaPoints(
      body,
      ["- Custom label: New point", "new detail", "Goal: NEW DETAIL"],
      "2026-10-21",
    );
    expect(result.additions).toEqual(["Custom label: New point", "Note: new detail"]);
  });
});

describe("revising kept details", () => {
  const legacy =
    "## 2026-11-06\n\nPlanning Black Friday gifts.\n\n- Add item: Fugglers for sister\n\n## 2026-11-09\n\n- Add item for Leo: OLED monitor";

  it("replaces the details, preserves every log entry, and logs the change today", () => {
    const body = reviseRecordBody(
      legacy,
      "### Leo\n- OLED monitor: estimate cost\n\n### Sister\n- Fugglers",
      "Organized gifts by person",
      "2026-11-09",
    );
    const { details, log } = splitRecordBody(body);
    expect(details).toBe("### Leo\n- OLED monitor: estimate cost\n\n### Sister\n- Fugglers");
    expect(log).toContain("## 2026-11-06\n\nPlanning Black Friday gifts.");
    expect(log).toContain("- Add item for Leo: OLED monitor");
    expect(log).toContain("- Update: Organized gifts by person");
    expect(log.match(/## 2026-11-09/g)).toHaveLength(1);
  });

  it("treats a non-date section after a log day as kept details, even with CRLF text", () => {
    const body =
      "## 2026-11-09\r\n\r\n- Add item: OLED monitor\r\n\r\n## Shopping sets\r\n### Leo\r\n- OLED monitor";
    expect(splitRecordBody(body)).toEqual({
      details: "## Shopping sets\n### Leo\n- OLED monitor",
      log: "## 2026-11-09\n\n- Add item: OLED monitor",
    });
    const added = appendIdeaPoints(body, ["Dog sweaters"], "2026-11-09").body;
    expect(added.match(/## 2026-11-09/g)).toHaveLength(1);
    expect(splitRecordBody(added).log).toBe(
      "## 2026-11-09\n\n- Add item: OLED monitor\n\n- Note: Dog sweaters",
    );
  });

  it("replaces existing details and starts a log for a record without one", () => {
    const body = reviseRecordBody("Old summary", "New summary", "Rewrote summary", "2026-11-09");
    expect(body).toBe("New summary\n\n## 2026-11-09\n\n- Update: Rewrote summary");
  });
});
