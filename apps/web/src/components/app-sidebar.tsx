"use client"

import * as React from "react"
import { useQueryClient } from "@tanstack/react-query"

import { NavUser } from "@/components/nav-user"
import { RAIL_BUTTON, RailIndicator, RailItem } from "@/components/rail-flyout"
import { QuickActions } from "@/components/quick-actions"
import { QuickMenu } from "@/components/quick-menu"
import { QuotaRail } from "@/components/quota-rail"
import { SectionPanel } from "@/components/section-panel"
import { SkyBackdrop } from "@/components/sidebar/sky-backdrop"
import { WorkspaceHeader } from "@/components/sidebar/workspace-header"
import { WorkspaceLogo } from "@/components/sidebar/workspace-logo"
import { WorkspaceSwitcher } from "@/components/workspace-switcher"
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar"
import { WORKSPACE_SETTINGS, projectHashFromPath, SECTIONS, sectionForPath, type Section } from "@/lib/sections"
import { useShellPathname } from "@/lib/view-transitions"
import { useShell } from "@/lib/workspace-context"
import { useWorkspaceSessionStats } from "@/lib/queries/workspace-sessions"
import { useResourcesPanel } from "@/lib/resources-panel"
import { ResourcesPanel } from "@/components/resources/resources-panel"
import { FolderIcon } from "lucide-react"

/**
 * Two columns: a fixed icon rail topped by the workspace's own logo, with
 * the account at its foot, and a panel whose contents follow the icon you
 * are on, under the workspace header and the command bar.
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
export function AppSidebar(props: React.ComponentProps<typeof Sidebar>) {
  // Follows the address and realtime events, not the layout's own render.
  const { me, workspace: activeWorkspace, workspaces, projects, connections, loading } = useShell()
  const activeWorkspaceId = activeWorkspace?.id ?? ""
  const shownUser = {
    name: me.name ?? me.login ?? "User",
    email: me.email ?? "",
    // `undefined`, never "": an empty `src` is a request for the page
    // itself, which the browser then reports as a broken image.
    avatar: me.avatarUrl ?? undefined,
  }
  const queryClient = useQueryClient()
  const { setOpen, setOpenMobile } = useSidebar()
  const pathname = useShellPathname()
  const active = sectionForPath(pathname)
  const activeProjectHash = projectHashFromPath(pathname) ?? undefined
  const sessionWorkspace = activeWorkspace?.kind === "session"
  // Resources replaces the panel, not the page: while it is open the rail
  // lights its folder rather than the URL's section.
  const resources = useResourcesPanel()
  const stats = useWorkspaceSessionStats(activeWorkspaceId)
  // Held here so the rail's logo and the header's name open the same list.
  const [switcherOpen, setSwitcherOpen] = React.useState(false)

  // A project opened straight after creating it can arrive before the list
  // knows it. Asking again once, per project, is what puts its row (and a
  // session's card) in the sidebar.
  const refreshedFor = React.useRef<string | null>(null)
  const missing =
    !loading && activeProjectHash !== undefined && !projects.some((p) => p.hash === activeProjectHash)
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
        isActive={!resources.open && active.id === section.id}
        projects={projects}
        connections={connections}
        activeProjectHash={activeProjectHash}
        onOpenSidebar={() => {
          resources.setOpen(false)
          setOpen(true)
        }}
      />
    )
  }

  return (
    <Sidebar collapsible="icon" className="overflow-hidden" {...props}>
      {/* min-h-0 so the panel's own scroll container bounds itself against
          this row rather than growing the sidebar past the viewport. */}
      <div className="flex min-h-0 flex-1 flex-row">
        {/* Column 1: the icon rail. The workspace at the top, the sections,
            then the usage gauge, settings and the account pinned to the
            foot. Only the sections scroll, so on a short window the foot
            stays on screen. */}
        {/* The width fallback is for the phone drawer: it is portalled out of
            the provider that defines --sidebar-width-icon, and an unresolved
            var would drop the width and stretch the rail to fit its labels. */}
        <Sidebar
          collapsible="none"
          className="border-sidebar-border w-[calc(var(--sidebar-width-icon,3.375rem)+1px)]! items-center border-r py-3"
        >
          <WorkspaceLogo
            name={activeWorkspace?.name ?? "Workspace"}
            logo={activeWorkspace?.logo ?? null}
            running={stats.running}
            onClick={() => {
              // Collapsed, the name it opens under is clipped away: open the
              // panel first, and the list follows it out.
              setOpen(true)
              setSwitcherOpen(true)
            }}
          />
          <span className="bg-border mb-1.5 h-px w-5 shrink-0" aria-hidden />
          <nav
            aria-label="Sections"
            className="min-h-0 w-full flex-1 overflow-x-hidden overflow-y-auto [scrollbar-width:none]"
          >
            <SidebarMenu className="gap-1.5">
              {SECTIONS.map(railItem)}
              <ResourcesRailItem
                active={resources.open}
                onToggle={() => {
                  resources.toggle()
                  setOpen(true)
                }}
              />
            </SidebarMenu>
          </nav>
          <div className="flex w-full shrink-0 flex-col items-center gap-1.5 pt-1.5">
            <QuotaRail />
            <SidebarMenu>{railItem(WORKSPACE_SETTINGS)}</SidebarMenu>
            <NavUser user={shownUser} />
          </div>
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
          {/* The workspace header and the command bar, over the sky. */}
          <div className="relative shrink-0 overflow-hidden">
            <SkyBackdrop />
            <div className="relative px-3 pt-3.5 pb-3">
              <WorkspaceHeader
                switcher={
                  <WorkspaceSwitcher
                    workspaces={workspaces}
                    activeWorkspaceId={activeWorkspaceId}
                    open={switcherOpen}
                    onOpenChange={setSwitcherOpen}
                  />
                }
                running={stats.running}
                projectCount={loading ? (activeWorkspace?.projectCount ?? 0) : projects.length}
                sessionCount={stats.sessions}
                sessionWorkspace={sessionWorkspace}
              />
              {/* Search and the quick actions, as one shape. Frosted, so the
                  stars or the sun behind it do not fight the text. */}
              <div className="border-border focus-within:border-border-strong bg-sidebar/70 mt-3 overflow-hidden rounded-xl border backdrop-blur-[4px] transition-colors duration-150">
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
            </div>
          </div>

          <SidebarContent>
            {resources.open && activeWorkspaceId ? (
              <ResourcesPanel workspaceId={activeWorkspaceId} permissions={activeWorkspace?.permissions ?? []} />
            ) : (
              <SectionPanel
                section={active}
                loading={loading}
                projects={projects}
                connections={connections}
                workspaces={workspaces}
                workspaceId={activeWorkspaceId}
                sessionWorkspace={sessionWorkspace}
                activeProjectHash={activeProjectHash}
              />
            )}
          </SidebarContent>
        </Sidebar>
      </div>
    </Sidebar>
  )
}

/**
 * The rail's folder icon: a toggle, not a link. Resources opens in the
 * sidebar beside the page you are on -- the chat stays where it is -- so
 * the URL does not change and the icon is lit by the panel's own state.
 */
function ResourcesRailItem({ active, onToggle }: { active: boolean; onToggle: () => void }) {
  return (
    <SidebarMenuItem className="flex justify-center">
      {active && <RailIndicator />}
      <SidebarMenuButton
        isActive={active}
        aria-pressed={active}
        aria-label="Files"
        onClick={onToggle}
        className={RAIL_BUTTON}
        tooltip={{ children: "Files", hidden: false, side: "right" }}
      >
        <FolderIcon />
        <span className="sr-only">Files</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  )
}
