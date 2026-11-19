import { describe, expect, it } from "vitest"

import {
  activePane,
  closePane,
  closeTab,
  EMPTY_LAYOUT,
  MAX_PANES_PER_TAB,
  openTab,
  panesOf,
  parseLayout,
  splitPane,
  withoutHosts,
  type SplitNode,
} from "./terminal-layout"

describe("terminal layout", () => {
  it("opens a tab with one pane on the host, and makes it active", () => {
    const layout = openTab(EMPTY_LAYOUT, "h1")
    expect(layout.tabs).toHaveLength(1)
    expect(layout.activeTabId).toBe(layout.tabs[0]!.id)
    expect(activePane(layout)?.hostId).toBe("h1")
  })

  it("splits side by side, then adds a third pane as a sibling rather than a nested split", () => {
    let layout = openTab(EMPTY_LAYOUT, "h1")
    const tab = layout.tabs[0]!
    const first = tab.activePaneId
    layout = splitPane(layout, tab.id, first, "horizontal", "h2")
    const second = layout.tabs[0]!.activePaneId
    expect(second).not.toBe(first)
    layout = splitPane(layout, tab.id, second, "horizontal", "h1")
    const root = layout.tabs[0]!.root as SplitNode
    expect(root.kind).toBe("split")
    expect(root.children.map((c) => c.kind)).toEqual(["pane", "pane", "pane"])
    expect(panesOf(root).map((p) => p.hostId)).toEqual(["h1", "h2", "h1"])
  })

  it("nests a split in the other direction, and keeps the existing pane's id", () => {
    let layout = openTab(EMPTY_LAYOUT, "h1")
    const tab = layout.tabs[0]!
    const first = tab.activePaneId
    layout = splitPane(layout, tab.id, first, "horizontal", "h1")
    layout = splitPane(layout, tab.id, first, "vertical", "h2")
    const root = layout.tabs[0]!.root as SplitNode
    expect(root.direction).toBe("horizontal")
    const nested = root.children[0] as SplitNode
    expect(nested.kind).toBe("split")
    expect(nested.direction).toBe("vertical")
    expect(nested.children[0]).toMatchObject({ kind: "pane", id: first })
  })

  it("stops at the pane limit", () => {
    let layout = openTab(EMPTY_LAYOUT, "h1")
    const tabId = layout.tabs[0]!.id
    for (let i = 0; i < MAX_PANES_PER_TAB + 2; i++) {
      layout = splitPane(layout, tabId, layout.tabs[0]!.activePaneId, "horizontal", "h1")
    }
    expect(panesOf(layout.tabs[0]!.root)).toHaveLength(MAX_PANES_PER_TAB)
  })

  it("collapses a split of one when a pane closes, and closes the tab with its last pane", () => {
    let layout = openTab(EMPTY_LAYOUT, "h1")
    const tabId = layout.tabs[0]!.id
    const first = layout.tabs[0]!.activePaneId
    layout = splitPane(layout, tabId, first, "horizontal", "h2")
    const second = layout.tabs[0]!.activePaneId
    layout = closePane(layout, tabId, second)
    expect(layout.tabs[0]!.root).toMatchObject({ kind: "pane", id: first })
    expect(layout.tabs[0]!.activePaneId).toBe(first)
    layout = closePane(layout, tabId, first)
    expect(layout.tabs).toHaveLength(0)
    expect(layout.activeTabId).toBeNull()
  })

  it("moves to the neighbouring tab when the active one closes", () => {
    let layout = openTab(EMPTY_LAYOUT, "h1")
    layout = openTab(layout, "h2")
    layout = openTab(layout, "h3")
    const [a, b, c] = layout.tabs.map((t) => t.id)
    layout = { ...layout, activeTabId: b! }
    layout = closeTab(layout, b!)
    expect(layout.activeTabId).toBe(c)
    layout = closeTab(layout, c!)
    expect(layout.activeTabId).toBe(a)
  })

  it("closes the panes of hosts that are gone", () => {
    let layout = openTab(EMPTY_LAYOUT, "h1")
    const tabId = layout.tabs[0]!.id
    layout = splitPane(layout, tabId, layout.tabs[0]!.activePaneId, "horizontal", "gone")
    layout = openTab(layout, "gone")
    layout = withoutHosts(layout, new Set(["h1"]))
    expect(layout.tabs).toHaveLength(1)
    expect(panesOf(layout.tabs[0]!.root).map((p) => p.hostId)).toEqual(["h1"])
  })

  it("round-trips through storage and drops what is malformed", () => {
    let layout = openTab(EMPTY_LAYOUT, "h1")
    layout = splitPane(layout, layout.tabs[0]!.id, layout.tabs[0]!.activePaneId, "vertical", "h2")
    expect(parseLayout(JSON.parse(JSON.stringify(layout)))).toEqual(layout)
    expect(parseLayout(null)).toEqual(EMPTY_LAYOUT)
    expect(parseLayout({ tabs: [{ id: "t", root: { kind: "pane" } }] })).toEqual(EMPTY_LAYOUT)
    const lone = parseLayout({
      tabs: [{ id: "t", activePaneId: "x", root: { kind: "split", id: "s", direction: "horizontal", children: [{ kind: "pane", id: "p", hostId: "h" }] } }],
    })
    expect(lone.tabs[0]).toEqual({ id: "t", root: { kind: "pane", id: "p", hostId: "h" }, activePaneId: "p" })
  })
})
