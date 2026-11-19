/**
 * The Terminal page's layout: tabs, each a tree of side-by-side splits with
 * a shell in every leaf. Pure functions over plain data, so the page keeps
 * it in state and in `localStorage` as it is.
 */

export type SplitDirection = "horizontal" | "vertical"

export interface PaneNode {
  kind: "pane"
  id: string
  hostId: string
}

export interface SplitNode {
  kind: "split"
  id: string
  /** `horizontal`: children side by side. `vertical`: stacked. */
  direction: SplitDirection
  children: LayoutNode[]
}

export type LayoutNode = PaneNode | SplitNode

export interface TerminalTab {
  id: string
  root: LayoutNode
  /** The pane that has the keyboard, and that the chat and files follow. */
  activePaneId: string
}

export interface TerminalLayout {
  tabs: TerminalTab[]
  activeTabId: string | null
}

/** Panes one tab holds at most: past four, each is too small to read. */
export const MAX_PANES_PER_TAB = 4

export const EMPTY_LAYOUT: TerminalLayout = { tabs: [], activeTabId: null }

const newId = () => crypto.randomUUID()

export function panesOf(node: LayoutNode): PaneNode[] {
  return node.kind === "pane" ? [node] : node.children.flatMap(panesOf)
}

export function allPanes(layout: TerminalLayout): PaneNode[] {
  return layout.tabs.flatMap((tab) => panesOf(tab.root))
}

export function activeTab(layout: TerminalLayout): TerminalTab | null {
  return layout.tabs.find((tab) => tab.id === layout.activeTabId) ?? null
}

export function activePane(layout: TerminalLayout): PaneNode | null {
  const tab = activeTab(layout)
  if (!tab) return null
  return panesOf(tab.root).find((pane) => pane.id === tab.activePaneId) ?? panesOf(tab.root)[0] ?? null
}

/** A new tab with one shell on `hostId`, made the active one. */
export function openTab(layout: TerminalLayout, hostId: string): TerminalLayout {
  const pane: PaneNode = { kind: "pane", id: newId(), hostId }
  const tab: TerminalTab = { id: newId(), root: pane, activePaneId: pane.id }
  return { tabs: [...layout.tabs, tab], activeTabId: tab.id }
}

/**
 * Splits `paneId` in two, the new shell (on `hostId`) after it. A split in
 * the same direction as the one it is in becomes a sibling there rather
 * than a split inside a split, so three panes side by side share the width
 * evenly. Unchanged when the tab is full.
 */
export function splitPane(
  layout: TerminalLayout,
  tabId: string,
  paneId: string,
  direction: SplitDirection,
  hostId: string,
): TerminalLayout {
  const tab = layout.tabs.find((t) => t.id === tabId)
  if (!tab || panesOf(tab.root).length >= MAX_PANES_PER_TAB) return layout
  const fresh: PaneNode = { kind: "pane", id: newId(), hostId }

  const split = (node: LayoutNode, parent: SplitNode | null): LayoutNode => {
    if (node.kind === "pane") {
      if (node.id !== paneId) return node
      // Handled by the parent when it runs the same way.
      if (parent?.direction === direction) return node
      return { kind: "split", id: newId(), direction, children: [node, fresh] }
    }
    const children: LayoutNode[] = []
    for (const child of node.children) {
      children.push(split(child, node))
      if (node.direction === direction && child.kind === "pane" && child.id === paneId) children.push(fresh)
    }
    return { ...node, children }
  }

  const root = split(tab.root, null)
  return {
    ...layout,
    tabs: layout.tabs.map((t) => (t.id === tabId ? { ...t, root, activePaneId: fresh.id } : t)),
  }
}

