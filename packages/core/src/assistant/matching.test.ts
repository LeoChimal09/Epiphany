import { describe, expect, it } from "vitest";
import { findDuplicate, ordinalIndex, resolveReference, similarTitles } from "./matching";

const items = [
  { id: "1", title: "Chemistry lab report" },
  { id: "2", title: "History essay draft" },
  { id: "3", title: "Read chapter 4 of Biology" },
  { id: "4", title: "Biology quiz prep" },
];

describe("reference resolution", () => {
  it("finds one task from casual wording", () => {
    for (const phrase of [
      "the chem lab report",
      "chemistry lab",
      "my lab report",
      "lab report assignment",
    ]) {
      const found = resolveReference(phrase, items);
      expect(found, phrase).toMatchObject({ kind: "one", item: { id: "1" } });
    }
  });

  it("matches simple plurals and ignores filler words", () => {
    expect(resolveReference("the history essays", items)).toMatchObject({
      kind: "one",
      item: { id: "2" },
    });
    expect(resolveReference("history essay", items)).toMatchObject({
      kind: "one",
      item: { id: "2" },
    });
  });

  it("reports ambiguity instead of guessing", () => {
    const found = resolveReference("biology", items);
    expect(found.kind).toBe("many");
    if (found.kind === "many")
      expect(found.items.map((item) => item.id).toSorted()).toEqual(["3", "4"]);
  });

  it("reports no match for unrelated or empty references", () => {
    expect(resolveReference("calculus homework", items).kind).toBe("none");
    expect(resolveReference("the task", items).kind).toBe("none");
    expect(resolveReference("", items).kind).toBe("none");
  });

  it("resolves ordinals against the last listed items, not the pool", () => {
    const listed = [items[3]!, items[1]!];
    expect(resolveReference("the second one", items, { listed })).toMatchObject({
      item: { id: "2" },
    });
    expect(resolveReference("#1", items, { listed })).toMatchObject({ item: { id: "4" } });
    expect(resolveReference("third", items, { listed }).kind).toBe("none");
    // Without a previous list an ordinal is just a word and matches nothing.
    expect(resolveReference("2", items).kind).toBe("none");
  });

  it("drops a listed item that no longer exists", () => {
    const listed = [{ id: "gone", title: "Old task" }];
    expect(resolveReference("first", items, { listed }).kind).toBe("none");
  });

  it("only trusts an id that exists among the fetched records", () => {
    expect(resolveReference("whatever", items, { targetId: "3" })).toMatchObject({
      item: { id: "3" },
    });
    expect(
      resolveReference("history essay", items, { targetId: "someone-elses-task" }),
    ).toMatchObject({
      item: { id: "2" },
    });
    expect(resolveReference("calculus", items, { targetId: "someone-elses-task" }).kind).toBe(
      "none",
    );
  });

  it("recognizes ordinal forms", () => {
    expect(ordinalIndex("2")).toBe(2);
    expect(ordinalIndex("#3")).toBe(3);
    expect(ordinalIndex("number 4")).toBe(4);
    expect(ordinalIndex("the fifth one")).toBe(5);
    expect(ordinalIndex("chem lab")).toBeNull();
  });
});

describe("duplicate detection", () => {
  it("does not drop same-title assignments with different course details", () => {
    const existing = [{ title: "Discussion 1", due: "2026-10-22", details: "MATH-225-001" }];
    expect(
      findDuplicate(
        { title: "Discussion 1", due: "2026-10-22", details: "HIST-101-001" },
        existing,
      ),
    ).toBeUndefined();
    expect(
      findDuplicate(
        { title: "Discussion 1", due: "2026-10-22", details: " math-225-001 " },
        existing,
      ),
    ).toBe(existing[0]);
  });

  it("treats abbreviations, plurals, and word order noise as the same title", () => {
    expect(similarTitles("Chem lab report", "Chemistry lab report")).toBe(true);
    expect(similarTitles("read chapter 4", "Read Chapter 4!")).toBe(true);
    expect(similarTitles("history essays", "the history essay")).toBe(true);
  });

  it("keeps genuinely different work apart", () => {
    expect(similarTitles("Essay", "Essay draft")).toBe(false);
    expect(similarTitles("Read chapter 4", "Read chapter 5")).toBe(false);
    expect(similarTitles("Math homework", "History homework")).toBe(false);
    expect(similarTitles("", "Essay")).toBe(false);
  });

  it("matches on deadline unless one side has none, and never across different deadlines", () => {
    const existing = [{ title: "Lab report", due: "2026-10-20" }];
    expect(findDuplicate({ title: "lab report", due: "2026-10-20" }, existing)).toBe(existing[0]);
    expect(findDuplicate({ title: "lab report", due: null }, existing)).toBe(existing[0]);
    expect(findDuplicate({ title: "lab report", due: "2026-10-27" }, existing)).toBeUndefined();
    expect(
      findDuplicate({ title: "lab report", due: null }, [{ title: "Lab report", due: null }]),
    ).toBeDefined();
  });
});
