import { describe, expect, it } from "vitest";
import { buildInsights, estimateFor, type Observation } from "./insights";

const d = (key: string, value: number): Observation => ({
  kind: "duration",
  key,
  value,
  at: new Date("2026-10-01T00:00:00Z"),
});
const s = (key: string, value: number): Observation => ({
  kind: "snooze",
  key,
  value,
  at: new Date("2026-10-01T00:00:00Z"),
});

describe("behavioral insights", () => {
  it("draws no conclusion from one or two reports, and a median from three or more", () => {
    expect(estimateFor("Chem lab report", [d("Chem lab report", 40)])).toBeNull();
    expect(
      estimateFor("Chem lab report", [d("Chem lab report", 40), d("chemistry lab report", 50)]),
    ).toBeNull();
    const result = estimateFor("Chem lab report", [
      d("Chem lab report", 40),
      d("Chemistry lab report", 60),
      d("chem lab report", 50),
    ]);
    expect(result).toEqual({ minutes: 50, source: "reports", evidence: 3 });
  });

  it("improves with repeated reports and is not thrown off by one outlier", () => {
    const base = [d("Math worksheet", 30), d("Math worksheet", 35), d("math worksheet", 32)];
    expect(estimateFor("Math worksheet", base)?.minutes).toBe(32);
    expect(estimateFor("Math worksheet", [...base, d("Math worksheet", 300)])?.minutes).toBe(34);
  });

  it("only learns from similar work, not from everything", () => {
    const others = [d("History essay", 120), d("History essay", 100), d("History essay", 110)];
    expect(estimateFor("Chem lab report", others)).toBeNull();
  });

  it("lets the owner's correction override anything inferred", () => {
    const reports = [d("Chem lab", 40), d("Chem lab", 45), d("Chem lab", 50)];
    expect(
      estimateFor("Chem lab", reports, { corrections: [{ key: "chem lab", minutes: 90 }] }),
    ).toEqual({
      minutes: 90,
      source: "correction",
      evidence: 0,
    });
    expect(
      estimateFor("New thing", [], { corrections: [{ key: "new thing", minutes: 20 }] })?.minutes,
    ).toBe(20);
  });

  it("builds reviewable insights with their evidence, and needs a stronger pattern for snoozing", () => {
    const observations = [
      d("Chem lab", 40),
      d("Chem lab", 50),
      d("Chem lab", 60),
      s("task_deadline", 30),
      s("task_deadline", 30),
      s("task_deadline", 60),
    ];
    const insights = buildInsights(observations);
    expect(insights).toHaveLength(1);
    expect(insights[0]).toMatchObject({ kind: "estimate", value: 50, evidence: 3 });
    expect(insights[0]!.text).toContain("from 3 times you told me");

    const more = buildInsights([...observations, s("task_deadline", 30), s("task_deadline", 30)]);
    expect(more.map((i) => i.kind)).toContain("snooze_habit");
    expect(buildInsights([s("event", 10), s("event", 10)])).toEqual([]);
    expect(buildInsights([])).toEqual([]);
  });
});
