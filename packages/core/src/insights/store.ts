import { and, desc, eq } from "drizzle-orm";
import type { Database } from "../db/client";
import { newId } from "../db/domain";
import { observations } from "../db/schema";
import type { Observation, ObservationKind } from "./insights";

export async function recordObservation(
  db: Database,
  ownerId: string,
  input: { kind: ObservationKind; key: string; value: number },
): Promise<void> {
  await db.insert(observations).values({
    id: newId(),
    ownerId,
    kind: input.kind,
    subjectKey: input.key.trim().slice(0, 191),
    value: Math.max(0, Math.round(input.value)),
  });
}

export async function listObservations(
  db: Database,
  ownerId: string,
  limit = 500,
): Promise<Observation[]> {
  const rows = await db
    .select()
    .from(observations)
    .where(and(eq(observations.ownerId, ownerId)))
    .orderBy(desc(observations.createdAt))
    .limit(limit);
  return rows.map((row) => ({
    kind: row.kind,
    key: row.subjectKey,
    value: row.value,
    at: row.createdAt,
  }));
}
