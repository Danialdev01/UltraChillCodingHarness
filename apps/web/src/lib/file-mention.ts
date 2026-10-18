/**
 * The composer's `@` picker: where a mention is being typed, which files and
 * folders it could mean, and what the draft looks like once one is picked.
 *
 * Pure, so the textarea only has to hand over its text and caret. What is
 * inserted is the path as text -- `@src/app.ts` -- rather than an attachment:
 * the agent works in the same directory the tree shows, so the path is all it
 * needs to read the file itself, and a mention costs nothing until it does.
 */

import type { TreeEntry } from "@/lib/file-tree";

export interface Mention {
  /** Index of the `@` in the draft. */
  start: number;
  /** What has been typed after it, up to the caret. */
  query: string;
}

/**
 * The mention the caret is at the end of, if any.
 *
 * The `@` must open a word -- start of the text or after whitespace -- so an
 * email address or `user@host` typed in passing does not pop a menu open.
 */
export function mentionAt(text: string, caret: number): Mention | null {
  let i = caret - 1;
  while (i >= 0 && !/\s/.test(text[i]!)) {
    if (text[i] === "@") {
      if (i > 0 && !/\s/.test(text[i - 1]!)) return null;
      return { start: i, query: text.slice(i + 1, caret) };
    }
    i--;
  }
  return null;
}

/** Whether `index` in `text` starts a word: after a separator or a lower-to-upper step. */
function atBoundary(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1]!;
  if (/[^a-zA-Z0-9]/.test(before)) return true;
  return /[a-z]/.test(before) && /[A-Z]/.test(text[index]!);
}

/** How well `query` matches `entry`, or null when it does not. Higher is better. */
export function scoreEntry(entry: TreeEntry, query: string): number | null {
  const q = query.toLowerCase();
  const name = entry.name.toLowerCase();
  const path = entry.path.toLowerCase();

  // The name is what people remember, so a hit there beats one anywhere else.
  const inName = name.indexOf(q);
  if (inName >= 0) {
    if (inName === 0) return 1200;
    return atBoundary(entry.name, inName) ? 1100 : 1000;
  }
  const inPath = path.indexOf(q);
  if (inPath >= 0) return atBoundary(entry.path, inPath) ? 600 : 500;

  // Letters in order with gaps -- `pchat` for `project-chat.tsx` -- scored
  // down by how far they are spread.
  let at = -1;
  let gaps = 0;
  for (const char of q) {
    const next = path.indexOf(char, at + 1);
    if (next < 0) return null;
    if (at >= 0) gaps += next - at - 1;
    at = next;
  }
  return Math.max(1, 300 - gaps);
}

const depth = (path: string) => path.split("/").length;

/** The entries `query` could mean, best first. */
export function rankEntries(entries: readonly TreeEntry[], query: string, limit = 50): TreeEntry[] {
  if (!query) {
    // Nothing typed yet: the top of the project, folders first, as a start.
    return [...entries]
      .sort(
        (a, b) =>
          depth(a.path) - depth(b.path) ||
          (a.kind === b.kind ? 0 : a.kind === "folder" ? -1 : 1) ||
          a.path.localeCompare(b.path),
      )
      .slice(0, limit);
  }
  const scored: { entry: TreeEntry; score: number }[] = [];
  for (const entry of entries) {
    const score = scoreEntry(entry, query);
    if (score !== null) scored.push({ entry, score });
  }
  scored.sort(
    (a, b) =>
      b.score - a.score ||
      a.entry.path.length - b.entry.path.length ||
      a.entry.path.localeCompare(b.entry.path),
  );
  return scored.slice(0, limit).map((s) => s.entry);
}

/**
 * The draft with the mention at `mention` replaced by `entry`'s path.
 *
 * Folders keep a trailing slash so the message says which it is, and a space
 * follows so the next word does not run into the path.
 */
export function insertMention(
  text: string,
  mention: Mention,
  caret: number,
  entry: TreeEntry,
): { text: string; caret: number } {
  const token = `@${entry.path}${entry.kind === "folder" ? "/" : ""} `;
  const after = text.slice(caret).replace(/^ /, "");
  const next = text.slice(0, mention.start) + token + after;
  return { text: next, caret: mention.start + token.length };
}
