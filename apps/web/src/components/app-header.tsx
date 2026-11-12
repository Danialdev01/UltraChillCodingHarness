"use client"

import * as React from "react"
import { Fragment, Suspense, useCallback, useEffect, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { GlobeIcon, SettingsIcon, XIcon } from "lucide-react"

import { ConnectionSettingsDialog, PreviewDialog } from "@/components/on-demand"
import { HarnessIcon } from "@/components/harness-icon"
import { ProjectStackIcon } from "@/components/project-stack-icon"
import { ViewModeToggle } from "@/components/view-mode-toggle"
import { CommandButtons } from "@/components/commands/command-buttons"
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "@/components/ui/breadcrumb"
import { Button } from "@/components/ui/button"
import { Separator } from "@/components/ui/separator"
import { SidebarTrigger } from "@/components/ui/sidebar"
import {
  SETTINGS,
  WORKSPACE_SETTINGS,
  connectionHref,
  connectionIdFromPath,
  databaseHref,
  databasePathFromPath,
  projectHashFromPath,
  projectPageById,
  projectPageFromPath,
  projectSessionHashFromPath,
  sectionForPath,
  settingsPageById,
  settingsPageFromPath,
  workspaceSettingsPageById,
  workspaceSettingsPageFromPath,
} from "@/lib/sections"
import type { Project } from "@/lib/session"
import type { DatabaseConnectionSummary } from "@ucch/protocol"
import { cn } from "@/lib/utils"
import { useShellLists } from "@/lib/queries/bootstrap"
import { useProjectSessions } from "@/lib/project-sessions"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"
import { useActiveWorkspace, useProjectHref, useWorkspaceHash } from "@/lib/workspace-context"

type Crumb = { label: string; href?: string; icon?: React.ReactNode }

/** `/{ws}/code`: the dashboard's code view, which has no section of its own. */
function isCodePath(pathname: string): boolean {
  return /^\/[a-z0-9]{12}\/code\/?$/.test(pathname)
}

/** Where Settings' close button goes: the last page that was not a settings page. */
const RETURN_KEY = "ucch:settings-return"

function useRememberLeavingSettings(pathname: string, inSettings: boolean) {
  useEffect(() => {
    if (inSettings) return
    try {
      sessionStorage.setItem(RETURN_KEY, pathname + window.location.search)
    } catch {
      // Storage refused (a private window): the button falls back to the dashboard.
    }
  }, [pathname, inSettings])
}

/**
 * Leaves Settings for wherever you were before opening it -- Settings is a
 * place you visit, not one you live in. Esc does the same when nothing has
 * focus.
 */
function CloseSettingsButton() {
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const close = useCallback(() => {
    let back: string | null = null
    try {
      back = sessionStorage.getItem(RETURN_KEY)
    } catch {}
    router.push(back ?? (ws ? `/${ws}` : "/"))
  }, [router, ws])
  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.defaultPrevented) return
      const target = event.target as HTMLElement | null
      if (target && target !== document.body) return
      close()
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [close])
  return (
    <Button variant="ghost" size="icon-sm" className="ml-auto" onClick={close} title="Close settings (Esc)">
      <XIcon />
      <span className="sr-only">Close settings</span>
    </Button>
  )
}

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
  projects: serverProjects,
  connections: serverConnections,
  sessionWorkspace = false,
}: {
  projects: readonly Project[]
  connections: readonly DatabaseConnectionSummary[]
  /** The active workspace holds sessions, whose view has no Git tab. */
  sessionWorkspace?: boolean
}) {
  const active = useActiveWorkspace()
  const { projects, connections } = useShellLists({
    workspaces: active ? [active] : [],
    activeWorkspaceId: active?.id ?? "",
    projects: serverProjects as Project[],
    connections: serverConnections as DatabaseConnectionSummary[],
  })
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

  const ws = useWorkspaceHash()
  const hrefOf = useProjectHref()
  const sessionHash = projectSessionHashFromPath(pathname)
  const { sessions } = useProjectSessions(sessionHash && project ? project : null)
  const openSession = sessionHash ? sessions?.find((s) => s.hash === sessionHash) : undefined
  const sessionTitle = openSession?.title
  const section = sectionForPath(pathname)
  const inSettings = section.id === SETTINGS.id || section.id === WORKSPACE_SETTINGS.id
  useRememberLeavingSettings(pathname, inSettings)

  // Every crumb but the last is a link up a level; the last is where you are.
  const crumbs: Crumb[] = projectHash
    ? // A hash the list does not know is a project you have just created, or
      // one that will 404 in a moment; either way there is nothing better to
      // show than that it is a project.
      [
        {
          label: project?.name ?? "Project",
          href: hrefOf(projectHash),
          icon: <ProjectStackIcon stack={project?.stack} />,
        },
        ...(projectPage ? [{ label: projectPageById(projectPage).title }] : []),
        // The session, with the mark of the harness it runs on.
        ...(sessionHash
          ? [{ label: sessionTitle ?? "Session", icon: <HarnessIcon harness={openSession?.provider} size={14} /> }]
          : []),
      ]
    : connectionId
      ? [
          { label: "Connections", href: `/${ws}/database` },
          { label: connections.find((c) => c.id === connectionId)?.name ?? "Connection" },
        ]
      : databasePath
        ? [
            { label: "Connections", href: `/${ws}/database` },
            {
              label: connections.find((c) => c.id === databasePath.connectionId)?.name ?? "Connection",
              href: connectionHref(ws, databasePath.connectionId),
            },
            {
              label: databasePath.db,
              href: databasePath.table ? databaseHref(ws, databasePath.connectionId, databasePath.db) : undefined,
            },
            ...(databasePath.table ? [{ label: databasePath.table }] : []),
          ]
        : inSettings
          ? [
              { label: "Settings" },
              ...(settingsPage ? [{ label: settingsPageById(settingsPage).title }] : []),
              ...(workspaceSettingsPage ? [{ label: workspaceSettingsPageById(workspaceSettingsPage).title }] : []),
            ]
          : isCodePath(pathname)
            ? [{ label: section.title, href: `/${ws}` }, { label: "Code" }]
            : [{ label: section.title }]
  // The project crumb is only a link when there is somewhere above the page
  // you are on to go back to.
  const shown = crumbs.map((crumb, i) =>
    i === crumbs.length - 1 ? { label: crumb.label, icon: crumb.icon } : crumb,
  )

  return (
    <header className="bg-background flex min-h-16 shrink-0 flex-wrap items-center gap-x-2 gap-y-0 border-b px-3 sm:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-2 data-vertical:h-4 data-vertical:self-auto" />
      {/* `min-w-0` so a long project name truncates instead of pushing the
          view toggles off a phone screen -- without it the chat's own
          controls become unreachable on the device that needs them most. */}
      <Breadcrumb className="min-w-0 flex-1">
        <BreadcrumbList className="flex-nowrap">
          {shown.map((crumb, i) => (
            // The separator is its own <li>, so it has to be a sibling of the
            // item rather than a child of it -- an <li> inside an <li> is
            // invalid HTML and the browser's fix-up trips hydration.
            <Fragment key={`${i}-${crumb.label}`}>
              {i > 0 && <BreadcrumbSeparator className="hidden sm:inline-flex" />}
              <BreadcrumbItem className={cn("min-w-0", i < shown.length - 1 && "hidden sm:inline-flex")}>
                {crumb.href ? (
                  <BreadcrumbLink
                    className="flex min-w-0 items-center gap-1.5"
                    render={<TransitionLink href={crumb.href} />}
                  >
                    {crumb.icon && <CrumbIcon>{crumb.icon}</CrumbIcon>}
                    <span className="truncate">{crumb.label}</span>
                  </BreadcrumbLink>
                ) : (
                  <BreadcrumbPage
                    className={cn("flex min-w-0 items-center gap-1.5", i === shown.length - 1 && "font-medium")}
                  >
                    {crumb.icon && <CrumbIcon>{crumb.icon}</CrumbIcon>}
                    <span className="truncate">{crumb.label}</span>
                  </BreadcrumbPage>
                )}
              </BreadcrumbItem>
            </Fragment>
          ))}
        </BreadcrumbList>
      </Breadcrumb>
      {inSettings && <CloseSettingsButton />}
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
      {project && !projectPage && (
        <div className="flex w-full min-w-0 flex-wrap items-center gap-1 border-t py-1.5" aria-label="Project commands">
          <CommandButtons key={project.id} project={project} />
        </div>
      )}
    </header>
  )
}

