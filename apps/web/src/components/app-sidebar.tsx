"use client"

import * as React from "react"
import { usePathname } from "next/navigation"

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
import { SECTIONS, SETTINGS, projectHashFromPath, sectionForPath, type Section } from "@/lib/sections"
import type { Project } from "@/lib/session"
import type { DatabaseConnectionSummary } from "@ucch/protocol"

/**
 * The workspace switcher across the top, the profile across the bottom, and
 * between them two columns: a fixed icon rail, and a panel whose contents
 * follow the icon you are on.
 *
 * Switcher and profile span the full width rather than sitting in the second
 * column, because both are scoped to the whole sidebar and not to either
 * column -- the workspace owns the rail's sections and the panel's projects
 * alike, and there is one signed-in user however the sidebar is laid out. The
 * inner Sidebars are pinned so they never collapse; only the outer one does.
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
  workspaces,
  activeWorkspaceId,
  projects,
  connections,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; avatar?: string }
  workspaces: Workspace[]
  activeWorkspaceId: string
  projects: Project[]
  connections: DatabaseConnectionSummary[]
}) {
  const { setOpen, state } = useSidebar()
  const collapsed = state === "collapsed"
  const pathname = usePathname()
  const active = sectionForPath(pathname)
  const activeProjectHash = projectHashFromPath(pathname) ?? undefined

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
      {/* Spans both columns. h-16 + border-b mirrors the page header in
          app-shell.tsx, so the two bottom borders meet as a single unbroken
          rule across the top. Vertical padding here would push the switcher
          below that line. */}
      <SidebarHeader className="h-16 shrink-0 justify-center border-b p-0 px-2">
        <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
      </SidebarHeader>

      {/* min-h-0 so the panel's own scroll container bounds itself against
          this row rather than growing the sidebar past the viewport. */}
      <div className="flex min-h-0 flex-1 flex-row">
        {/* Column 1: the icon rail. */}
        <Sidebar collapsible="none" className="w-[calc(var(--sidebar-width-icon)+1px)]! border-r">
          <SidebarContent>
            <SidebarGroup>
              <SidebarGroupContent className="px-1.5 md:px-0">
                <SidebarMenu>{SECTIONS.map(railItem)}</SidebarMenu>
              </SidebarGroupContent>
            </SidebarGroup>
          </SidebarContent>
          {/* Outside the scrolling SidebarContent so they stay at the foot of
              the rail rather than below the last section: the quota meters,
              then Settings, which is where the accounts they measure live. */}
          <QuotaRail />
          <SidebarGroup>
            <SidebarGroupContent className="px-1.5 md:px-0">
              <SidebarMenu>{railItem(SETTINGS)}</SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </Sidebar>

        {/* Column 2: whatever the selected section shows. */}
        <Sidebar collapsible="none" className="hidden flex-1 md:flex">
          <div className="flex flex-col gap-2 border-b p-2">
            <QuickMenu
              projects={projects}
              workspaces={workspaces}
              activeWorkspaceId={activeWorkspaceId}
            />
            <QuickActions workspaceId={activeWorkspaceId} />
          </div>

          <SidebarContent>
            <SectionPanel
              section={active}
              projects={projects}
              connections={connections}
              workspaceId={activeWorkspaceId}
              activeProjectHash={activeProjectHash}
            />
          </SidebarContent>
        </Sidebar>
      </div>

      {/* Spans both columns, like the header, so the rail sits between the
          two rather than running the full height alongside them. One footer
          in both states: a second copy inside the collapsed-away column would
          stay focusable and be read out, duplicating this one. */}
      <SidebarFooter className={collapsed ? "items-center border-t p-1.5" : "border-t"}>
        <NavUser user={user} compact={collapsed} />
      </SidebarFooter>
    </Sidebar>
  )
}
