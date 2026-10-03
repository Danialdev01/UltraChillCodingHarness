/**
 * The shape of a project's notes, from the flat list the API sends.
 *
 * Pure functions over `NoteSummary[]` so the sidebar, the breadcrumb, and the
 * page-link blocks all read the same list -- and so the tree logic is
 * testable without a component.
 */

export interface NoteNode {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  position: number;
}

export interface NoteTree extends NoteNode {
  children: NoteTree[];
}

function byPosition(a: NoteNode, b: NoteNode): number {
  return a.position - b.position || a.id.localeCompare(b.id);
}

/** The root, or null before the list has loaded. */
export function findRoot<T extends NoteNode>(notes: readonly T[]): T | null {
  return notes.find((n) => n.parentId === null) ?? null;
}

/** A page's children, in order. */
export function childrenOf<T extends NoteNode>(notes: readonly T[], parentId: string): T[] {
  return notes.filter((n) => n.parentId === parentId).sort(byPosition);
}

/**
 * The tree from the root down.
 *
 * A page whose parent is missing -- deleted under it between two fetches --
 * is dropped rather than shown at the top level, where it would look like a
 * second root.
 */
export function buildNoteTree(notes: readonly NoteNode[]): NoteTree | null {
  const root = findRoot(notes);
  if (!root) return null;
  const seen = new Set<string>();
  const build = (node: NoteNode): NoteTree => {
    seen.add(node.id);
    const children = childrenOf(notes, node.id)
      .filter((c) => !seen.has(c.id))
      .map(build);
    return { ...node, children };
  };
  return build(root);
}

/**
 * The path from the root to a page, root first and the page itself last.
 * Empty when the page is not in the list.
 */
export function ancestorsOf<T extends NoteNode>(notes: readonly T[], id: string): T[] {
  const byId = new Map(notes.map((n) => [n.id, n]));
  const path: T[] = [];
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current && !seen.has(current.id)) {
    path.unshift(current);
    seen.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  // A path that never reached the root is a page whose ancestor is gone.
  return path[0]?.parentId === null ? path : [];
}

/** What a page is called where a blank would be confusing. */
export function titleOrUntitled(title: string): string {
  return title.trim() || "Untitled";
}
