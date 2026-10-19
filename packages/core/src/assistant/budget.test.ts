import { describe, expect, it } from "vitest";
import { budgetPeriod, createBudget, createMemoryUsageStore } from "./budget";

const policy = { monthlyLimitUsd: 10, warnPercent: 80, timezone: "America/Chicago" };

describe("monthly AI budget", () => {
  it("resets on the 1st in the billing timezone, not UTC", () => {
    expect(budgetPeriod(new Date("2026-11-01T04:59:00Z"), "America/Chicago")).toBe("2026-10");
    expect(budgetPeriod(new Date("2026-11-01T05:00:00Z"), "America/Chicago")).toBe("2026-11");
  });

  it("warns at the threshold and stops at 100 percent", async () => {
    const store = createMemoryUsageStore();
    const budget = createBudget(policy, store, () => new Date("2026-10-14T12:00:00Z"));
    expect(await budget.check()).toMatchObject({ allowed: true, warn: false, spentUsd: 0 });
    await budget.record(7.9);
    expect(await budget.check()).toMatchObject({ allowed: true, warn: false });
    await budget.record(0.1);
    expect(await budget.check()).toMatchObject({ allowed: true, warn: true, percent: 80 });
    await budget.record(2);
    expect(await budget.check()).toMatchObject({ allowed: false, warn: true, percent: 100 });
  });

  it("starts fresh in a new month without forgetting the old one", async () => {
    const store = createMemoryUsageStore();
    let now = new Date("2026-10-31T12:00:00Z");
    const budget = createBudget(policy, store, () => now);
    await budget.record(10);
    expect((await budget.check()).allowed).toBe(false);
    now = new Date("2026-11-01T12:00:00Z");
    expect(await budget.check()).toMatchObject({ allowed: true, spentUsd: 0 });
    expect(await store.spent("2026-10")).toBe(10);
  });

  it("ignores impossible costs and rejects impossible policies", async () => {
    const store = createMemoryUsageStore();
    const budget = createBudget(policy, store, () => new Date("2026-10-14T12:00:00Z"));
    await budget.record(-5);
    await budget.record(Number.NaN);
    expect((await budget.check()).spentUsd).toBe(0);
    expect(() => createBudget({ ...policy, monthlyLimitUsd: 0 }, store)).toThrow(RangeError);
    expect(() => createBudget({ ...policy, warnPercent: 0 }, store)).toThrow(RangeError);
    expect(() => createBudget({ ...policy, warnPercent: 101 }, store)).toThrow(RangeError);
  });
});
