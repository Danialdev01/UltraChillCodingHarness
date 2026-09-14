"use client"

import * as React from "react"
import {
  FolderGitIcon,
  FolderTreeIcon,
  MoreHorizontalIcon,
  Settings2Icon,
  Trash2Icon,
} from "lucide-react"

import { DeleteProjectDialog } from "@/components/delete-project-dialog"
import { useFilesPanel } from "@/components/files-panel"
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
  useSidebar,
} from "@/components/ui/sidebar"
import type { Section } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"

/**
 * The contents of the sidebar's second column, for the section the current
 * page belongs to.
 *
 * Code and Dashboard both list the workspace's projects: the panel is how you
 * get to one, and that is as true from an overview as it is from the project
 * section -- a sidebar column that holds a sentence you have already read is
 * a column doing nothing. The remaining sections show their own one-line
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
  activeProjectHash,
  compact = false,
  onNavigate,
}: {
  section: Section
  projects: Project[]
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
              {projects.map((project) => (
                <SidebarMenuItem key={project.id}>
                  <SidebarMenuButton
                    isActive={project.hash === activeProjectHash}
                    onClick={onNavigate}
                    render={<TransitionLink href={`/${project.hash}`} />}
                  >
                    <FolderGitIcon />
                    <span className="truncate">{project.name}</span>
                  </SidebarMenuButton>
                  {!compact && (
                  <DropdownMenu>
                    <DropdownMenuTrigger
                      render={
                        <SidebarMenuAction
                          showOnHover
                          className="aria-expanded:bg-muted"
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
                      {/* Disabled rather than hidden, the same way the palette
                          shows the verbs the agent core will bring: there is
                          no project settings surface yet, and a menu item that
                          appears to work and does not is worse than one that
                          says it is not ready. */}
                      <DropdownMenuItem disabled>
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
                  )}
                </SidebarMenuItem>
              ))}
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
