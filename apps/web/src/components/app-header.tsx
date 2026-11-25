"use client"

import * as React from "react"
import { Fragment, Suspense, useCallback, useEffect, useState } from "react"
import { usePathname, useSearchParams } from "next/navigation"
import { useQuery } from "@tanstack/react-query"
import { ChevronDownIcon, GitBranchIcon, GlobeIcon, PanelLeftIcon, SettingsIcon, XIcon } from "lucide-react"

import { ConnectionSettingsDialog, PreviewDialog } from "@/components/on-demand"
import { FilesButton, ProjectSettingsButton, SearchButton } from "@/components/file-explorer-toggle"
import { HarnessIcon } from "@/components/harness-icon"
import { ProjectStackIcon } from "@/components/project-stack-icon"
import { RunCluster } from "@/components/topbar/run-cluster"
import { SessionMenu } from "@/components/topbar/session-menu"
import { Divider, Hint, ICON_BUTTON, IconButton, shortcut, useIsMac } from "@/components/topbar/primitives"
import { ViewModeToggle } from "@/components/view-mode-toggle"
import { useSidebar } from "@/components/ui/sidebar"
import { fetchGitStatus } from "@/lib/git-api"
import { targetOf } from "@/lib/project-target"
import { useProjectSessions } from "@/lib/project-sessions"
import { useWorkspaceSessions } from "@/lib/queries/workspace-sessions"
import { qk } from "@/lib/query-keys"
import {
  SETTINGS,
  WORKSPACE_SETTINGS,
  connectionHref,
  connectionIdFromPath,
  databaseHref,
  databasePathFromPath,
  projectHashFromPath,
  projectHref,
  projectPageById,
  projectPageFromPath,
  projectSessionHashFromPath,
  sectionForPath,
  settingsPageById,
  settingsPageFromPath,
  workspaceSettingsPageById,
  workspaceSettingsPageFromPath,
} from "@/lib/sections"
import type { Project, Workspace } from "@/lib/session"
import type { SidebarSession } from "@/lib/session-sidebar"
import type { DatabaseConnectionSummary } from "@ucch/protocol"
import { cn } from "@/lib/utils"
import { TransitionLink, useShellPathname, useTransitionRouter } from "@/lib/view-transitions"
import { useShell, useWorkspaceHash } from "@/lib/workspace-context"

type Crumb = { label: string; href?: string }

/** `/{ws}/code`: the dashboard's code view, which has no section of its own. */
function isCodePath(pathname: string): boolean {
  return /^\/[a-z0-9]{12}\/code\/?$/.test(pathname)
}

/** Where Settings' close button goes: the last page that was not a settings page. */
const RETURN_KEY = "ucch:settings-return"

function useRememberLeavingSettings(pathname: string) {
  const id = sectionForPath(pathname).id
  const inSettings = id === SETTINGS.id || id === WORKSPACE_SETTINGS.id
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
    <IconButton label="Close settings" keys="Esc" onClick={close}>
      <XIcon />
    </IconButton>
  )
}

/**
 * The one bar across the top of every page, 48px tall.
 *
 * Left, where you are: on a project session, the project and its branch
 * over the session's harness and title (which opens the session's menu).
 * Centre, on a project: the view switcher. Right: the run cluster (Dev,
 * Build and the commands picker, which used to be a second row under the
 * bar), the web preview, and the files, search and settings utilities.
 *
 * Where you are is read off the URL rather than told by the page. The shell
 * is a layout, rendered once and kept across navigations, so the page
 * inside it is not there to say what it is until its data has streamed in;
 * the URL is there from the first frame. A section's name comes from the
 * rail's own list, and a project's from the workspace's project list the
 * layout already holds -- so the bar is right while the page is still a
 * skeleton, and never flips from one name to another once it lands.
 */
