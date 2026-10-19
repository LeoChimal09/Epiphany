import { describe, expect, it } from "vitest";
import { ordinalIndex, resolveReference } from "./matching";

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
