"use client"

import { Fragment, Suspense, useEffect, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { GlobeIcon, SettingsIcon } from "lucide-react"

import { ConnectionSettingsDialog } from "@/components/database/connection-settings-dialog"
import { PreviewDialog } from "@/components/preview-dialog"
import { ViewModeToggle } from "@/components/view-mode-toggle"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  connectionIdFromPath,
  databasePathFromPath,
  projectHashFromPath,
  projectPageById,
  projectPageFromPath,
  sectionForPath,
  settingsPageById,
  settingsPageFromPath,
  workspaceSettingsPageById,
  workspaceSettingsPageFromPath,
} from "@/lib/sections"
import type { Project } from "@/lib/session"
import type { DatabaseConnectionSummary } from "@ucch/protocol"
import { cn } from "@/lib/utils"

/**
 * The bar across the top of every page: the sidebar toggle, where you are,
 * and -- on a project -- the view switcher.
 *
 * Where you are is read off the URL rather than told by the page. The shell
 * is a layout now, rendered once and kept across navigations, so the page
 * inside it is not there to say what it is until its data has streamed in;
 * the URL is there from the first frame. A section's name comes from the
 * rail's own list, and a project's from the workspace's project list the
 * layout already holds -- so the crumb is right while the page is still a
 * skeleton, and never flips from one name to another once it lands. The
 * workspace is not a crumb: the switcher at the top of the sidebar already
 * names it, a hand's width to the left.
 */
export function AppHeader({
  projects,
  connections,
  sessionWorkspace = false,
}: {
  projects: readonly Project[]
  connections: readonly DatabaseConnectionSummary[]
  /** The active workspace holds sessions, whose view has no Git tab. */
  sessionWorkspace?: boolean
}) {
  const pathname = usePathname()
  const projectHash = projectHashFromPath(pathname)
  const project = projectHash ? projects.find((p) => p.hash === projectHash) : undefined
  // Notes, Timeline, Keys: a page of the project rather than the project.
  const projectPage = projectPageFromPath(pathname)
  // Account, Usage, Theme: a page of Settings rather than Settings.
  const settingsPage = settingsPageFromPath(pathname)
  const workspaceSettingsPage = workspaceSettingsPageFromPath(pathname)
  // A connection, its database, and perhaps a table: the database pages.
  const databasePath = databasePathFromPath(pathname)
  // The connection itself: its page lists the databases on the server.
  const connectionId = connectionIdFromPath(pathname)

  // The connection any database page is on, for the settings button.
  const currentConnection = connections.find((c) => c.id === (connectionId ?? databasePath?.connectionId))

  const crumbs = projectHash
    ? // A hash the list does not know is a project you have just created, or
      // one that will 404 in a moment; either way there is nothing better to
      // show than that it is a project.
      [project?.name ?? "Project", ...(projectPage ? [projectPageById(projectPage).title] : [])]
    : connectionId
      ? ["Connections", connections.find((c) => c.id === connectionId)?.name ?? "Connection"]
      : databasePath
      ? [
          "Connections",
          connections.find((c) => c.id === databasePath.connectionId)?.name ?? "Connection",
          databasePath.db,
          ...(databasePath.table ? [databasePath.table] : []),
        ]
      : [
          sectionForPath(pathname).title,
          ...(settingsPage ? [settingsPageById(settingsPage).title] : []),
          ...(workspaceSettingsPage ? [workspaceSettingsPageById(workspaceSettingsPage).title] : []),
        ]

  return (
    <header className="bg-background flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:h-16 sm:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
      {/* `min-w-0` so a long project name truncates instead of pushing the
          view toggles off a phone screen -- without it the chat's own
          controls become unreachable on the device that needs them most. */}
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          {crumbs.map((crumb, i) => (
            // The separator is its own <li>, so it has to be a sibling of the
            // item rather than a child of it -- an <li> inside an <li> is
            // invalid HTML and the browser's fix-up trips hydration.
            <Fragment key={`${i}-${crumb}`}>
              {i > 0 && <BreadcrumbSeparator />}
              <BreadcrumbItem className="min-w-0">
                <BreadcrumbPage className="truncate">{crumb}</BreadcrumbPage>
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {/* On a connection, or any database of it: how the server is reached. */}
      {currentConnection && <ConnectionSettingsButton connection={currentConnection} />}
      {/* Only a project has views to switch between, or files to put beside
          them -- and only the project itself, not its notes or keys. */}
      {projectHash && !projectPage && (
        <div className="ml-auto flex shrink-0 items-center gap-1">
          {/* Suspense because the button reads the search params, which
              Next wants fenced off from any static parent. */}
          {project && (
            <Suspense>
              <PreviewButton project={project} />
            </Suspense>
          )}
          {/* The tree toggle lives inside this, at its right end. */}
          <ViewModeToggle session={sessionWorkspace && project !== undefined} />
        </div>
      )}
    </header>
  )
}

/**
 * Opens the preview dialog. Lit when a port is set, so the bar says at a
 * glance whether this project can be opened from outside.
 *
 * Also opens itself when the URL asks (`?preview=setup`): that is where the
 * share link sends someone who followed it before a port was chosen.
 */
function PreviewButton({ project }: { project: Project }) {
  const [open, setOpen] = useState(false)
  const wantsSetup = useSearchParams().get("preview") === "setup"
  useEffect(() => {
    if (wantsSetup) setOpen(true)
  }, [wantsSetup])

  return (
    <>
      <button
        type="button"
        aria-pressed={Boolean(project.previewPort)}
        title={project.previewPort ? `Preview on port ${project.previewPort}` : "Preview"}
        onClick={() => setOpen(true)}
        className={cn(
          "flex size-7 items-center justify-center rounded-md transition-colors",
          "text-muted-foreground hover:text-foreground",
          "aria-pressed:text-ucch-active",
        )}
      >
        <GlobeIcon className="size-3.5" />
        <span className="sr-only">Preview</span>
      </button>
      <PreviewDialog project={project} open={open} onOpenChange={setOpen} />
    </>
  )
}

/** Opens the connection's settings: the same dialog as the sidebar's ⋯ menu. */
function ConnectionSettingsButton({ connection }: { connection: DatabaseConnectionSummary }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="ml-auto flex shrink-0 items-center">
      <button
        type="button"
        title={`Settings for ${connection.name}`}
        onClick={() => setOpen(true)}
        className="text-muted-foreground hover:text-foreground flex size-7 items-center justify-center rounded-md transition-colors"
      >
        <SettingsIcon className="size-3.5" />
        <span className="sr-only">Connection settings</span>
      </button>
      <ConnectionSettingsDialog connection={connection} open={open} onOpenChange={setOpen} />
    </div>
  )
}