/** A crumb's mark -- a project's stack icon -- sized to the text beside it. */
function CrumbIcon({ children }: { children: React.ReactNode }) {
  return (
    <span className="flex size-4 shrink-0 items-center justify-center [&_img]:size-4 [&_svg]:size-3.5">
      {children}
    </span>
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
      <Button
        variant="ghost"
        size="icon-sm"
        aria-pressed={Boolean(project.previewPort)}
        title={project.previewPort ? `Preview on port ${project.previewPort}` : "Preview"}
        onClick={() => setOpen(true)}
        className="text-muted-foreground aria-pressed:text-ucch-active"
      >
        <GlobeIcon />
        <span className="sr-only">Preview</span>
      </Button>
      <PreviewDialog project={project} open={open} onOpenChange={setOpen} />
    </>
  )
}

/** Opens the connection's settings: the same dialog as the sidebar's ⋯ menu. */
function ConnectionSettingsButton({ connection }: { connection: DatabaseConnectionSummary }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="ml-auto flex shrink-0 items-center">
      <Button
        variant="ghost"
        size="icon-sm"
        title={`Settings for ${connection.name}`}
        onClick={() => setOpen(true)}
        className="text-muted-foreground"
      >
        <SettingsIcon />
        <span className="sr-only">Connection settings</span>
      </Button>
      <ConnectionSettingsDialog connection={connection} open={open} onOpenChange={setOpen} />
    </div>
  )
}
