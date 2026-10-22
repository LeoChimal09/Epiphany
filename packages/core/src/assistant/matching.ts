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
  if (wanted.length === 0) {
    // "Finished it" right after a reminder or a one-item list: "it" can only mean that one item.
    const only = options.listed?.length === 1 ? options.listed[0] : undefined;
    const live = only ? items.find((item) => item.id === only.id) : undefined;
    return live ? { kind: "one", item: live } : { kind: "none" };
  }

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

// Two titles describe the same thing when nearly every meaningful word of each appears in the other
// ("Chem lab report" and "Chemistry lab report"), but not when one merely contains the other
// ("Essay" and "Essay draft").
export function similarTitles(first: string, second: string): boolean {
  const a = tokens(first);
  const b = tokens(second);
  if (a.length === 0 || b.length === 0) return false;
  const share = (from: string[], within: string[]) =>
    from.filter((token) => within.some((other) => tokenMatches(token, other))).length / from.length;
  return share(a, b) >= 0.8 && share(b, a) >= 0.8;
}

// An existing record the candidate probably repeats: a similar title, and the same deadline unless
// one side has none yet (then it is most likely the same item mentioned again).
export function findDuplicate<
  T extends { title: string; due: string | null; details?: string | null },
>(
  candidate: { title: string; due: string | null; details?: string | null },
  existing: readonly T[],
): T | undefined {
  const details = (value: string | null | undefined) =>
    value?.trim().toLowerCase().replace(/\s+/g, " ");
  const candidateDetails = details(candidate.details);
  return existing.find(
    (item) =>
      similarTitles(candidate.title, item.title) &&
      (candidate.due === null || item.due === null || candidate.due === item.due) &&
      // Matching titles can be separate assignments in different courses. Conflicting details
      // are not enough evidence to silently drop one as a duplicate.
      (!candidateDetails || !details(item.details) || candidateDetails === details(item.details)),
  );
}
