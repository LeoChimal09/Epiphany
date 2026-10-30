import { and, asc, eq } from "drizzle-orm";
import type { z } from "zod";
import type { Database } from "../db/client";
import { newId, recordAction, type Actor } from "../db/domain";
import { events, type CalendarEvent } from "../db/schema";
import { MAX_SERIES_OCCURRENCES, occurrenceDates } from "../planning/recurrence";
import { addDays, localWallToUtc, parseTimeOfDay } from "../planning/time";
import { ValidationError } from "./errors";
import type { createEventSeriesInput } from "./schemas";

export async function createEventSeries(
  db: Database,
  actor: Actor,
  input: z.infer<typeof createEventSeriesInput>,
): Promise<CalendarEvent[]> {
  const seriesId = newId();
  let occurrences: (typeof events.$inferInsert)[];
  try {
    const start = parseTimeOfDay(input.startTime);
    const end = parseTimeOfDay(input.endTime);
    if (end <= start) throw new RangeError("Event end must be after its start.");
    const rule = {
      ...input.recurrence,
      id: seriesId,
      title: input.title,
      timezone: input.timezone,
      startDate: input.startDate,
      startTime: input.startTime,
      durationMinutes: end - start,
      interval: input.recurrence.interval ?? 1,
      exceptions: [],
    };
    const horizon = addDays(input.startDate, 366 * 30);
    if (rule.until && rule.until > horizon) throw new RangeError("Series exceeds 30 years.");
    const dates = occurrenceDates(rule, input.startDate, rule.until ?? horizon);
    if (!dates.length) throw new RangeError("No occurrences match this schedule.");
    if (
      dates.length > MAX_SERIES_OCCURRENCES ||
      (rule.count !== undefined && !rule.until && dates.length < rule.count)
    ) {
      throw new RangeError(`Use at most ${MAX_SERIES_OCCURRENCES} occurrences within 30 years.`);
    }
    // Validate every wall-clock time before writing anything, including DST gaps.
    occurrences = dates.map((date) => ({
      id: newId(),
      ownerId: actor.ownerId,
      seriesId,
      title: input.title,
      timezone: input.timezone,
      startsAt: localWallToUtc(date, start, input.timezone),
      endsAt: localWallToUtc(date, end, input.timezone),
      location: input.location ?? null,
      splitReminderCount: input.splitReminderCount ?? null,
    }));
    if (occurrences.some((event) => event.endsAt <= event.startsAt)) {
      throw new RangeError("An occurrence ends before it starts across a clock change.");
    }
  } catch (error) {
    if (!(error instanceof RangeError)) throw error;
    throw new ValidationError([error.message]);
  }
  await db.transaction(async (tx) => {
    await tx.insert(events).values(occurrences);
    for (const event of occurrences) {
      await recordAction(tx, actor, {
        action: "event.create",
        entityType: "event",
        entityId: event.id,
        after: {
          title: event.title,
          seriesId,
          startsAt: event.startsAt.toISOString(),
          endsAt: event.endsAt.toISOString(),
          recurrence: input.recurrence,
        },
      });
    }
  });
  return db
    .select()
    .from(events)
    .where(and(eq(events.ownerId, actor.ownerId), eq(events.seriesId, seriesId)))
    .orderBy(asc(events.startsAt));
}
