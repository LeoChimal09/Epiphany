// Monthly text-AI spending limit. New model calls stop at 100%; nothing silently switches to
// another provider to get around it (docs/decisions/0001-initial-architecture.md).
import { dateKeyOf } from "../planning/time";

export interface BudgetPolicy {
  monthlyLimitUsd: number;
  warnPercent: number;
  // The billing month resets on the 1st in this timezone.
  timezone: string;
}

export interface UsageStore {
  spent(period: string): Promise<number>;
  add(period: string, costUsd: number): Promise<void>;
}

export interface BudgetStatus {
  allowed: boolean;
  warn: boolean;
  spentUsd: number;
  limitUsd: number;
  percent: number;
}

export function budgetPeriod(now: Date, timezone: string): string {
  return dateKeyOf(now, timezone).slice(0, 7);
}

export function createMemoryUsageStore(): UsageStore {
  const totals = new Map<string, number>();
  return {
    async spent(period) {
      return totals.get(period) ?? 0;
    },
    async add(period, costUsd) {
      totals.set(period, (totals.get(period) ?? 0) + costUsd);
    },
  };
}

export function createBudget(
  policy: BudgetPolicy,
  store: UsageStore,
  clock: () => Date = () => new Date(),
) {
  if (!(policy.monthlyLimitUsd > 0)) throw new RangeError("Monthly AI budget must be above zero.");
  if (!(policy.warnPercent > 0 && policy.warnPercent <= 100)) {
    throw new RangeError("Warning threshold must be between 1 and 100 percent.");
  }
  return {
    async check(): Promise<BudgetStatus> {
      const spentUsd = await store.spent(budgetPeriod(clock(), policy.timezone));
      const percent = (spentUsd / policy.monthlyLimitUsd) * 100;
      return {
        allowed: spentUsd < policy.monthlyLimitUsd,
        warn: percent >= policy.warnPercent,
        spentUsd,
        limitUsd: policy.monthlyLimitUsd,
        percent,
      };
    },
    // Called after a provider call completes. Calls already in flight can overshoot slightly.
    async record(costUsd: number): Promise<void> {
      if (!Number.isFinite(costUsd) || costUsd < 0) return;
      await store.add(budgetPeriod(clock(), policy.timezone), costUsd);
    },
  };
}

export type Budget = ReturnType<typeof createBudget>;
