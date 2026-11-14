import * as React from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { describe, expect, it, vi } from "vitest"

import type { SidebarSession } from "@/lib/session-sidebar"

// Outside Next there is no router for the link to transition with.
vi.mock("@/lib/view-transitions", () => ({
  TransitionLink: ({ href, children, ...props }: { href: string; children?: React.ReactNode }) =>
    React.createElement("a", { href, ...props }, children),
}))

const { SessionCard } = await import("./session-card")
const { HarnessIcon } = await import("@/components/harness-icon")

const session = (provider: string | null): SidebarSession => ({
  id: "s1",
  hash: "abcdefabcdef",
  title: "Identify project purpose",
  status: "idle",
  provider,
  model: null,
  lastTurn: "done",
  branch: "main",
  baseBranch: null,
  worktreeState: null,
  pinned: false,
  archivedAt: null,
  lastActivityAt: "2026-11-07T06:00:00Z",
  createdAt: "2026-11-07T05:00:00Z",
  createdByUserId: "u1",
  project: { id: "p1", hash: "bakery000001", name: "BakeryShop", stack: null },
})

const render = (provider: string | null, hideProject = false) =>
  renderToStaticMarkup(
    React.createElement(SessionCard, {
      session: session(provider),
      status: "settled",
      href: "/ws/p/bakery000001/abcdefabcdef",
      time: "6h",
      modelLabel: "Opus 5.5",
      hostName: "dbot",
      hideProject,
      actions: [{ label: "Rename", onSelect: () => {} }],
    }),
  )

describe("SessionCard", () => {
  it.each([
    ["claude", "Claude Code"],
    ["codex", "Codex"],
    ["omp", "Default"],
    ["native", "Default"],
    ["gemini", "Agent"],
    [null, "Agent"],
  ])("shows the %s harness's mark, named for screen readers", (provider, name) => {
    const html = render(provider)
    expect(html).toContain(`aria-label="${name}"`)
    expect(html).toContain(`<title>${name}</title>`)
  })

  it("reads project, title, branch and age, and links to the session", () => {
    const html = render("claude")
    expect(html).toContain("BakeryShop")
    expect(html).toContain("Identify project purpose")
    expect(html).toContain(">main<")
    expect(html).toContain("6h")
    expect(html).toContain('href="/ws/p/bakery000001/abcdefabcdef"')
    // The details are described by the hover card.
    expect(html).toMatch(/aria-describedby="[^"]+"/)
  })

  it("leaves the project out inside its group", () => {
    expect(render("codex", true)).not.toContain("BakeryShop")
  })
})

describe("HarnessIcon", () => {
  it("tints Claude's mark and lets Codex's follow the theme", () => {
    expect(renderToStaticMarkup(React.createElement(HarnessIcon, { harness: "claude" }))).toContain('fill="#D97757"')
    expect(renderToStaticMarkup(React.createElement(HarnessIcon, { harness: "codex" }))).toContain('fill="currentColor"')
  })

  it("breathes while running, sized as asked", () => {
    const html = renderToStaticMarkup(React.createElement(HarnessIcon, { harness: "codex", size: 20, pulse: true }))
    expect(html).toContain('width="20"')
    expect(html).toContain("animate-pulse")
  })
})