export function AppHeader() {
  const { workspace, projects, connections } = useShell()
  const sessionWorkspace = workspace?.kind === "session"
  const pathname = useShellPathname()
  const projectHash = projectHashFromPath(pathname)
  const project = projectHash ? projects.find((p) => p.hash === projectHash) : undefined
  // Notes, Tasks, Keys: a page of the project rather than the project.
  const projectPage = projectPageFromPath(pathname)
  const sessionHash = projectSessionHashFromPath(pathname)
  const section = sectionForPath(pathname)
  const inSettings = section.id === SETTINGS.id || section.id === WORKSPACE_SETTINGS.id
  useRememberLeavingSettings(usePathname())

  // The connection any database page is on, for the settings button.
  const databasePath = databasePathFromPath(pathname)
  const connectionId = connectionIdFromPath(pathname)
  const currentConnection = connections.find((c) => c.id === (connectionId ?? databasePath?.connectionId))

  // The project's views: on the project itself, not its notes or keys.
  const projectView = Boolean(projectHash) && !projectPage

  return (
    // A container: what fits is decided by the bar's own width, which an
    // open sidebar narrows, not the window's.
    <header className="bg-background border-border @container flex h-12 shrink-0 items-center gap-2 border-b px-2">
      <SidebarToggle />
      <Divider className="hidden @xl:block" />

      {projectHash ? (
        <ProjectContext
          workspace={workspace}
          projects={projects}
          project={project}
          projectHash={projectHash}
          sessionHash={sessionHash}
          pageTitle={projectPage ? projectPageById(projectPage).title : null}
          sessionWorkspace={sessionWorkspace}
          projectView={projectView}
        />
      ) : (
        <>
          <SectionCrumbs pathname={pathname} connections={connections} inSettings={inSettings} />
          <div className="flex-1" />
          {inSettings && <CloseSettingsButton />}
          {currentConnection && <ConnectionSettingsButton connection={currentConnection} />}
        </>
      )}
    </header>
  )
}

function SidebarToggle() {
  const { toggleSidebar } = useSidebar()
  const mac = useIsMac()
  return (
    <IconButton label="Toggle sidebar" keys={shortcut(mac, "B")} onClick={toggleSidebar} aria-keyshortcuts={mac ? "Meta+B" : "Control+B"}>
      <PanelLeftIcon className="size-[17px]!" />
    </IconButton>
  )
}

/** The branch and change count of the tree on screen, from the Git view's own query. */
function useGitSummary(project: Project | undefined, sessionHash: string | null, enabled: boolean) {
  const hash = project?.hash ?? ""
  const { data } = useQuery({
    queryKey: qk.git.read("status", hash, sessionHash),
    queryFn: () => fetchGitStatus(targetOf({ hash, sessionHash })),
    enabled: enabled && Boolean(project),
    // Never stale by time: the server says when it is (`resource.changed{git}`).
    staleTime: Infinity,
    refetchOnWindowFocus: false,
    retry: false,
  })
  return { branch: data?.branch ?? null, changes: data?.files.length ?? 0 }
}

/** The card of the session on screen, from the sidebar's list of the workspace's sessions. */
function useOpenSession(
  workspace: Workspace | undefined,
  projectHash: string,
  sessionHash: string | null,
  sessionWorkspace: boolean,
): SidebarSession | null {
  const { data } = useWorkspaceSessions(workspace?.id ?? "", true)
  if (!sessionWorkspace && !sessionHash) return null
  return (
    data?.sessions.find((s) =>
      sessionWorkspace ? s.project.hash === projectHash : s.hash === sessionHash && s.project.hash === projectHash,
    ) ?? null
  )
}

/**
 * Everything the bar shows on a project: its context on the left, and on
 * the project itself the view switcher, the run cluster and the utilities.
 */
