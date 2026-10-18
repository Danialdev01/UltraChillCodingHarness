"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"
import { usePathname } from "next/navigation"

import { AppLogo } from "@/components/app-logo"
import { NavUser } from "@/components/nav-user"
import { RailItem } from "@/components/rail-flyout"
import { QuickActions } from "@/components/quick-actions"
import { QuickMenu } from "@/components/quick-menu"
import { QuotaRail } from "@/components/quota-rail"
import { SectionPanel } from "@/components/section-panel"
import { WorkspaceSwitcher, type Workspace } from "@/components/workspace-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  useSidebar,
} from "@/components/ui/sidebar"
import { SECTIONS, WORKSPACE_SETTINGS, projectHashFromPath, sectionForPath, type Section } from "@/lib/sections"
import type { Project } from "@/lib/session"
import type { DatabaseConnectionSummary } from "@ucch/protocol"
import { useTransitionRouter } from "@/lib/view-transitions"
import { useShellLists } from "@/lib/queries/bootstrap"

/**
 * Two columns: a fixed icon rail topped by the app logo, and a panel
 * whose contents follow the icon you are on, with the workspace switcher
 * above it. The profile spans both columns across the bottom.
 *
 * The inner Sidebars are pinned so they never collapse; only the outer one
 * does, clipping the panel away and leaving the rail.
 * Each rail icon is a link to that section's page, and the lit one is derived
 * from the URL rather than held in state -- there is no way for the rail to
 * disagree with the address bar. The open project is read the same way: the
 * sidebar belongs to a layout that outlives any one page, so the page cannot
 * be the one to say. Following one also reopens the panel, so
 * clicking an icon while collapsed does something visible rather than
 * nothing.
 */
