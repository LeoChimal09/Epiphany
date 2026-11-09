// Matches a category name the model or owner suggested against the owner's categories.
// "exact" files the item directly; "similar" and "new" make Epi ask before filing anything.
export type CategoryMatch<C extends { id: string; name: string }> =
  | { kind: "exact"; category: C }
  | { kind: "similar"; category: C; name: string }
  | { kind: "new"; name: string };

export function normalizeCategory(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim()
    .split(" ")
    .map((word) => (word.length > 3 && word.endsWith("s") ? word.slice(0, -1) : word))
    .join(" ");
}

export function cleanCategoryName(name: string): string {
  return name.replace(/\s+/g, " ").trim().slice(0, 100);
}

export function matchCategory<C extends { id: string; name: string }>(
  wanted: string,
  categories: C[],
): CategoryMatch<C> {
  const name = cleanCategoryName(wanted);
  const key = normalizeCategory(name);
  const exact = categories.find((category) => normalizeCategory(category.name) === key);
  if (exact) return { kind: "exact", category: exact };
  if (key.length >= 3) {
    const compact = key.replace(/ /g, "");
    const similar = categories.find((category) => {
      const other = normalizeCategory(category.name);
      const otherCompact = other.replace(/ /g, "");
      if (otherCompact.length < 3) return false;
      if (otherCompact.startsWith(compact) || compact.startsWith(otherCompact)) return true;
      const words = new Set(other.split(" ").filter((word) => word.length >= 3));
      return key.split(" ").some((word) => words.has(word));
    });
    if (similar) return { kind: "similar", category: similar, name };
  }
  return { kind: "new", name };
}