function ProjectContext({
  workspace,
  projects,
  project,
  projectHash,
  sessionHash,
  pageTitle,
  sessionWorkspace,
  projectView,
}: {
  workspace: Workspace | undefined
  projects: readonly Project[]
  project: Project | undefined
  projectHash: string
  sessionHash: string | null
  pageTitle: string | null
  sessionWorkspace: boolean
  projectView: boolean
}) {
  const ws = useWorkspaceHash()
  const card = useOpenSession(workspace, projectHash, sessionHash, sessionWorkspace)
  // The project's own list of sessions, for a title before the sidebar's list lands.
  const { sessions } = useProjectSessions(sessionHash && project ? project : null)
  const listed = sessionHash ? sessions?.find((s) => s.hash === sessionHash) : undefined
  // A session workspace's sessions have no git of their own to show.
  const git = useGitSummary(project, sessionHash, !sessionWorkspace)

  const inSession = sessionWorkspace || Boolean(sessionHash)
  const title = sessionWorkspace ? (card?.title ?? project?.name ?? "Session") : (card?.title ?? listed?.title ?? "Session")
  const provider = card?.provider ?? listed?.provider ?? null
  const branch = card?.branch ?? git.branch ?? (project?.defaultBranch || null)
  // A hash the list does not know is a project you have just created, or one
  // that will 404 in a moment: there is nothing better to call it.
  const name = project?.name ?? "Project"

  const projectLine = (
    <TransitionLink
      href={projectHref(ws, "project", projectHash)}
      className="text-muted-foreground hover:text-foreground focus-visible:ring-focus-ring/60 flex min-w-0 items-center gap-1.5 rounded-sm text-[11px] transition-colors duration-150 outline-none focus-visible:ring-2"
    >
      <span className="flex size-3 shrink-0 items-center justify-center [&_img]:size-3 [&_svg]:size-3">
        <ProjectStackIcon stack={project?.stack} />
      </span>
      <span className="truncate">{name}</span>
      {branch && <BranchLabel branch={branch} />}
    </TransitionLink>
  )

  let left: React.ReactNode
  if (inSession && workspace && project) {
    left = (
      <Stack top={sessionWorkspace ? null : projectLine}>
        <SessionMenu
          workspace={workspace}
          projects={projects}
          project={project}
          session={card}
          branch={sessionWorkspace ? null : branch}
          trigger={
            <button
              type="button"
              aria-label={`${title}: session menu`}
              className="group/title focus-visible:ring-focus-ring/60 text-foreground flex min-w-0 items-center gap-1.5 rounded-sm text-[13.5px] font-medium outline-none focus-visible:ring-2"
            >
              <HarnessIcon harness={provider} size={14} />
              <span className="truncate">{title}</span>
              <ChevronDownIcon className="text-text-subtle group-hover/title:text-foreground group-aria-expanded/title:text-foreground size-3 shrink-0 transition-colors duration-150" />
            </button>
          }
        />
      </Stack>
    )
  } else if (pageTitle) {
    left = (
      <Stack top={projectLine}>
        <span className="text-foreground truncate text-[13.5px] font-medium">{pageTitle}</span>
      </Stack>
    )
  } else {
    // The project itself: its name, with the branch beside it.
    left = (
      <div className="flex min-w-0 items-center gap-1.5 text-[13.5px] font-medium">
        <span className="flex size-3.5 shrink-0 items-center justify-center [&_img]:size-3.5 [&_svg]:size-3.5">
          <ProjectStackIcon stack={project?.stack} />
        </span>
        <span className="text-foreground truncate">{name}</span>
        {branch && <BranchLabel branch={branch} className="hidden text-[11px] @3xl:flex" />}
      </div>
    )
  }

  return (
    <>
      {/* Its natural width, up to a share of the bar: the title is what
          gives way when there is not room for everything. */}
      <div className="flex max-w-[38%] min-w-0 shrink items-center lg:max-w-[28%] xl:max-w-[26rem]">{left}</div>

      {/* Never narrower than its tabs: the title gives way instead. */}
      <div className="flex flex-1 items-center justify-center @xl:px-2">
        {projectView && <ViewModeToggle session={sessionWorkspace && project !== undefined} gitChanges={git.changes} />}
      </div>

      {projectView && project && (
        <div className="flex shrink-0 items-center gap-2">
          <RunCluster key={project.id} project={project} />
          {/* Suspense because the button reads the search params, which
              Next wants fenced off from any static parent. */}
          <Suspense>
            <PreviewButton project={project} />
          </Suspense>
          <Divider className="hidden md:@3xl:block" />
          <FilesButton />
          <SearchButton />
          {/* In a session its menu carries the project's settings on a narrow bar. */}
          {!sessionWorkspace && (
            <ProjectSettingsButton project={project} className={inSession ? "hidden @3xl:inline-flex" : undefined} />
          )}
        </div>
      )}
    </>
  )
}

