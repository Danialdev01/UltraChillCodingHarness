/**
 * The leader key: Doom Emacs's `SPC` menus, on the vim layer.
 *
 * In Doom, space in normal mode opens a tree of short mnemonic menus --
 * `SPC s` for search, `SPC b` for buffers, `SPC f` for files -- and the
 * which-key popup shows what each next key does. This is that tree, with the
 * bindings Doom ships that have something here to point at. The keys and the
 * descriptions are Doom's own (`modules/config/default/+evil-bindings.el`),
 * so muscle memory carries over.
 *
 * The table is data rather than calls into the vim layer so that the popup,
 * the mappings and the tests all read the one source.
 */

/** What a leaf does; the editor decides how. */
export type LeaderCommand =
  | "search-buffer"
  | "save"
  | "find-file"
  | "switch-buffer"
  | "kill-buffer"
  | "next-buffer"
  | "prev-buffer"
  | "search-project"
  | "ex"

export interface LeaderLeaf {
  key: string
  desc: string
  command: LeaderCommand
}

export interface LeaderPrefix {
  key: string
  desc: string
  children: readonly LeaderNode[]
}

export type LeaderNode = LeaderLeaf | LeaderPrefix

/** The key the vim layer names a press of space. */
export const LEADER = "<Space>"

export const LEADER_TREE: readonly LeaderNode[] = [
  { key: ".", desc: "Find file", command: "find-file" },
  { key: ",", desc: "Switch buffer", command: "switch-buffer" },
  { key: "/", desc: "Search project", command: "search-project" },
  { key: ":", desc: "M-x", command: "ex" },
  {
    key: "b",
    desc: "buffer",
    children: [
      { key: "b", desc: "Switch buffer", command: "switch-buffer" },
      { key: "d", desc: "Kill buffer", command: "kill-buffer" },
      { key: "k", desc: "Kill buffer", command: "kill-buffer" },
      { key: "n", desc: "Next buffer", command: "next-buffer" },
      { key: "]", desc: "Next buffer", command: "next-buffer" },
      { key: "p", desc: "Previous buffer", command: "prev-buffer" },
      { key: "[", desc: "Previous buffer", command: "prev-buffer" },
      { key: "s", desc: "Save buffer", command: "save" },
    ],
  },
  {
    key: "f",
    desc: "file",
    children: [
      { key: "f", desc: "Find file", command: "find-file" },
      { key: "s", desc: "Save file", command: "save" },
    ],
  },
  {
    key: "s",
    desc: "search",
    children: [
      { key: "b", desc: "Search buffer", command: "search-buffer" },
      { key: "p", desc: "Search project", command: "search-project" },
      { key: "s", desc: "Search buffer", command: "search-buffer" },
    ],
  },
]

export function isPrefix(node: LeaderNode): node is LeaderPrefix {
  return "children" in node
}

/**
 * Every full sequence, as the vim layer spells it: `<Space>ss`, `<Space>.`.
 *
 * Flattened once at registration time; the vim layer buffers a partial
 * sequence itself, so each leaf is one mapping and prefixes need none.
 */
export function leaderBindings(): { keys: string; command: LeaderCommand }[] {
  const out: { keys: string; command: LeaderCommand }[] = []
  const walk = (nodes: readonly LeaderNode[], prefix: string) => {
    for (const node of nodes) {
      if (isPrefix(node)) walk(node.children, prefix + node.key)
      else out.push({ keys: prefix + node.key, command: node.command })
    }
  }
  walk(LEADER_TREE, LEADER)
  return out
}

/** One row of the which-key popup. */
export interface WhichKeyRow {
  key: string
  desc: string
  prefix: boolean
}

/**
 * What the next key can be, given what has been typed so far.
 *
 * `pending` is the vim layer's key buffer joined up: `<Space>`, `<Space>s`.
 * Null when that is not a leader prefix -- nothing typed, a sequence that is
 * already complete, or a count or operator that happens to be waiting.
 */
export function leaderChildren(pending: string): WhichKeyRow[] | null {
  if (!pending.startsWith(LEADER)) return null
  let nodes: readonly LeaderNode[] = LEADER_TREE
  for (const key of pending.slice(LEADER.length)) {
    const next = nodes.find((node) => node.key === key)
    if (!next || !isPrefix(next)) return null
    nodes = next.children
  }
  return nodes.map((node) => ({ key: node.key, desc: node.desc, prefix: isPrefix(node) }))
}
