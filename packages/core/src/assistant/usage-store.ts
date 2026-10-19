import { and, eq, sql } from "drizzle-orm";
import type { Database } from "../db/client";
import { aiUsage } from "../db/schema";
import type { UsageStore } from "./budget";

const MICROS_PER_USD = 1_000_000;

export function createDbUsageStore(db: Database, ownerId: string): UsageStore {
  return {
    async spent(period) {
      const [row] = await db
        .select({ micros: aiUsage.costMicros })
        .from(aiUsage)
        .where(and(eq(aiUsage.ownerId, ownerId), eq(aiUsage.period, period)));
      return (row?.micros ?? 0) / MICROS_PER_USD;
    },
    async add(period, costUsd) {
      const micros = Math.max(0, Math.round(costUsd * MICROS_PER_USD));
      await db
        .insert(aiUsage)
        .values({ ownerId, period, costMicros: micros, calls: 1 })
        .onDuplicateKeyUpdate({
          set: {
            costMicros: sql`${aiUsage.costMicros} + ${micros}`,
            calls: sql`${aiUsage.calls} + 1`,
          },
        });
    },
  };
}