/** Two lines, the small one on top -- hidden on a narrow bar, which is one line. */
function Stack({ top, children }: { top: React.ReactNode | null; children: React.ReactNode }) {
  return (
    <div className="flex min-w-0 flex-col justify-center gap-px leading-tight">
      {top && <div className="hidden min-w-0 @3xl:flex">{top}</div>}
      <div className="flex min-w-0">{children}</div>
    </div>
  )
}

function BranchLabel({ branch, className }: { branch: string; className?: string }) {
  return (
    <span className={cn("text-text-subtle flex min-w-0 shrink items-center gap-0.5 font-mono", className)}>
      <GitBranchIcon className="size-3 shrink-0" aria-hidden />
      <span className="sr-only">on branch </span>
      <span className="max-w-40 truncate">{branch}</span>
    </span>
  )
}

/** Off a project: the section, and the pages under it, as one line of crumbs. */
function SectionCrumbs({
  pathname,
  connections,
  inSettings,
}: {
  pathname: string
  connections: readonly DatabaseConnectionSummary[]
  inSettings: boolean
}) {
  const ws = useWorkspaceHash()
  const section = sectionForPath(pathname)
  const settingsPage = settingsPageFromPath(pathname)
  const workspaceSettingsPage = workspaceSettingsPageFromPath(pathname)
  const databasePath = databasePathFromPath(pathname)
  const connectionId = connectionIdFromPath(pathname)

  // Every crumb but the last is a link up a level; the last is where you are.
  const crumbs: Crumb[] = connectionId
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

  return (
    <nav aria-label="Breadcrumb" className="min-w-0">
      <ol className="flex min-w-0 items-center gap-1.5 text-[13.5px]">
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1
          return (
            <Fragment key={`${i}-${crumb.label}`}>
              {i > 0 && (
                <li aria-hidden className="text-text-subtle hidden sm:block">
                  /
                </li>
              )}
              {/* On a phone only where you are: the way up is the sidebar. */}
              <li className={cn("min-w-0", !last && "hidden sm:block")}>
                {crumb.href && !last ? (
                  <TransitionLink
                    href={crumb.href}
                    className="text-muted-foreground hover:text-foreground block truncate transition-colors duration-150"
                  >
                    {crumb.label}
                  </TransitionLink>
                ) : (
                  <span aria-current={last ? "page" : undefined} className={cn("block truncate", last ? "text-foreground font-medium" : "text-muted-foreground")}>
                    {crumb.label}
                  </span>
                )}
              </li>
            </Fragment>
          )
        })}
      </ol>
    </nav>
  )
}

/**
 * Opens the preview dialog. Lit while the dialog is open, and while a port
 * is set, so the bar says at a glance whether this project can be opened
 * from outside.
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

  const lit = open || Boolean(project.previewPort) || project.previewStaticDir != null
  return (
    <>
      <IconButton
        label={project.previewPort ? `Web preview on port ${project.previewPort}` : "Web preview"}
        active={lit}
        aria-pressed={lit}
        onClick={() => setOpen(true)}
      >
        <GlobeIcon />
      </IconButton>
      <PreviewDialog project={project} open={open} onOpenChange={setOpen} />
    </>
  )
}

/** Opens the connection's settings: the same dialog as the sidebar's ⋯ menu. */
function ConnectionSettingsButton({ connection }: { connection: DatabaseConnectionSummary }) {
  const [open, setOpen] = useState(false)
  return (
    <>
      <Hint label={`Settings for ${connection.name}`}>
        <button type="button" aria-label="Connection settings" className={ICON_BUTTON} onClick={() => setOpen(true)}>
          <SettingsIcon />
        </button>
      </Hint>
      <ConnectionSettingsDialog connection={connection} open={open} onOpenChange={setOpen} />
    </>
  )
}
