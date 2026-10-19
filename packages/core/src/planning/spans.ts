// Half-open time spans [start, end) in epoch milliseconds.
export interface Span {
  start: number;
  end: number;
}

// Sorts and merges overlapping or touching spans, dropping empty ones.
export function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = [];
  for (const span of spans.filter((item) => item.end > item.start).toSorted(bySpanStart)) {
    const last = merged.at(-1);
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end);
    else merged.push({ ...span });
  }
  return merged;
}

// Removes already-merged, sorted blockers from one span.
export function subtractSpans(base: Span, blockers: Span[]): Span[] {
  const remaining: Span[] = [];
  let cursor = base.start;
  for (const blocker of blockers) {
    if (blocker.end <= cursor) continue;
    if (blocker.start >= base.end) break;
    if (blocker.start > cursor) remaining.push({ start: cursor, end: blocker.start });
    cursor = Math.max(cursor, blocker.end);
    if (cursor >= base.end) break;
  }
  if (cursor < base.end) remaining.push({ start: cursor, end: base.end });
  return remaining;
}

function bySpanStart(first: Span, second: Span): number {
  return first.start - second.start || first.end - second.end;
}
