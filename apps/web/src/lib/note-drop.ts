/**
 * Dropping a page onto another in the tree.
 *
 * Pure, so the rules -- where in a row means what, and which drops are
 * refused -- are tested without a browser. The sidebar turns pointer
 * coordinates into a zone, and a zone into the move the API takes.
 */

import { ancestorsOf, childrenOf, type NoteNode } from "./note-tree";

export type DropZone = "before" | "after" | "inside";

/**
 * Where in a row the pointer is. The top and bottom quarters reorder; the
 * middle half nests. A row that cannot be reordered around -- the root --
 * only nests.
 */
export function dropZoneAt(
  offsetY: number,
  rowHeight: number,
  options: { canReorder: boolean },
): DropZone {
  if (!options.canReorder || rowHeight <= 0) return "inside";
  const ratio = offsetY / rowHeight;
  if (ratio < 0.25) return "before";
  if (ratio > 0.75) return "after";
  return "inside";
}

/**
 * The move a drop asks for, or null when it is not allowed: onto itself,
 * into its own subtree, beside the root, or where it already is.
 *
 * Positions are indices among the destination's children with the moved
 * page taken out, which is how the server counts them too.
 */
export function resolveNoteDrop(
  notes: readonly NoteNode[],
  draggedId: string,
  targetId: string,
  zone: DropZone,
): { parentId: string; position: number } | null {
  if (draggedId === targetId) return null;
  const dragged = notes.find((n) => n.id === draggedId);
  const target = notes.find((n) => n.id === targetId);
  if (!dragged || !target || dragged.parentId === null) return null;
  if (ancestorsOf(notes, targetId).some((n) => n.id === draggedId)) return null;

  if (zone === "inside") {
    const siblings = childrenOf(notes, target.id).filter((n) => n.id !== draggedId);
    const position = siblings.length;
    if (dragged.parentId === target.id && siblingIndex(notes, dragged) === position) return null;
    return { parentId: target.id, position };
  }

  if (target.parentId === null) return null;
  const siblings = childrenOf(notes, target.parentId).filter((n) => n.id !== draggedId);
  const at = siblings.findIndex((n) => n.id === targetId);
  const position = zone === "before" ? at : at + 1;
  if (dragged.parentId === target.parentId && siblingIndex(notes, dragged) === position) return null;
  return { parentId: target.parentId, position };
}

/** Where a page sits among its siblings, with itself taken out of the count. */
function siblingIndex(notes: readonly NoteNode[], node: NoteNode): number {
  if (node.parentId === null) return 0;
  return childrenOf(notes, node.parentId).findIndex((n) => n.id === node.id);
}
