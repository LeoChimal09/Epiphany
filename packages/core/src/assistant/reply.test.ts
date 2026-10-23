import { describe, expect, it } from "vitest";
import { MAX_REPLY_CHARS, fitReply } from "./assistant";
import { SYSTEM_PROMPT } from "./openai";

describe("fitReply", () => {
  it("leaves a normal conversational answer untouched", () => {
    const text =
      "Start with the history essay, since it's due first. Once that's done, the lab report should feel much lighter.";
    expect(fitReply(text)).toBe(text);
  });

  it("trims surrounding whitespace", () => {
    expect(fitReply("  Sure thing.\n")).toBe("Sure thing.");
  });

  it("cuts an essay at the last whole sentence that fits", () => {
    const sentence = "This is a perfectly reasonable sentence about planning your week. ";
    const essay = sentence.repeat(40);
    const fitted = fitReply(essay);
    expect(fitted.length).toBeLessThanOrEqual(MAX_REPLY_CHARS);
    expect(fitted.endsWith("week.")).toBe(true);
  });

  it("falls back to a word boundary with an ellipsis when there is no sentence end", () => {
    const fitted = fitReply("word ".repeat(400), 100);
    expect(fitted.length).toBeLessThanOrEqual(103);
    expect(fitted.endsWith("...")).toBe(true);
    expect(fitted).not.toMatch(/wor\.\.\.$/);
  });
});

describe("system prompt", () => {
  it("asks for short conversational replies, not terse or essay-length ones", () => {
    expect(SYSTEM_PROMPT).toContain("two to four short sentences");
    expect(SYSTEM_PROMPT).toContain("Do not be curt");
  });
});