/** Closes one pane; a tab left with none closes too. */
export function closePane(layout: TerminalLayout, tabId: string, paneId: string): TerminalLayout {
  const tab = layout.tabs.find((t) => t.id === tabId)
  if (!tab) return layout

  const prune = (node: LayoutNode): LayoutNode | null => {
    if (node.kind === "pane") return node.id === paneId ? null : node
    const children = node.children.map(prune).filter((child): child is LayoutNode => child !== null)
    if (children.length === 0) return null
    // A split of one is just that one.
    if (children.length === 1) return children[0]!
    return { ...node, children }
  }

  const root = prune(tab.root)
  if (!root) return closeTab(layout, tabId)
  const remaining = panesOf(root)
  const activePaneId = remaining.some((p) => p.id === tab.activePaneId) ? tab.activePaneId : remaining.at(-1)!.id
  return { ...layout, tabs: layout.tabs.map((t) => (t.id === tabId ? { ...t, root, activePaneId } : t)) }
}

export function closeTab(layout: TerminalLayout, tabId: string): TerminalLayout {
  const index = layout.tabs.findIndex((t) => t.id === tabId)
  if (index < 0) return layout
  const tabs = layout.tabs.filter((t) => t.id !== tabId)
  const activeTabId =
    layout.activeTabId === tabId ? (tabs[Math.min(index, tabs.length - 1)]?.id ?? null) : layout.activeTabId
  return { tabs, activeTabId }
}

export function focusPane(layout: TerminalLayout, tabId: string, paneId: string): TerminalLayout {
  const tab = layout.tabs.find((t) => t.id === tabId)
  if (!tab || (tab.activePaneId === paneId && layout.activeTabId === tabId)) return layout
  return {
    activeTabId: tabId,
    tabs: layout.tabs.map((t) => (t.id === tabId ? { ...t, activePaneId: paneId } : t)),
  }
}

export function selectTab(layout: TerminalLayout, tabId: string): TerminalLayout {
  return layout.activeTabId === tabId ? layout : { ...layout, activeTabId: tabId }
}

/** Closes every pane on a host that is gone. */
export function withoutHosts(layout: TerminalLayout, known: ReadonlySet<string>): TerminalLayout {
  let next = layout
  for (const tab of layout.tabs) {
    for (const pane of panesOf(tab.root)) {
      if (!known.has(pane.hostId)) next = closePane(next, tab.id, pane.id)
    }
  }
  return next
}

/** A stored layout, if it is one; anything malformed is dropped rather than trusted. */
export function parseLayout(raw: unknown): TerminalLayout {
  if (!raw || typeof raw !== "object") return EMPTY_LAYOUT
  const value = raw as { tabs?: unknown; activeTabId?: unknown }
  if (!Array.isArray(value.tabs)) return EMPTY_LAYOUT
  const node = (input: unknown, depth: number): LayoutNode | null => {
    if (!input || typeof input !== "object" || depth > 6) return null
    const n = input as Record<string, unknown>
    if (n.kind === "pane" && typeof n.id === "string" && typeof n.hostId === "string") {
      return { kind: "pane", id: n.id, hostId: n.hostId }
    }
    if (
      n.kind === "split" &&
      typeof n.id === "string" &&
      (n.direction === "horizontal" || n.direction === "vertical") &&
      Array.isArray(n.children)
    ) {
      const children = n.children.map((c) => node(c, depth + 1)).filter((c): c is LayoutNode => c !== null)
      if (children.length === 0) return null
      if (children.length === 1) return children[0]!
      return { kind: "split", id: n.id, direction: n.direction, children }
    }
    return null
  }
  const tabs: TerminalTab[] = []
  for (const input of value.tabs.slice(0, 20)) {
    if (!input || typeof input !== "object") continue
    const t = input as Record<string, unknown>
    const root = node(t.root, 0)
    if (typeof t.id !== "string" || !root) continue
    const panes = panesOf(root)
    const activePaneId = panes.some((p) => p.id === t.activePaneId) ? (t.activePaneId as string) : panes[0]!.id
    tabs.push({ id: t.id, root, activePaneId })
  }
  const activeTabId = tabs.some((t) => t.id === value.activeTabId) ? (value.activeTabId as string) : (tabs[0]?.id ?? null)
  return { tabs, activeTabId }
}
