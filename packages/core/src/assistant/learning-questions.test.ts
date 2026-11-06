import { describe, expect, it } from "vitest";
import {
  askedLearningQuestions,
  learningQuestionDue,
  nextLearningQuestion,
} from "./learning-questions";

describe("optional question selection", () => {
  it("never repeats a topic, including after a persisted restart, and stops when exhausted", () => {
    let value: unknown;
    const questions = new Set<string>();
    for (let index = 0; index < 12; index++) {
      const next = nextLearningQuestion(value)!;
      expect(next).not.toBeNull();
      expect(questions.has(next.question)).toBe(false);
      questions.add(next.question);
      value = JSON.parse(JSON.stringify({ asked: next.asked }));
    }
    expect(nextLearningQuestion(value)).toBeNull();
  });
  it("does not repeat the legacy three-question rotation", () => {
    const next = nextLearningQuestion({ index: 1 });
    expect(next?.question).toContain("replies");
    expect(next?.asked).toEqual(
      expect.arrayContaining(["focus-time", "work-sessions", "busy-plans"]),
    );
    expect(nextLearningQuestion({ asked: askedLearningQuestions({ index: 1 }) })).toEqual(next);
  });
  it("requires three elapsed days, not just another calendar date", () => {
    const previous = { day: "2026-11-04", at: "2026-11-04T20:00:00Z" };
    expect(learningQuestionDue(previous, new Date("2026-11-05T20:00:00Z"), "2026-11-05")).toBe(
      false,
    );
    expect(learningQuestionDue(previous, new Date("2026-11-07T19:59:00Z"), "2026-11-07")).toBe(
      false,
    );
    expect(learningQuestionDue(previous, new Date("2026-11-07T20:00:00Z"), "2026-11-07")).toBe(
      true,
    );
    expect(learningQuestionDue({ at: "bad" }, new Date(), "2026-11-07")).toBe(false);
  });
});
