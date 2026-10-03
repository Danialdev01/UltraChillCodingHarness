import type { FileNode } from "@/lib/files-api"

/**
 * Every file in the tree as a path from the project root, folders left out.
 *
 * For a picker over the whole project: `SPC .` wants the files, not the
 * rows, so folders and whether they are open do not come into it.
 */
export function flattenTree(tree: readonly FileNode[]): string[] {
  const out: string[] = []
  const walk = (nodes: readonly FileNode[], parent: string) => {
    for (const node of nodes) {
      const full = parent ? `${parent}/${node.name}` : node.name
      if (node.children) walk(node.children, full)
      else out.push(full)
    }
  }
  walk(tree, "")
  return out
}
