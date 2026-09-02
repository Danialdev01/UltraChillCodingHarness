"use client"

import * as React from "react"
import {
  CodeIcon,
  DatabaseIcon,
  GitBranchIcon,
  ListTodoIcon,
  RocketIcon,
  type LucideIcon,
} from "lucide-react"

import { NavUser } from "@/components/nav-user"
import { QuickActions } from "@/components/quick-actions"
import { QuickMenu } from "@/components/quick-menu"
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
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import type { Project } from "@/lib/session"

/**
 * The five things you do to a project. Each one owns the second column: the
 * icon rail picks a section, the panel beside it shows that section's
 * contents.
 */
export const SECTIONS = [
  { id: "coding", title: "Coding", icon: CodeIcon },
  { id: "database", title: "Database", icon: DatabaseIcon },
  { id: "git", title: "Git", icon: GitBranchIcon },
  { id: "publish", title: "Publish", icon: RocketIcon },
  { id: "todo", title: "Todo", icon: ListTodoIcon },
] as const satisfies readonly { id: string; title: string; icon: LucideIcon }[]

export type SectionId = (typeof SECTIONS)[number]["id"]

/**
 * A two-column sidebar: a fixed icon rail, and a panel whose contents depend
 * on the selected icon.
 *
 * The outer Sidebar is `collapsible="icon"` and lays its children out in a
 * row; the inner one is pinned to icon width so it never collapses. Choosing
 * a section reopens the panel, so clicking an icon while collapsed does
 * something visible rather than nothing.
 */
export function AppSidebar({
  user,
  workspaces,
  activeWorkspaceId,
  projects,
  activeProjectHash,
  ...props
}: React.ComponentProps<typeof Sidebar> & {
  user: { name: string; email: string; avatar: string }
  workspaces: Workspace[]
  activeWorkspaceId: string
  projects: Project[]
  activeProjectHash?: string
}) {
  const [activeSection, setActiveSection] = React.useState<SectionId>("coding")
  const { setOpen, state } = useSidebar()
  const collapsed = state === "collapsed"

  return (
    <Sidebar
      collapsible="icon"
      className="overflow-hidden *:data-[sidebar=sidebar]:flex-row"
      {...props}
    >
      {/* Column 1: the icon rail. */}
      <Sidebar collapsible="none" className="w-[calc(var(--sidebar-width-icon)+1px)]! border-r">
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupContent className="px-1.5 md:px-0">
              <SidebarMenu>
                {SECTIONS.map((section) => (
                  <SidebarMenuItem key={section.id}>
                    <SidebarMenuButton
                      tooltip={{ children: section.title, hidden: false }}
                      onClick={() => {
                        setActiveSection(section.id)
                        setOpen(true)
                      }}
                      isActive={activeSection === section.id}
                      className="px-2.5 md:px-2"
                    >
                      <section.icon />
                      <span>{section.title}</span>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </SidebarContent>
        {/* Collapsed, the rail is all there is, so the profile lives here --
            avatar only, since nothing else fits at icon width. Expanded, it
            moves to the wide column below and this is omitted rather than
            rendered twice. */}
        {collapsed && (
          <SidebarFooter className="items-center p-1.5">
            <NavUser user={user} compact />
          </SidebarFooter>
        )}
      </Sidebar>

      {/* Column 2: whatever the selected section shows. */}
      <Sidebar collapsible="none" className="hidden flex-1 md:flex">
        {/* h-16 + border-b mirrors the page header in app-shell.tsx, so the
            two bottom borders meet as a single unbroken rule across the top.
            Any padding here would push the switcher below that line. */}
        <SidebarHeader className="h-16 shrink-0 justify-center border-b p-0 px-2">
          <WorkspaceSwitcher workspaces={workspaces} activeWorkspaceId={activeWorkspaceId} />
        </SidebarHeader>
        {/* Below the h-16 header, not inside it: the header's height is what
            keeps its bottom border in line with the page header's. */}
        <div className="flex flex-col gap-2 border-b p-2">
          <QuickMenu projects={projects} workspaces={workspaces} />
          <QuickActions />
        </div>

        <SidebarContent>
          <SectionPanel
            section={activeSection}
            projects={projects}
            activeProjectHash={activeProjectHash}
          />
        </SidebarContent>
        {/* Collapsed, this column is clipped out of view but still in the
            DOM -- a rendered profile here would stay focusable and be read
            out, duplicating the rail's. Only one exists at a time. */}
        {!collapsed && (
          <SidebarFooter className="border-t">
            <NavUser user={user} />
          </SidebarFooter>
        )}
      </Sidebar>
    </Sidebar>
  )
}
