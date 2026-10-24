"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { useQueryClient } from "@tanstack/react-query"
import {
  ChevronRightIcon,
  LayersIcon,
  PlusIcon,
} from "lucide-react"

import { ConnectionsPanel } from "@/components/database/connections-panel"
import { SessionList } from "@/components/session-list"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuAction,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubButton,
  SidebarMenuSubItem,
} from "@/components/ui/sidebar"
import {
  HOME,
  SIDEBAR_PROJECT_PAGES,
  SETTINGS,
  SETTINGS_PAGES,
  WORKSPACE_SETTINGS,
  WORKSPACE_SETTINGS_PAGES,
  workspaceSettingsPageFromPath,
  workspaceSettingsPageHref,
  projectPageFromPath,
  projectPageHref,
  settingsPageFromPath,
  settingsPageHref,
  type Section,
} from "@/lib/sections"
import { prefetchProject } from "@/lib/preload"
import { useAgentActivity } from "@/lib/realtime"
import type { Project, Workspace } from "@/lib/session"
import { countLabel } from "@/lib/workspace-api"
import type { DatabaseConnectionSummary } from "@ucch/protocol"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"
import { useProjectHref, useWorkspaceHash } from "@/lib/workspace-context"
import { NewSessionDialog } from "@/components/on-demand"
import { ProjectSessionRows } from "@/components/project-sessions-nav"
import { ProjectStackIcon } from "@/components/project-stack-icon"

/**
 * The contents of the sidebar's second column, for the section the current
 * page belongs to.
 *
 * Dashboard (the Home icon) lists the workspace's projects: the panel is how
 * you get to one, and a sidebar column that holds a sentence you have already
 * read is a column doing nothing. Settings lists its pages, each a route of its own,
 * with the lit row read off the URL. The remaining sections show their own one-line
 * description rather than fake rows, so the shell never implies a feature
 * that does not exist yet.
 */
/**
 * The sections whose panel is the project list rather than a description.
 *
 * A set rather than a field on `Section` because it is a fact about this
 * panel, not about the sections themselves -- `sections.ts` is also read by
 * the rail and the pages, neither of which cares.
 */
const LISTS_PROJECTS: ReadonlySet<string> = new Set(["dashboard"])

