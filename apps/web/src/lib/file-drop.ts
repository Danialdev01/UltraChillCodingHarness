/**
 * Dropping files and folders onto a folder in the files tree.
 *
 * Pure, so which drops are refused is tested without a browser. The tree
 * uses it twice: while a drag hovers a folder, to say whether a drop would
 * do anything, and on the drop, to pick what to ask the server to move.
 */

import { dirname } from "./files-api";

/**
 * The dragged paths that would actually move into `folder` ("" is the root).
 *
 * A path nested under another dragged path travels with it, so only the
 * outermost ones count. Dropping something where it already is, or a folder
 * into itself or its own subtree, is not a move and is left out.
 */
export function movableInto(paths: readonly string[], folder: string): string[] {
  const roots = paths.filter(
    (p) => !paths.some((other) => other !== p && p.startsWith(`${other}/`)),
  );
  return roots.filter(
    (p) => dirname(p) !== folder && p !== folder && !folder.startsWith(`${p}/`),
  );
}
