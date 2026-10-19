import { describe, expect, it } from "vitest";
import { EVAL_CASES, goldProvider, judge, runEvaluation } from "./eval";
import { createScriptedProvider } from "./provider";

describe("conversation evaluation harness", () => {
  it("has unique cases that cover every behavior Goal 07 names, with held-out paraphrases", () => {
    const ids = EVAL_CASES.map((testCase) => testCase.id);
    expect(new Set(ids).size).toBe(ids.length);
    const kinds = new Set(EVAL_CASES.map((testCase) => testCase.expect.kind));
    for (const kind of [
      "list_tasks",
      "create_task",
      "complete_task",
      "complete_ambiguous",
      "no_change",
      "delete_note",
      "confirm",
      "decline",
    ]) {
      expect(kinds.has(kind as never), kind).toBe(true);
    }
    const heldOut = EVAL_CASES.filter((testCase) => testCase.group === "held_out");
    expect(heldOut.length).toBeGreaterThan(EVAL_CASES.length / 2);
    const messages = EVAL_CASES.map((testCase) => testCase.message);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it("passes every case when the provider gives the gold answer", async () => {
    const report = await runEvaluation(goldProvider());
    expect(report.results.filter((result) => !result.passed)).toEqual([]);
    expect(report.passed).toBe(report.total);
    expect(report.byGroup.tuning.total + report.byGroup.held_out.total).toBe(report.total);
  });

  it("fails a provider that turns advice into an action", async () => {
    const eager = createScriptedProvider(() => ({
      kind: "complete_task",
      reference: "chem lab",
      targetId: "t-chem",
    }));
    const report = await runEvaluation(eager);
    const advice = report.results.filter((result) => result.id.startsWith("advice-"));
    expect(advice.length).toBeGreaterThan(0);
    expect(advice.every((result) => !result.passed)).toBe(true);
    expect(advice[0]?.reason).toBe("advice became complete_task");
    expect(report.passed).toBeLessThan(report.total / 2);
  });

  it("fails a provider that guesses between ambiguous tasks or completes the wrong one", () => {
    expect(
      judge(
        { kind: "complete_task", reference: "biology" },
        { kind: "complete_task", taskId: "t-bio-read" },
      ),
    ).toBe("reference resolved to many");
    expect(
      judge(
        { kind: "complete_task", reference: "biology reading" },
        { kind: "complete_ambiguous" },
      ),
    ).toBe("resolved to one instead of asking");
    expect(
      judge(
        { kind: "complete_task", reference: "history essay" },
        { kind: "complete_task", taskId: "t-chem" },
      ),
    ).toBe("completed t-hist");
    expect(
      judge({ kind: "clarify", question: "Which one?" }, { kind: "complete_ambiguous" }),
    ).toBeNull();
  });

  it("does not trust a model-supplied id that is not among the shown tasks", () => {
    expect(
      judge(
        { kind: "complete_task", reference: "calculus", targetId: "someone-else" },
        { kind: "complete_task", taskId: "t-calc" },
      ),
    ).toBeNull();
    expect(
      judge(
        { kind: "complete_task", reference: "", targetId: "someone-else" },
        { kind: "complete_task", taskId: "t-calc" },
      ),
    ).toBe("reference resolved to none");
  });

  it("stops spending when the evaluation budget is reached and counts those cases as failed", async () => {
    const costly = createScriptedProvider(() => ({ kind: "respond", text: "ok" }), 1);
    const report = await runEvaluation(costly, { maxCostUsd: 3 });
    expect(report.costUsd).toBe(3);
    expect(
      report.results.filter((result) => result.reason === "evaluation budget reached").length,
    ).toBe(report.total - 3);
    expect(report.passed).toBeLessThan(report.total);
  });

  it("records a provider failure as a failed case rather than crashing the run", async () => {
    const broken = {
      async interpret() {
        throw new Error("secret cause that must not be echoed");
      },
    };
    const report = await runEvaluation(broken, { cases: EVAL_CASES.slice(0, 2) });
    expect(report.results.map((result) => result.passed)).toEqual([false, false]);
    expect(JSON.stringify(report)).not.toContain("secret cause");
  });
});
