"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ArrowLeftIcon,
  CheckIcon,
  CircleCheckIcon,
  CopyIcon,
  PencilIcon,
  PinIcon,
  PinOffIcon,
  SquarePenIcon,
  Trash2Icon,
} from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { DeleteProjectDialog, NewProjectDialog, NewSessionDialog, RenameSessionDialog } from "@/components/on-demand"
import { SessionCard, type SessionAction } from "@/components/session-sidebar/session-card"
import { SettleSessionDialog } from "@/components/session-sidebar/settle-session-dialog"
import { FilterPopover } from "@/components/session-sidebar/filter-popover"
import { ProjectGroupHeader } from "@/components/session-sidebar/project-group"
import { ListRowsSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { renameProject } from "@/lib/create-project"
import { sessionModelLabel } from "@/lib/harnesses"
import { rememberLastModel, rememberLastProvider } from "@/lib/model-preference"
import {
  deleteSettledSession,
  fetchSessionSettleCheck,
  settleProjectSession,
  settleWorkspaceSession,
  startProjectSession,
} from "@/lib/project-sessions"
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
  projectPageHref,
  projectSessionHashFromPath,
} from "@/lib/sections"
import type { Project, Workspace } from "@/lib/session"
import {
  dayGroupLabel,
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

type Bucket = "settled" | "archived"

/**
 * The sidebar's list of coding sessions: every session in the workspace,
 * either newest first (Sessions) or under their projects (Projects).
 *
 * Session workspaces always show the sessions list; project workspaces
 * remember the chosen grouping per account. The cards come from
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

  const [savedMode, setMode] = useSidebarMode(sessionWorkspace ? "sessions" : "projects")
  const mode = sessionWorkspace ? "sessions" : savedMode
  const [filters, dispatchFilter] = React.useReducer(filterReducer, NO_FILTERS)
  const [collapsed, toggleCollapsed] = useCollapsedProjects(workspace.id)

  /** Settled or Archived, opened from the buttons at the foot, in place of the list. */
  const [bucket, setBucket] = React.useState<Bucket | null>(null)
  React.useEffect(() => {
    setBucket(null)
  }, [workspace.id])

  const { data, dataUpdatedAt, isPending } = useWorkspaceSessions(workspace.id, true)
  const live = useLiveTurns()

  const permissions = workspace.permissions
  const canWrite = permissions.includes("project.write")
  const canStart = permissions.includes("session.create") && (!sessionWorkspace || permissions.includes("project.create"))
  const canCreateProject = permissions.includes("project.create")
  const newQuickSession = useNewSession(workspace.id)

  const [newSessionFor, setNewSessionFor] = React.useState<Project | null>(null)
  const [creatingProject, setCreatingProject] = React.useState(false)
  const [deleteTarget, setDeleteTarget] = React.useState<Project | null>(null)
  const [renameTarget, setRenameTarget] = React.useState<SidebarSession | null>(null)
  const [settleTarget, setSettleTarget] = React.useState<SidebarSession | null>(null)
  const [removeTarget, setRemoveTarget] = React.useState<SidebarSession | null>(null)
  /** A session workspace's session being settled: the files it holds besides `.agent/`. */
  const [settleFiles, setSettleFiles] = React.useState<{ count: number; names: string[] }>({ count: 0, names: [] })

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

  const matching = React.useMemo(() => {
    const sessions = data?.sessions ?? []
    return sessions.filter(
      (s) =>
        passesFilters(s, { ...filters, showArchived: true }, { userId: me?.userId ?? null, status: statusFor(s) }),
    )
  }, [data, filters, me?.userId, statusFor])

  const visible = matching.filter((s) => !s.archivedAt && s.settleState !== "settled")
  const settled = sortSessions(matching.filter((s) => !s.archivedAt && s.settleState === "settled"))
  const archived = sortSessions(matching.filter((s) => Boolean(s.archivedAt)))
  const navigable = bucket === "settled" ? settled : bucket === "archived" ? archived : visible

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
    // The project's base as it is now, not the one the original forked from.
    const created = await startProjectSession(client, project, {
      baseBranch: project.defaultBranch ?? session.project.baseBranch ?? session.baseBranch,
    })
    router.push(projectHref(ws, "project", project.hash, created.hash))
  }

  async function settle(session: SidebarSession) {
    if (sessionWorkspace) {
      await settleWorkspaceSession(session.project.hash)
      toast({ title: `Settled ${session.title}` })
      invalidate(qk.sessions.all, qk.project(session.project.hash))
      return
    }
    let result
    try {
      result = await settleProjectSession(session.project.hash, session.hash ?? "")
    } finally {
      // Settled or failed, the row changed.
      invalidate(qk.sessions.all, qk.git.all)
    }
    const merged = result.mergeCommitSha
      ? `Merged into ${result.baseBranch} @ ${result.mergeCommitSha.slice(0, 7)}.`
      : undefined
    const pushed = result.pushed
      ? ` ${result.pushed} was pushed to origin.`
      : result.pushError
        ? ` Pushing ${result.baseBranch} failed: ${result.pushError}`
        : ""
    toast({ title: `Settled ${session.title}`, description: merged ? merged + pushed : undefined })
    if (result.removed && isActive(session)) router.push(projectHref(ws, "project", session.project.hash))
  }

  /**
   * Settling in a session workspace: no name to type. It asks first only
   * when the session holds files besides `.agent/`; otherwise it settles.
   */
  async function beginSettle(session: SidebarSession) {
    if (!sessionWorkspace) {
      setSettleTarget(session)
      return
    }
    const check = await fetchSessionSettleCheck(session.project.hash)
    if (check.running) throw new Error("The agent is still working in this session. Stop it, then settle.")
    if (check.files > 0) {
      setSettleFiles({ count: check.files, names: check.names })
      setSettleTarget(session)
      return
    }
    await settle(session)
  }

  /**
   * Deletes a settled session for good: its work is merged already. In a
   * project workspace the thread goes; in a session workspace the session
   * is its own project, and goes files and all.
   */
  async function remove(session: SidebarSession) {
    if (sessionWorkspace) {
      const { leftFiles } = await deleteSettledSession(session.project.hash)
      toast({ title: `Deleted ${session.title}`, description: leftFiles ? "Some of its files could not be removed." : undefined })
      invalidate(qk.projects.all, qk.sessions.all, qk.bootstrap())
      if (isActive(session)) router.push(`/${ws}`)
      return
    }
    await settleProjectSession(session.project.hash, session.hash ?? "", { discard: true })
    toast({ title: `Deleted ${session.title}` })
    invalidate(qk.sessions.all, qk.git.all)
    if (isActive(session)) router.push(projectHref(ws, "project", session.project.hash))
  }

  /** Removes a project session without committing: its changes go with its worktree and branch. */
  async function discard(session: SidebarSession) {
    await settleProjectSession(session.project.hash, session.hash ?? "", { discard: true })
    toast({ title: `Settled ${session.title}`, description: "Its changes were not committed." })
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
      )
      out.push(
        "separator",
        session.settleState === "settled"
          ? { label: "Delete session…", icon: Trash2Icon, destructive: true, disabled: working, onSelect: () => setRemoveTarget(session) }
          : {
              label: session.settleState === "failed" ? "Retry settle…" : "Settle…",
              icon: CheckIcon,
              destructive: true,
              disabled: working,
              onSelect: () => void act("settle it", () => beginSettle(session)),
            },
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
  const lazy = navigable.length > VIRTUALIZE_AFTER
  const tabStop = navigable.find((s) => s.id === focusedId)?.id ?? navigable.find(isActive)?.id ?? navigable[0]?.id

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

  /** Sessions under day headings, newest first: Today, Yesterday, Monday, 12 Nov. */
  function byDay(sessions: readonly SidebarSession[]) {
    const today = now === null ? null : new Date(now)
    const groups: { label: string; sessions: SidebarSession[] }[] = []
    for (const s of sortSessions(sessions)) {
      const label = today ? dayGroupLabel(s, today) : ""
      const last = groups.at(-1)
      if (last && last.label === label) last.sessions.push(s)
      else groups.push({ label, sessions: [s] })
    }
    return groups.map((group, i) => (
      <section key={group.label || "all"} aria-label={group.label || undefined} className={cn(i > 0 && "mt-3")}>
        {group.label && <h3 className="text-text-subtle px-1.5 pb-1 text-2xs">{group.label}</h3>}
        <ul className="flex flex-col gap-1">{group.sessions.map((s) => card(s, false))}</ul>
      </section>
    ))
  }

  let body: React.ReactNode
  if (isPending) {
    body = <ListRowsSkeleton rows={6} />
  } else if (bucket) {
    const sessions = bucket === "settled" ? settled : archived
    body =
      sessions.length > 0 ? (
        byDay(sessions)
      ) : (
        <p className="text-muted-foreground px-1.5 py-2 text-xs">No {bucket} sessions.</p>
      )
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
      body = byDay(visible)
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
              onManage={!sessionWorkspace ? () => { router.push(projectPageHref(ws, group.project.hash, "manage")); onNavigate?.() } : undefined}
              onDelete={!sessionWorkspace && permissions.includes("workspace.manage") && project ? () => setDeleteTarget(project) : undefined}
              href={sessionWorkspace ? projectHref(ws, "session", group.project.hash) : projectHref(ws, "project", group.project.hash)}
              isActive={group.project.hash === activeProjectHash}
              onNavigate={onNavigate}
            />
            {open &&
              (group.sessions.length === 0 ? (
                <p className="text-muted-foreground py-1 pr-2 pl-8 text-xs">No active sessions</p>
              ) : (
                <ul className="flex flex-col gap-1 pl-3">{group.sessions.map((s) => card(s, true))}</ul>
              ))}
          </section>
        )
      })
    }
  }

  const tabs: { value: SidebarMode; label: string; count: number }[] = sessionWorkspace
    ? [{ value: "sessions", label: "Sessions", count: visible.length }]
    : [
        { value: "sessions", label: "Sessions", count: visible.length },
        { value: "projects", label: "Projects", count: data?.projects.length ?? projects.length },
      ]

  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
      <div className="border-sidebar-border flex shrink-0 items-center gap-4 border-b px-3">
        <div role="tablist" aria-label="List sessions by" className="flex min-w-0 items-center gap-4">
          {tabs.map((tab) => {
            const selected = !bucket && mode === tab.value
            return (
              <button
                key={tab.value}
                type="button"
                role="tab"
                aria-selected={selected}
                onClick={() => {
                  setBucket(null)
                  if (!sessionWorkspace) setMode(tab.value)
                }}
                className={cn(
                  "focus-visible:ring-focus-ring -mb-px flex shrink-0 items-baseline border-b-2 py-2 text-[13px] transition-colors duration-150 outline-none focus-visible:ring-2 focus-visible:ring-inset",
                  selected
                    ? "border-sidebar-foreground text-sidebar-foreground light:font-semibold"
                    : "text-muted-foreground hover:text-sidebar-foreground border-transparent",
                )}
              >
                {tab.label}
                <span className="text-text-subtle ml-0.5 pl-0.5 text-2xs tabular-nums">{tab.count}</span>
              </button>
            )
          })}
        </div>
        <span className="flex-1" />
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
        className="flex min-h-0 flex-1 flex-col"
      >
        <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2.5 [scrollbar-width:thin]">
          {bucket && (
            <div className="mb-2 flex items-center gap-1 px-0.5">
              <button
                type="button"
                onClick={() => setBucket(null)}
                className="text-muted-foreground hover:text-sidebar-foreground hover:bg-sidebar-hover focus-visible:ring-focus-ring flex items-center gap-1 rounded-md px-1.5 py-1 text-xs transition-colors duration-150 outline-none focus-visible:ring-2"
              >
                <ArrowLeftIcon className="size-3.5" aria-hidden />
                Back to {mode === "projects" && !sessionWorkspace ? "projects" : "sessions"}
              </button>
              <span className="flex-1" />
              <span className="text-text-subtle text-2xs">{bucket === "settled" ? "Settled" : "Archived"}</span>
            </div>
          )}
          <div className="flex flex-col">{body}</div>
        </div>
        {!isPending && (
          <div className="border-sidebar-border flex shrink-0 gap-1.5 border-t px-2.5 pt-2 pb-2.5">
            {(
              [
                { id: "settled", label: "Settled", count: settled.length, icon: CircleCheckIcon },
                { id: "archived", label: "Archived", count: archived.length, icon: ArchiveIcon },
              ] as const
            ).map(({ id, label, count, icon: Icon }) => (
              <button
                key={id}
                type="button"
                aria-pressed={bucket === id}
                onClick={() => setBucket((current) => (current === id ? null : id))}
                className={cn(
                  "focus-visible:ring-focus-ring flex min-w-0 flex-1 items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition-colors duration-150 outline-none focus-visible:ring-2",
                  bucket === id
                    ? "border-border-strong bg-sidebar-accent text-sidebar-foreground"
                    : "border-sidebar-border text-muted-foreground hover:border-border-strong hover:text-sidebar-foreground",
                )}
              >
                <Icon className="size-3.5 shrink-0" aria-hidden />
                <span className="min-w-0 truncate">{label}</span>
                <span className="flex-1" />
                <span className="text-text-subtle tabular-nums">{count}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {newSessionFor && (
        <NewSessionDialog
          project={newSessionFor}
          projects={projects}
          open
          onOpenChange={(open) => !open && setNewSessionFor(null)}
        />
      )}
      {deleteTarget && (
        <DeleteProjectDialog
          project={deleteTarget}
          open
          onOpenChange={(open) => !open && setDeleteTarget(null)}
          onDeleted={(deleted) => {
            setDeleteTarget(null)
            invalidate(qk.projects.all, qk.sessions.all, qk.bootstrap())
            if (deleted.hash === activeProjectHash) router.push(`/${ws}`)
          }}
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
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title={`Delete ${removeTarget?.title ?? "session"}?`}
        description={
          sessionWorkspace
            ? "The session, its conversation and its files are deleted for good. This cannot be undone."
            : "The session and its conversation are deleted for good. Its work is already merged and stays. This cannot be undone."
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          if (removeTarget) await remove(removeTarget)
        }}
      />
      {sessionWorkspace ? (
        <ConfirmDialog
          open={settleTarget !== null}
          onOpenChange={(open) => !open && setSettleTarget(null)}
          title={`Settle ${settleTarget?.title ?? "session"}?`}
          description={`This session has ${settleFiles.count === 1 ? "a file" : `${settleFiles.count} files`} besides .agent/. Settled sessions are deleted, files and all, when you delete settled session data in Workspace Settings. Are you sure you want to settle it?`}
          confirmLabel="Settle"
          onConfirm={async () => {
            if (settleTarget) await settle(settleTarget)
          }}
        >
          {settleFiles.names.length > 0 && (
            <ul className="bg-muted/50 text-muted-foreground max-h-32 overflow-y-auto rounded-md px-3 py-2 font-mono text-xs">
              {settleFiles.names.map((name) => (
                <li key={name} className="truncate">
                  {name}
                </li>
              ))}
              {settleFiles.count > settleFiles.names.length && <li>…and {settleFiles.count - settleFiles.names.length} more</li>}
            </ul>
          )}
        </ConfirmDialog>
      ) : (
        <SettleSessionDialog
          session={settleTarget}
          onOpenChange={(open) => !open && setSettleTarget(null)}
          onSettle={settle}
          onDiscard={discard}
        />
      )}
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
    <div className="flex flex-col items-center gap-1 px-2 py-10 text-center">
      <p className="text-muted-foreground text-[13px]">{narrowed ? "No sessions match" : "Start your first session"}</p>
      <p className="text-text-subtle mb-2 text-xs">
        {narrowed ? "Try a different filter." : "Pick a project and give the agent a task."}
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