export function AppSidebar({
  user,
  workspaces: serverWorkspaces,
  activeWorkspaceId,
  projects: serverProjects,
  connections: serverConnections,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; avatar?: string }
  workspaces: Workspace[]
  activeWorkspaceId: string
  projects: Project[]
  connections: DatabaseConnectionSummary[]
}) {
  // Kept current by realtime events rather than by re-rendering the layout.
  const { workspaces, projects, connections } = useShellLists({
    workspaces: serverWorkspaces,
    activeWorkspaceId,
    projects: serverProjects,
    connections: serverConnections,
  })
  const queryClient = useQueryClient()
  const { setOpen, setOpenMobile, state } = useSidebar()
  const collapsed = state === "collapsed"
  const pathname = usePathname()
  const active = sectionForPath(pathname)
  const activeProjectHash = projectHashFromPath(pathname) ?? undefined
  const activeWorkspace = workspaces.find((w) => w.id === activeWorkspaceId)
  const sessionWorkspace = activeWorkspace?.kind === "session"

  // A project opened straight after creating it can arrive before the list
  // knows it. Asking again once, per project, is what puts its row (and a
  // session's card) in the sidebar.
  const refreshedFor = React.useRef<string | null>(null)
  const missing =
    activeProjectHash !== undefined && !projects.some((p) => p.hash === activeProjectHash)
  React.useEffect(() => {
    if (!missing || refreshedFor.current === activeProjectHash) return
    refreshedFor.current = activeProjectHash ?? null
    void queryClient.invalidateQueries({ queryKey: ["bootstrap"] })
  }, [missing, activeProjectHash, queryClient])

  function railItem(section: Section) {
    return (
      <RailItem
        key={section.id}
        section={section}
        isActive={active.id === section.id}
        projects={projects}
        connections={connections}
        activeProjectHash={activeProjectHash}
        onOpenSidebar={() => setOpen(true)}
      />
    )
  }

  return (
    <Sidebar collapsible="icon" className="overflow-hidden" {...props}>
      {/* min-h-0 so the panel's own scroll container bounds itself against
          this row rather than growing the sidebar past the viewport. */}
      <div className="flex min-h-0 flex-1 flex-row">
        {/* Column 1: the icon rail, from the top edge down to the footer. A shade off the
            panel's background, mixed from the theme's own tokens so a palette
            chosen in Settings -> Theme still recolours it. */}
        {/* The fallback is for the phone drawer: it is portalled out of the
            provider that defines --sidebar-width-icon, and an unresolved var
            would drop the width and stretch the rail to fit its labels. */}
        <Sidebar
          collapsible="none"
          className="w-[calc(var(--sidebar-width-icon,3rem)+1px)]! border-r bg-[color-mix(in_oklab,var(--sidebar)_94%,var(--sidebar-foreground))]"
        >
          {/* The same h-16 + border-b as the workspace header beside it, so
              the two bottom borders meet as one rule across the top. */}
          <SidebarHeader className="h-16 shrink-0 justify-center border-b p-0 px-2">
            <AppLogo />
          </SidebarHeader>
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent className="px-0">
                <SidebarMenu>{SECTIONS.map(railItem)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          {/* Outside the scrolling SidebarContent so they stay at the foot of
              the rail rather than below the last section: the quota meters,
              then Settings, which is where the accounts they measure live. */}
          <QuotaRail />
          <SidebarGroup>
            <SidebarGroupContent className="px-0">
              <SidebarMenu>{railItem(WORKSPACE_SETTINGS)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Sidebar>

        {/* Column 2: whatever the selected section shows. `min-w-0` because
            the base width is the whole sidebar's: without it a flex item will
            not shrink below that, so the panel ran a rail's width past the
            sidebar's clipped edge and took the last quick action and every
            title's ellipsis with it. On a phone, a link followed from here
            closes the drawer -- the page it opens is what you came for, and
            the drawer would otherwise cover it. Rail icons keep it open, so
            you can switch sections to browse their panels. */}
        <Sidebar
          collapsible="none"
          className="min-w-0 flex-1"
          onClickCapture={(event) => {
            if ((event.target as Element).closest("a[href]")) setOpenMobile(false)
          }}
        >
          {/* h-16 + border-b mirrors the page header in app-shell.tsx, so the
              bottom borders meet as a single unbroken rule across the top.
              Vertical padding here would push the switcher below that line. */}
          <SidebarHeader className="relative h-16 shrink-0 justify-center border-b p-0 px-2">
            <NightSky />
            {/* Positioned so it paints above the sky, which is. */}
            <div className="relative">
              <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
            </div>
          </SidebarHeader>

          <div className="flex flex-col gap-2 border-b p-2">
            <QuickMenu
              projects={projects}
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
            />
            <QuickActions
              workspaceId={activeWorkspaceId}
              projects={projects}
              sessionWorkspace={sessionWorkspace}
              permissions={activeWorkspace?.permissions ?? []}
            />
          </div>

          <SidebarContent>
            <SectionPanel
              section={active}
              projects={projects}
              connections={connections}
              workspaces={workspaces}
              workspaceId={activeWorkspaceId}
              sessionWorkspace={sessionWorkspace}
              activeProjectHash={activeProjectHash}
            />
          </SidebarContent>
        </Sidebar>
      </div>

      {/* Spans both columns, so the rail stops above it. One footer in both
          states: a second copy inside the collapsed-away column would stay
          focusable and be read out, duplicating this one. */}
      <SidebarFooter className={collapsed ? "items-center border-t p-1.5" : "border-t"}>
        <NavUser user={user} compact={collapsed} />
      </SidebarFooter>
    </Sidebar>
  )
}

/**
 * A few sparkles at fixed spots, each flaring on its own beat. Fixed rather
 * than random so the server and client render the same markup.
 */
const SPARKLES = [
  { x: "22%", y: "18%", s: "10px", dur: "4.4s", d: "0s" },
  { x: "58%", y: "58%", s: "8px", dur: "5.2s", d: "1.6s" },
  { x: "78%", y: "14%", s: "11px", dur: "4.8s", d: "2.8s" },
  { x: "94%", y: "62%", s: "8px", dur: "5.6s", d: "0.9s" },
]

/** The drifting stars behind the workspace switcher; styled in globals.css. */
function NightSky() {
  return (
    <div className="ucch-sky" aria-hidden>
      {SPARKLES.map((p) => (
        <span
          key={`${p.x}-${p.y}`}
          className="ucch-sky-sparkle"
          style={
            { "--x": p.x, "--y": p.y, "--s": p.s, "--dur": p.dur, "--d": p.d } as React.CSSProperties
          }
        />
      ))}
    </div>
  )
}
