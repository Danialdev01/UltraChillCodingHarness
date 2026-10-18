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

/** One row of the tree as a path from the project root, folders included. */
export interface TreeEntry {
  path: string
  name: string
  kind: "file" | "folder"
}

/**
 * Every file and folder in the tree, depth-first.
 *
 * For the composer's `@` picker, where a folder is as good a thing to point
 * the agent at as a file.
 */
export function flattenEntries(tree: readonly FileNode[]): TreeEntry[] {
  const out: TreeEntry[] = []
  const walk = (nodes: readonly FileNode[], parent: string) => {
    for (const node of nodes) {
      const path = parent ? `${parent}/${node.name}` : node.name
      out.push({ path, name: node.name, kind: node.children ? "folder" : "file" })
      if (node.children) walk(node.children, path)
    }
  }
  walk(tree, "")
  return out
}
