import { replacement } from "@ucch/protocol";

/**
 * The edit that brings a file's open document up to date with the disk.
 *
 * `base` is what the disk held when the document last matched it, `local`
 * the document now, `remote` the disk now. With nothing typed since the last
 * write-back (`local === base`) it is the disk's own change. Otherwise the
 * typing and the disk's change are each one span (`replacement`), and when
 * the spans do not touch, the disk's is moved past the typing so both stay.
 * When they overlap there is no right answer; the disk's version of the file
 * wins, since it is the newer write. Null when there is nothing to do.
 */
export function rebase(
  base: string,
  local: string,
  remote: string,
): { from: number; to: number; insert: string } | null {
  if (local === base) return replacement(local, remote);
  const theirs = replacement(base, remote);
  if (!theirs) return null;
  const ours = replacement(base, local)!;
  // Two inserts at one place could go in either order: not a guess to make.
  const samePoint = ours.from === ours.to && theirs.from === theirs.to && ours.from === theirs.from;
  if (!samePoint && theirs.from >= ours.to) {
    // After ours: moved by however much ours grew or shrank the text.
    const shift = ours.insert.length - (ours.to - ours.from);
    return { from: theirs.from + shift, to: theirs.to + shift, insert: theirs.insert };
  }
  // Before ours: positions there are the same in both.
  if (!samePoint && theirs.to <= ours.from) return theirs;
  return replacement(local, remote);
}
