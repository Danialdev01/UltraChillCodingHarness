"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  CheckIcon,
  CopyIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SquarePenIcon,
} from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { NewProjectDialog, NewSessionDialog, RenameSessionDialog } from "@/components/on-demand"
import { SessionCard, type SessionAction } from "@/components/session-sidebar/session-card"
import { FilterPopover } from "@/components/session-sidebar/filter-popover"
import { ProjectGroupHeader } from "@/components/session-sidebar/project-group"
import { ListRowsSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import { Segmented } from "@/components/ui/segmented"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { renameProject } from "@/lib/create-project"
import { sessionModelLabel } from "@/lib/harnesses"
import { rememberLastModel, rememberLastProvider } from "@/lib/model-preference"
import { settleProjectSession, startProjectSession } from "@/lib/project-sessions"
import {
  useCollapsedProjects,
  useLiveTurns,
  useSidebarMode,
  useWorkspaceSessions,
} from "@/lib/queries/workspace-sessions"
import { qk } from "@/lib/query-keys"
import { useRealtime, useToast } from "@/lib/realtime"
import {
  projectHref,
  projectSessionHashFromPath,
} from "@/lib/sections"
import type { Project, Workspace } from "@/lib/session"
import {
  dateBucket,
  filterReducer,
  filtersActive,
  groupByProject,
  NO_FILTERS,
  passesFilters,
  relativeTime,
  sortSessions,
  statusOf,
  type SessionStatus,
  type SidebarMode,
  type SidebarSession,
} from "@/lib/session-sidebar"
import { useInvalidate } from "@/lib/use-invalidate"
import { useNewSession } from "@/lib/use-new-session"
import { useMinuteClock } from "@/lib/uptime"
import { cn } from "@/lib/utils"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"
import { useMe } from "@/lib/queries/bootstrap"

/** Past this many cards the list lets the browser skip laying out what is off screen. */
const VIRTUALIZE_AFTER = 100

const MODES = [
  { value: "sessions", label: "Sessions" },
  { value: "projects", label: "Projects" },
] as const

/**
 * The sidebar's list of coding sessions: every session in the workspace,
 * either newest first (Sessions) or under their projects (Projects).
 *
 * One list for both kinds of workspace. In a session workspace each session
 * is its own little project, so Projects shows one group per session -- the
 * mode is the person's choice, kept per account. The cards come from
 * `GET /api/workspaces/:id/sessions`, refreshed by the cache bridge as
 * sessions come, go, are renamed or end a turn; what a turn is doing right
 * now comes straight off the socket (`useLiveTurns`).
 */
export function SessionSidebar({
  workspace,
  projects,
  activeProjectHash,
  onNavigate,
}: {
  workspace: Workspace
  /** The shell's project list, for the new-session dialog. */
  projects: readonly Project[]
  activeProjectHash?: string
  onNavigate?: () => void
}) {
  const sessionWorkspace = workspace.kind === "session"
  const ws = useWorkspaceHash()
  const pathname = usePathname()
  const activeSession = projectSessionHashFromPath(pathname)
  const router = useTransitionRouter()
  const toast = useToast()
  const invalidate = useInvalidate()
  const { client } = useRealtime()
  const me = useMe()
  const now = useMinuteClock()

  const [mode, setMode] = useSidebarMode(sessionWorkspace ? "sessions" : "projects")
  const [filters, dispatchFilter] = React.useReducer(filterReducer, NO_FILTERS)
  const [collapsed, toggleCollapsed] = useCollapsedProjects(workspace.id)

  const { data, dataUpdatedAt, isPending } = useWorkspaceSessions(workspace.id, filters.showArchived)
  const live = useLiveTurns()

  const permissions = workspace.permissions
  const canWrite = permissions.includes("project.write")
  const canStart = permissions.includes("session.create") && (!sessionWorkspace || permissions.includes("project.create"))
  const canCreateProject = permissions.includes("project.create")
  const newQuickSession = useNewSession(workspace.id)

  const [newSessionFor, setNewSessionFor] = React.useState<Project | null>(null)
  const [creatingProject, setCreatingProject] = React.useState(false)
  const [renameTarget, setRenameTarget] = React.useState<SidebarSession | null>(null)
  const [settleTarget, setSettleTarget] = React.useState<SidebarSession | null>(null)

  const listRef = React.useRef<HTMLDivElement>(null)

  // -- What each card shows -----------------------------------------------------

  /** A session's status: what the socket said since the list was read, else the row. */
  const statusFor = React.useCallback(
    (session: SidebarSession): SessionStatus => {
      const heard = live.get(session.id)
      // Heard before this copy of the list was read: the row is newer.
      const fresh = heard && heard.at > dataUpdatedAt - 1_000 ? heard.state : undefined
      return statusOf(session, fresh)
    },
    [live, dataUpdatedAt],
  )

  const visible = React.useMemo(() => {
    const sessions = data?.sessions ?? []
    return sessions.filter(
      (s) =>
        passesFilters(s, filters, { userId: me?.userId ?? null, status: statusFor(s) }),
    )
  }, [data, filters, me?.userId, statusFor])

  const narrowed = filtersActive(filters)

  const hrefOf = React.useCallback(
    (s: SidebarSession) =>
      sessionWorkspace ? projectHref(ws, "session", s.project.hash) : projectHref(ws, "project", s.project.hash, s.hash),
    [sessionWorkspace, ws],
  )
  const isActive = (s: SidebarSession) =>
    sessionWorkspace ? s.project.hash === activeProjectHash : s.hash === activeSession && s.project.hash === activeProjectHash

  const projectOf = (projectId: string) => projects.find((p) => p.id === projectId) ?? null

  // -- Actions ------------------------------------------------------------------

  async function update(session: SidebarSession, patch: { title?: string; pinned?: boolean; archived?: boolean }) {
    if (!client) throw new Error("Not connected to the server yet.")
    await client.dispatch({ type: "thread.update", threadId: session.id, ...patch })
    invalidate(qk.sessions.all)
  }

  async function act(label: string, run: () => Promise<unknown>) {
    try {
      await run()
    } catch (e) {
      toast({ title: `Could not ${label}`, description: e instanceof Error ? e.message : undefined, tone: "error" })
    }
  }

  async function duplicate(session: SidebarSession) {
    const project = projectOf(session.project.id)
    if (!project) return
    // The copy opens on the same harness and model: the chat reads these
    // before its first message binds the thread (`model-preference.ts`).
    if (session.provider) rememberLastProvider(project.id, session.provider)
    if (session.model && session.provider) rememberLastModel(`${project.id}:${session.provider}`, session.model)
    if (sessionWorkspace) {
      newQuickSession.start()
      return
    }
    if (!client) throw new Error("Not connected to the server yet.")
    const created = await startProjectSession(client, project, { baseBranch: session.baseBranch ?? session.branch })
    router.push(projectHref(ws, "project", project.hash, created.hash))
  }

  async function settle(session: SidebarSession) {
    if (sessionWorkspace) {
      const response = await fetch(`/api/projects/${session.project.hash}`, { method: "DELETE", credentials: "include" })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? "Could not settle the session.")
      }
      toast({ title: `Settled ${session.title}` })
      invalidate(qk.bootstrap(), qk.sessions.all, qk.project(session.project.hash))
      if (isActive(session)) router.push(`/${ws}`)
      return
    }
    const { pushed } = await settleProjectSession(session.project.hash, session.hash ?? "")
    toast({ title: `Settled ${session.title}`, description: pushed ? `Its changes were pushed to ${pushed}.` : undefined })
    invalidate(qk.sessions.all)
    if (isActive(session)) router.push(projectHref(ws, "project", session.project.hash))
  }

  function actionsFor(session: SidebarSession, status: SessionStatus): (SessionAction | "separator")[] {
    const working = status === "running" || status === "waiting_input"
    const archived = Boolean(session.archivedAt)
    const out: (SessionAction | "separator")[] = []
    if (canWrite) {
      out.push(
        { label: "Rename", icon: PencilIcon, onSelect: () => setRenameTarget(session) },
        session.pinned
          ? { label: "Unpin", icon: PinOffIcon, onSelect: () => void act("unpin it", () => update(session, { pinned: false })) }
          : { label: "Pin", icon: PinIcon, onSelect: () => void act("pin it", () => update(session, { pinned: true })) },
      )
    }
    if (canStart) {
      out.push({ label: "Duplicate", icon: CopyIcon, onSelect: () => void act("duplicate it", () => duplicate(session)) })
    }
    if (canWrite) {
      out.push(
        archived
          ? { label: "Restore", icon: ArchiveRestoreIcon, onSelect: () => void act("restore it", () => update(session, { archived: false })) }
          : {
              label: "Archive",
              icon: ArchiveIcon,
              disabled: working,
              onSelect: () => void act("archive it", () => update(session, { archived: true })),
            },
        "separator",
        { label: "Settle…", icon: CheckIcon, destructive: true, disabled: working, onSelect: () => setSettleTarget(session) },
      )
    }
    return out
  }

  // -- New session ------------------------------------------------------------

  const startNew = React.useCallback(
    (project?: Project | null) => {
      if (!canStart) return
      if (sessionWorkspace) {
        newQuickSession.start()
        return
      }
      const target = project ?? projects.find((p) => p.hash === activeProjectHash) ?? projects[0] ?? null
      if (target) setNewSessionFor(target)
      else if (canCreateProject) setCreatingProject(true)
    },
    [canStart, sessionWorkspace, newQuickSession, projects, activeProjectHash, canCreateProject],
  )

  // ⇧⌘O starts a session (a session workspace's is handled by the quick
  // menu, which owned the shortcut first). ⌘K is the command palette's.
  React.useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === "o") {
        if (sessionWorkspace) return
        event.preventDefault()
        startNew()
      }
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [sessionWorkspace, startNew])

  // -- Keyboard: ↑/↓ between cards, Enter follows the focused one ---------------

  const [focusedId, setFocusedId] = React.useState<string | null>(null)
  function onListKeyDown(event: React.KeyboardEvent) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return
    const links = [...(listRef.current?.querySelectorAll<HTMLElement>("[data-session-link]") ?? [])]
    if (links.length === 0) return
    event.preventDefault()
    const at = links.indexOf(document.activeElement as HTMLElement)
    const next = at === -1 ? 0 : Math.min(links.length - 1, Math.max(0, at + (event.key === "ArrowDown" ? 1 : -1)))
    links[next]!.focus()
  }

  // -- Rendering ----------------------------------------------------------------

  const total = visible.length
  const lazy = total > VIRTUALIZE_AFTER
  const tabStop = focusedId ?? visible.find(isActive)?.id ?? visible[0]?.id

  function card(session: SidebarSession, hideProject: boolean) {
    const status = statusFor(session)
    return (
      <li
        key={session.id}
        // Off-screen cards are skipped by layout and paint once the list is long.
        className={cn(lazy && "[content-visibility:auto] [contain-intrinsic-size:auto_4rem]")}
      >
        <SessionCard
          session={session}
          status={status}
          href={hrefOf(session)}
          isActive={isActive(session)}
          hideProject={hideProject}
          time={relativeTime(session.lastActivityAt, now)}
          modelLabel={sessionModelLabel(session.provider, session.model)}
          hostName={data?.workspaceName ?? workspace.name}
          actions={actionsFor(session, status)}
          onNavigate={onNavigate}
          rovingTabIndex={session.id === tabStop ? 0 : -1}
          onFocusCard={() => setFocusedId(session.id)}
        />
      </li>
    )
  }

  let body: React.ReactNode
  if (isPending) {
    body = <ListRowsSkeleton rows={6} />
  } else if (mode === "sessions") {
    if (total === 0) {
      body = (
        <EmptyState
          narrowed={narrowed}
          canStart={canStart}
          onStart={() => startNew()}
          onClear={() => {
            dispatchFilter({ type: "clear" })
          }}
        />
      )
    } else {
      const sorted = sortSessions(visible)
      const today = now === null ? null : new Date(now)
      const sections: { label: string; sessions: SidebarSession[] }[] = []
      for (const s of sorted) {
        const label = today ? dateBucket(s, today) : ""
        const last = sections.at(-1)
        if (last && last.label === label) last.sessions.push(s)
        else sections.push({ label, sessions: [s] })
      }
      body = sections.map((section) => (
        <section key={section.label || "all"} aria-label={section.label || undefined}>
          {section.label && (
            <h3 className="text-muted-foreground px-2.5 pt-2 pb-1 text-2xs font-medium">{section.label}</h3>
          )}
          <ul className="flex flex-col gap-0.5">{section.sessions.map((s) => card(s, false))}</ul>
        </section>
      ))
    }
  } else {
    // Projects: every project, the empty ones too, unless a filter narrows
    // the list -- then only the groups with a match.
    const groups = groupByProject(visible, narrowed ? [] : (data?.projects ?? [])).filter(
      (g) => filters.projects.length === 0 || filters.projects.includes(g.project.id),
    )
    if (groups.length === 0) {
      body = (
        <EmptyState
          narrowed={narrowed}
          canStart={canStart}
          onStart={() => startNew()}
          onClear={() => {
            dispatchFilter({ type: "clear" })
          }}
        />
      )
    } else {
      body = groups.map((group) => {
        // A filter opens every group it found something in.
        const open = narrowed || !collapsed.has(group.project.id)
        const project = projectOf(group.project.id)
        return (
          <section key={group.project.id} aria-label={group.project.name} className="flex flex-col">
            <ProjectGroupHeader
              project={group.project}
              count={group.sessions.length}
              open={open}
              onToggle={() => toggleCollapsed(group.project.id)}
              onNewSession={canStart && project ? () => startNew(project) : undefined}
              href={sessionWorkspace ? projectHref(ws, "session", group.project.hash) : projectHref(ws, "project", group.project.hash)}
              isActive={group.project.hash === activeProjectHash}
              onNavigate={onNavigate}
            />
            {open &&
              (group.sessions.length === 0 ? (
                <p className="text-muted-foreground py-1 pr-2 pl-8 text-xs">No sessions yet</p>
              ) : (
                <ul className="flex flex-col gap-0.5 pl-3">{group.sessions.map((s) => card(s, true))}</ul>
              ))}
          </section>
        )
      })
    }
  }

  return (
    <div className="flex min-h-0 flex-col">
      <div className="flex items-center gap-1 px-2 pt-2 pb-1">
        <Segmented<SidebarMode>
          options={MODES}
          value={mode}
          onChange={setMode}
          size="sm"
          aria-label="List sessions by"
          className="min-w-0 flex-1 [&>button]:flex-1"
        />
        <FilterPopover
          filters={filters}
          dispatch={dispatchFilter}
          projects={data?.projects ?? []}
          sessionWorkspace={sessionWorkspace}
        />
      </div>

      <div
        ref={listRef}
        role="navigation"
        aria-label="Sessions"
        onKeyDown={onListKeyDown}
        className="flex flex-col gap-1 px-2 pb-2"
      >
        {body}
      </div>

      {newSessionFor && (
        <NewSessionDialog
          project={newSessionFor}
          projects={projects}
          open
          onOpenChange={(open) => !open && setNewSessionFor(null)}
        />
      )}
      {creatingProject && (
        <NewProjectDialog open workspaceId={workspace.id} onOpenChange={(open) => !open && setCreatingProject(false)} />
      )}
      <RenameSessionDialog
        session={renameTarget ? { hash: renameTarget.project.hash, name: renameTarget.title } : null}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        save={async (name) => {
          if (!renameTarget) return
          await update(renameTarget, { title: name })
          // A session workspace's card is the project: named the same.
          if (sessionWorkspace) await renameProject(renameTarget.project.hash, name)
        }}
        onRenamed={() => {
          setRenameTarget(null)
          invalidate(qk.sessions.all, qk.bootstrap())
        }}
      />
      <ConfirmDialog
        open={settleTarget !== null}
        onOpenChange={(open) => !open && setSettleTarget(null)}
        title={`Settle ${settleTarget?.title ?? "session"}?`}
        description={
          sessionWorkspace
            ? "Settling is done with a session: it and its files are deleted. Push anything you want to keep first."
            : "Its changes are pushed to origin first, then the session and its worktree are removed. It refuses if the push fails."
        }
        confirmLabel="Settle"
        onConfirm={async () => {
          if (settleTarget) await settle(settleTarget)
        }}
      />
    </div>
  )
}

function EmptyState({
  narrowed,
  canStart,
  onStart,
  onClear,
}: {
  narrowed: boolean
  canStart: boolean
  onStart: () => void
  onClear: () => void
}) {
  return (
    <div className="flex flex-col items-start gap-2 px-2 py-3">
      <p className="text-muted-foreground text-sm">
        {narrowed ? "No sessions match." : "No sessions yet. Start one to talk to an agent."}
      </p>
      {narrowed ? (
        <Button size="sm" variant="outline" onClick={onClear}>
          Clear filters
        </Button>
      ) : (
        canStart && (
          <Button size="sm" variant="outline" onClick={onStart}>
            <SquarePenIcon />
            New session
          </Button>
        )
      )}
    </div>
  )
}

export function IconAction({
  label,
  onClick,
  disabled,
  children,
  className,
}: {
  label: string
  onClick?: () => void
  disabled?: boolean
  children: React.ReactNode
  className?: string
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClick}
            disabled={disabled}
            aria-label={label}
            className={className}
          />
        }
      >
        {children}
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
