"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import {
  ChevronRightIcon,
  FolderGitIcon,
  FolderTreeIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react"

import { ConnectionsPanel } from "@/components/database/connections-panel"
import { DeleteProjectDialog } from "@/components/delete-project-dialog"
import { useFilesPanel } from "@/components/files-panel"
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
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
  useSidebar,
} from "@/components/ui/sidebar"
import {
  PROJECT_PAGES,
  SETTINGS,
  SETTINGS_PAGES,
  projectPageFromPath,
  projectPageHref,
  settingsPageFromPath,
  settingsPageHref,
  type Section,
} from "@/lib/sections"
import type { Project } from "@/lib/session"
import type { DatabaseConnectionSummary } from "@ucch/protocol"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"

/**
 * The contents of the sidebar's second column, for the section the current
 * page belongs to.
 *
 * Code and Dashboard both list the workspace's projects: the panel is how you
 * get to one, and that is as true from an overview as it is from the project
 * section -- a sidebar column that holds a sentence you have already read is
 * a column doing nothing. Settings lists its pages, each a route of its own,
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
const LISTS_PROJECTS: ReadonlySet<string> = new Set(["code", "dashboard"])

export function SectionPanel({
  section,
  projects,
  connections = [],
  workspaceId = "",
  activeProjectHash,
  compact = false,
  onNavigate,
}: {
  section: Section
  projects: Project[]
  /** The workspace's saved database servers, for the Database section. */
  connections?: DatabaseConnectionSummary[]
  workspaceId?: string
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
  const { isMobile } = useSidebar()
  const { project: openProject, openFiles, closeFiles } = useFilesPanel()
  const router = useTransitionRouter()
  const pathname = usePathname()
  const activePage = projectPageFromPath(pathname)
  const activeSettingsPage = settingsPageFromPath(pathname)

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

  // The project whose deletion is being confirmed. One dialog for the whole
  // list rather than one per row: only ever one is open, and a dialog per
  // project would mount a form for every row in the sidebar.
  const [deleting, setDeleting] = React.useState<Project | null>(null)

  function afterDelete(deleted: Project) {
    // The tree is pinned to one project at a time, and it cannot be the one
    // that no longer exists.
    if (openProject?.id === deleted.id) closeFiles()

    // Leaving the page of a deleted project would render its 404. Everywhere
    // else, only the sidebar's list is stale.
    if (deleted.hash === activeProjectHash) router.push("/code")
    router.refresh()
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
                      render={<TransitionLink href={`/${project.hash}`} />}
                    >
                      <FolderGitIcon />
                      <span className="truncate">{project.name}</span>
                    </SidebarMenuButton>
                    {!compact && (
                      <>
                        {/* Two actions at the row's right edge: the chevron in
                            the usual slot, always shown so the row reads as
                            openable, and the menu one slot in from it, on
                            hover as before. */}
                        <CollapsibleTrigger
                          render={
                            <SidebarMenuAction className="aria-expanded:rotate-90" />
                          }
                        >
                          <ChevronRightIcon />
                          <span className="sr-only">Toggle {project.name}&apos;s pages</span>
                        </CollapsibleTrigger>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <SidebarMenuAction
                                showOnHover
                                className="right-6 aria-expanded:bg-muted"
                              />
                            }
                          >
                            <MoreHorizontalIcon />
                            <span className="sr-only">
                              More options for {project.name}
                            </span>
                          </DropdownMenuTrigger>
                          <DropdownMenuContent
                            className="w-48"
                            side={isMobile ? "bottom" : "right"}
                            align={isMobile ? "end" : "start"}
                          >
                            <DropdownMenuItem onClick={() => openFiles(project)}>
                              <FolderTreeIcon className="text-muted-foreground" />
                              <span>Open Files</span>
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              render={
                                <TransitionLink href={projectPageHref(project.hash, "manage")} />
                              }
                            >
                              <Settings2Icon className="text-muted-foreground" />
                              <span>Manage</span>
                            </DropdownMenuItem>
                            <DropdownMenuSeparator />
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() => setDeleting(project)}
                            >
                              <Trash2Icon />
                              <span>Delete</span>
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                        <CollapsibleContent>
                          <SidebarMenuSub>
                            {PROJECT_PAGES.map((page) => (
                              <SidebarMenuSubItem key={page.id}>
                                <SidebarMenuSubButton
                                  isActive={isActive && activePage === page.id}
                                  render={
                                    <TransitionLink href={projectPageHref(project.hash, page.id)} />
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

        {!compact && (
          <DeleteProjectDialog
            project={deleting}
            open={deleting !== null}
            onOpenChange={(open) => !open && setDeleting(null)}
            onDeleted={afterDelete}
          />
        )}
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
