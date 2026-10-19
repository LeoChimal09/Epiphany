// Resolves a spoken reference ("the chem lab thing", "the second one") to exactly one record,
// or says it cannot. A model may suggest an id, but the assistant only trusts ids it can find in
// the records it fetched itself.

const STOP_WORDS = new Set([
  "a",
  "an",
  "the",
  "my",
  "to",
  "of",
  "for",
  "on",
  "in",
  "it",
  "that",
  "this",
  "one",
  "task",
  "assignment",
  "thing",
  "please",
  "and",
]);

const ORDINALS: Record<string, number> = {
  first: 1,
  second: 2,
  third: 3,
  fourth: 4,
  fifth: 5,
  sixth: 6,
  seventh: 7,
  eighth: 8,
  ninth: 9,
  tenth: 10,
};

export interface Candidate {
  id: string;
  title: string;
}

export type Resolution<T extends Candidate> =
  { kind: "one"; item: T } | { kind: "many"; items: T[] } | { kind: "none" };

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token && !STOP_WORDS.has(token));
}

function tokenMatches(reference: string, title: string): boolean {
  if (reference === title) return true;
  // Light stemming: "essays" matches "essay", "reports" matches "report".
  const shortest = Math.min(reference.length, title.length);
  return shortest >= 4 && (title.startsWith(reference) || reference.startsWith(title));
}

// A position in the previously listed items, from "2", "#2", "number 2", or "the second one".
export function ordinalIndex(reference: string): number | null {
  const text = reference.trim().toLowerCase();
  const digits = /^(?:#|no\.?\s*|number\s*)?(\d{1,2})$/.exec(text);
  if (digits) return Number(digits[1]);
  for (const [word, index] of Object.entries(ORDINALS)) {
    if (new RegExp(`\\b${word}\\b`).test(text)) return index;
  }
  return null;
}

export function resolveReference<T extends Candidate>(
  reference: string,
  items: T[],
  options: { listed?: T[]; targetId?: string } = {},
): Resolution<T> {
  if (options.targetId) {
    const byId = items.find((item) => item.id === options.targetId);
    if (byId) return { kind: "one", item: byId };
  }

  const position = ordinalIndex(reference);
  if (position !== null && options.listed && options.listed.length > 0) {
    const listed = options.listed[position - 1];
    const live = listed ? items.find((item) => item.id === listed.id) : undefined;
    return live ? { kind: "one", item: live } : { kind: "none" };
  }

  const wanted = tokens(reference);
  if (wanted.length === 0) return { kind: "none" };

  const scored = items
    .map((item) => {
      const titleTokens = tokens(item.title);
      const hits = wanted.filter((token) => titleTokens.some((t) => tokenMatches(token, t)));
      const exact = wanted.join(" ") === titleTokens.join(" ");
      return { item, score: hits.length / wanted.length, exact };
    })
    .filter((entry) => entry.score >= 0.75);
  if (scored.length === 0) return { kind: "none" };

  const exact = scored.filter((entry) => entry.exact);
  if (exact.length === 1) return { kind: "one", item: exact[0]!.item };

  const best = Math.max(...scored.map((entry) => entry.score));
  const top = scored.filter((entry) => entry.score === best).map((entry) => entry.item);
  return top.length === 1 ? { kind: "one", item: top[0]! } : { kind: "many", items: top };
}
