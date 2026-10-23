import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { providerUsage } from "../db/schema";
import type { UsageStore } from "../assistant/budget";

const MICROS_PER_USD = 1_000_000;

// Spending for one provider kind ("voice") per billing month, kept apart from the text budget.
export function createProviderUsageStore(
  db: Database,
  ownerId: string,
  provider: string,
): UsageStore {
  return {
    async spent(period) {
      const [row] = await db
        .select({ micros: providerUsage.costMicros })
        .from(providerUsage)
        .where(
          and(
            eq(providerUsage.ownerId, ownerId),
            eq(providerUsage.provider, provider),
            eq(providerUsage.period, period),
          ),
        );
      return (row?.micros ?? 0) / MICROS_PER_USD;
    },
    async add(period, costUsd) {
      const micros = Math.max(0, Math.round(costUsd * MICROS_PER_USD));
      await db
        .insert(providerUsage)
        .values({ ownerId, provider, period, costMicros: micros, calls: 1 })
        .onDuplicateKeyUpdate({
          set: {
            costMicros: sql`${providerUsage.costMicros} + ${micros}`,
            calls: sql`${providerUsage.calls} + 1`,
          },
        });
    },
  };
}
