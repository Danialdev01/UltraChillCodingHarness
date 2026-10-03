/**
 * Finding a page by name, and merging that with what the server finds in
 * page bodies.
 *
 * Titles are in the tree already, so they match as you type; bodies live on
 * the server. The two lists meet here, titles first, each page once.
 */

import { titleOrUntitled, type NoteNode } from "./note-tree";

export interface NoteSearchHit {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  /** The text around the match, for a body hit; absent for a title hit. */
  snippet?: string;
}

/** Pages whose title contains the query, prefix matches first. */
export function rankTitleMatches<T extends NoteNode>(notes: readonly T[], query: string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return notes
    .map((note, order) => {
      const title = titleOrUntitled(note.title).toLowerCase();
      const rank = title.startsWith(q) ? 0 : title.includes(q) ? 1 : -1;
      return { note, order, rank };
    })
    .filter((r) => r.rank !== -1)
    .sort((a, b) => a.rank - b.rank || a.order - b.order)
    .map((r) => r.note);
}

/** Title hits, then body hits for pages not already listed. */
export function mergeSearchHits(
  titleHits: readonly NoteSearchHit[],
  bodyHits: readonly NoteSearchHit[],
): NoteSearchHit[] {
  const seen = new Set(titleHits.map((h) => h.id));
  return [...titleHits, ...bodyHits.filter((h) => !seen.has(h.id))];
}
