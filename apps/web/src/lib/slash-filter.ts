/**
 * Matching what is typed after `/` against the block menu.
 *
 * A title match outranks a keyword match, which outranks a description
 * match: "draw" should offer draw.io before the whiteboard whose keyword it
 * merely is, because enter picks the first. Ties keep menu order.
 */

export interface SlashCandidate {
  title: string;
  description: string;
  keywords: readonly string[];
}

export function filterSlashItems<T extends SlashCandidate>(query: string, items: readonly T[]): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const rank = (item: T): number => {
    const title = item.title.toLowerCase();
    if (title.startsWith(q)) return 0;
    if (title.includes(q)) return 1;
    if (item.keywords.some((k) => k.startsWith(q))) return 2;
    if (item.keywords.some((k) => k.includes(q))) return 3;
    if (item.description.toLowerCase().includes(q)) return 4;
    return -1;
  };
  return items
    .map((item, order) => ({ item, order, rank: rank(item) }))
    .filter((r) => r.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((r) => r.item);
}