export function SectionPanel({
  section,
  projects,
  connections = [],
  workspaces = [],
  workspaceId = "",
  sessionWorkspace = false,
  activeProjectHash,
  compact = false,
  onNavigate,
}: {
  section: Section
  projects: Project[]
  /** The workspace's saved database servers, for the Database section. */
  connections?: DatabaseConnectionSummary[]
  /** Every workspace the caller belongs to, for the root page's list. */
  workspaces?: Workspace[]
  workspaceId?: string
  /** The workspace holds sessions: flat cards, no pages to unfold. */
  sessionWorkspace?: boolean
  activeProjectHash?: string
  /**
   * Drops the per-row action menu and the delete dialog.
   *
   * For the collapsed rail's hover flyout, which is dismissed the moment the
   * pointer leaves it: a menu opened inside one would be torn down on the way
   * to it, and a confirmation dialog even more so. The flyout is for going
   * somewhere; managing a project is what the panel is for.
   */
  compact?: boolean
  /** Called when a row is followed, so a flyout can close itself. */
  onNavigate?: () => void
}) {
  const router = useTransitionRouter()
  const queryClient = useQueryClient()
  // A stack detected afresh is a new icon for the row, and the list the
  // server rendered still has the old one.
  const agentStatusOf = useAgentActivity(LISTS_PROJECTS.has(section.id) ? projects : [], () =>
    router.refresh(),
  )
  const pathname = usePathname()
  const ws = useWorkspaceHash()
  const hrefOf = useProjectHref()
  const activePage = projectPageFromPath(pathname)
  const activeSettingsPage = settingsPageFromPath(pathname)
  const activeWorkspaceSettingsPage = workspaceSettingsPageFromPath(pathname)

  /**
   * The one project whose pages are unfolded beneath it, if any.
   *
   * One at a time, like an accordion: clicking a project opens it and
   * unfolds it, folding whichever was open before, so the list never grows
   * three rows per project you have visited. The chevron folds and unfolds
   * without leaving the page. The project you are on is unfolded to begin
   * with, and stays so until you fold it or open another.
   */
  const [unfolded, setUnfolded] = React.useState<string | null>(activeProjectHash ?? null)
  React.useEffect(() => {
    if (activeProjectHash) setUnfolded(activeProjectHash)
  }, [activeProjectHash])

  function setFolded(hash: string, open: boolean) {
    setUnfolded((current) => (open ? hash : current === hash ? null : current))
  }

  // The project a session is being started in. One dialog for the whole
  // list rather than one per row: only ever one is open.
  const [newSessionFor, setNewSessionFor] = React.useState<Project | null>(null)

  if (LISTS_PROJECTS.has(section.id) && sessionWorkspace && !compact) {
    return (
      <SessionList
        sessions={projects}
        activeProjectHash={activeProjectHash}
      />
    )
  }

  if (LISTS_PROJECTS.has(section.id)) {
    return (
      <SidebarGroup className="px-0">
        {!compact && <SidebarGroupLabel className="px-4">Projects</SidebarGroupLabel>}
        <SidebarGroupContent>
          {projects.length === 0 ? (
            <p className="text-muted-foreground px-4 py-2 text-sm">
              No projects in this workspace yet. Clone a repository to start.
            </p>
          ) : (
            // The row rhythm is the menu's gap rather than padding on each
            // item, so the row box and its button stay the same height --
            // which is what keeps the absolutely positioned action centred.
            <SidebarMenu className="gap-[5px] px-2">
              {projects.map((project) => {
                const isActive = project.hash === activeProjectHash
                // The flyout is a list of places to go, not a tree: its rows
                // stay flat.
                const open = !compact && unfolded === project.hash
                const agent = agentStatusOf(project)
                return (
                  <Collapsible
                    key={project.id}
                    open={open}
                    onOpenChange={(next) => setFolded(project.hash, next)}
                    render={<SidebarMenuItem />}
                  >
                    <SidebarMenuButton
                      isActive={isActive && activePage === null}
                      onClick={() => {
                        setFolded(project.hash, true)
                        onNavigate?.()
                      }}
                      // Only the first few projects' lists are loaded at
                      // boot; the rest are fetched on the way to a click.
                      // A session workspace's rows have no lists.
                      onPointerEnter={sessionWorkspace ? undefined : () => prefetchProject(queryClient, project.hash)}
                      render={<TransitionLink href={hrefOf(project.hash)} />}
                    >
                      <ProjectStackIcon stack={project.stack} />
                      <span className="truncate">{project.name}</span>
                      {/* Every session in the project at once: blue while
                          one works, red when the last to end failed or hit a
                          limit, green for a moment after one finishes. */}
                      {agent !== "idle" && (
                        <>
                          <span className="ucch-status-dot" data-status={agent} aria-hidden />
                          <span className="sr-only">
                            {agent === "working"
                              ? "(agent working)"
                              : agent === "error"
                                ? "(agent error)"
                                : "(agent done)"}
                          </span>
                        </>
                      )}
                    </SidebarMenuButton>
                    {!compact && (
                      <>
                        {/* Two actions at the row's right edge: the chevron in
                            the usual slot, always shown so the row reads as
                            openable, and New session one slot in from it,
                            on hover. */}
                        <CollapsibleTrigger
                          render={
                            <SidebarMenuAction className="aria-expanded:rotate-90" />
                          }
                        >
                          <ChevronRightIcon />
                          <span className="sr-only">Toggle {project.name}&apos;s pages</span>
                        </CollapsibleTrigger>
                        <SidebarMenuAction
                          showOnHover
                          className="right-6"
                          onClick={() => setNewSessionFor(project)}
                        >
                          <PlusIcon />
                          <span className="sr-only">New session in {project.name}</span>
                        </SidebarMenuAction>
                        <CollapsibleContent>
                          {/* Its sessions -- each its own conversation on its
                              own branch -- then the project's own pages. */}
                          <SidebarMenuSub>
                            <ProjectSessionRows project={project} onNavigate={onNavigate} />
                          </SidebarMenuSub>
                          <SidebarMenuSub>
                            {SIDEBAR_PROJECT_PAGES.map((page) => (
                              <SidebarMenuSubItem key={page.id}>
                                <SidebarMenuSubButton
                                  isActive={isActive && activePage === page.id}
                                  render={
                                    <TransitionLink href={projectPageHref(ws, project.hash, page.id)} />
                                  }
                                >
                                  <page.icon />
                                  <span>{page.title}</span>
                                </SidebarMenuSubButton>
                              </SidebarMenuSubItem>
                            ))}
                          </SidebarMenuSub>
                        </CollapsibleContent>
                      </>
                    )}
                  </Collapsible>
                )
              })}
            </SidebarMenu>
          )}
        </SidebarGroupContent>

        {!compact && newSessionFor && (
          <NewSessionDialog
            project={newSessionFor}
            open
            onOpenChange={(open) => !open && setNewSessionFor(null)}
          />
        )}
      </SidebarGroup>
    )
  }

  if (section.id === HOME.id) {
    const live = workspaces.filter((w) => !w.archived)
    return (
      <SidebarGroup className="px-0">
        {!compact && <SidebarGroupLabel className="px-4">{section.title}</SidebarGroupLabel>}
        <SidebarGroupContent>
          {live.length === 0 ? (
            <p className="text-muted-foreground px-4 py-2 text-sm">{section.blurb}</p>
          ) : (
            <SidebarMenu className="gap-[5px] px-2">
              {live.map((workspace) => (
                <SidebarMenuItem key={workspace.id}>
                  <SidebarMenuButton
                    size="lg"
                    isActive={workspace.id === workspaceId}
                    onClick={() => {
                      // The shell follows the address to the workspace.
                      router.push(`/${workspace.hash}`)
                      onNavigate?.()
                    }}
                  >
                    {workspace.logo ? (
                      // eslint-disable-next-line @next/next/no-img-element -- a data: URL
                      <img src={workspace.logo} alt="" className="size-6 shrink-0 rounded object-cover" />
                    ) : (
                      <LayersIcon />
                    )}
                    <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                      <span className="truncate font-medium">{workspace.name}</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {countLabel(workspace)}
                      </span>
                    </div>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          )}
        </SidebarGroupContent>
      </SidebarGroup>
    )
  }

  if (section.id === "database") {
    return (
      <ConnectionsPanel
        connections={connections}
        workspaceId={workspaceId}
        compact={compact}
        onNavigate={onNavigate}
      />
    )
  }

  if (section.id === WORKSPACE_SETTINGS.id) {
    return (
      <SidebarGroup className="px-0">
        {!compact && <SidebarGroupLabel className="px-4">{section.title}</SidebarGroupLabel>}
        <SidebarGroupContent>
          <SidebarMenu className="gap-[5px] px-2">
            {WORKSPACE_SETTINGS_PAGES.map((page) => (
              <SidebarMenuItem key={page.id}>
                <SidebarMenuButton
                  isActive={activeWorkspaceSettingsPage === page.id}
                  onClick={onNavigate}
                  render={<TransitionLink href={workspaceSettingsPageHref(ws, page.id)} />}
                >
                  <page.icon />
                  <span className="truncate">{page.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    )
  }

  if (section.id === SETTINGS.id) {
    return (
      <SidebarGroup className="px-0">
        {!compact && <SidebarGroupLabel className="px-4">{section.title}</SidebarGroupLabel>}
        <SidebarGroupContent>
          <SidebarMenu className="gap-[5px] px-2">
            {SETTINGS_PAGES.map((page) => (
              <SidebarMenuItem key={page.id}>
                <SidebarMenuButton
                  isActive={activeSettingsPage === page.id}
                  onClick={onNavigate}
                  render={<TransitionLink href={settingsPageHref(page.id)} />}
                >
                  <page.icon />
                  <span className="truncate">{page.title}</span>
                </SidebarMenuButton>
              </SidebarMenuItem>
            ))}
          </SidebarMenu>
        </SidebarGroupContent>
      </SidebarGroup>
    )
  }

  return (
    <SidebarGroup className="px-0">
      {/* The flyout puts the section's name in its own header, so repeating
          it here would label the same thing twice. */}
      {!compact && <SidebarGroupLabel className="px-4">{section.title}</SidebarGroupLabel>}
      <SidebarGroupContent>
        <p className="text-muted-foreground px-4 py-2 text-sm">
          {section.blurb}
        </p>
      </SidebarGroupContent>
    </SidebarGroup>
  )
}
