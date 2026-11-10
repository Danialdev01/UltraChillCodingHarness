"use client"

import * as React from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  ChevronsRightIcon,
  CrosshairIcon,
  FolderIcon,
  GitBranchIcon,
  GlobeIcon,
  HistoryIcon,
  Loader2Icon,
  PanelRightOpenIcon,
  SearchIcon,
  SquareKanbanIcon,
  SquareTerminalIcon,
} from "lucide-react"
import type { GitStatus } from "@ucch/protocol"

import { useFilesPanel } from "@/components/files-panel"
import { HarnessIcon } from "@/components/harness-icon"
import { formatDuration } from "@/lib/chat-messages"
import { fetchGitStatus } from "@/lib/git-api"
import { formatUsd } from "@/lib/stats-format"
import {
  lineageKey,
  subagentAnchor,
  subagentHref,
  toolAnchor,
  useLineage,
  useLineagePartition,
  useShellCalls,
  type LineageEntry,
} from "@/lib/subagent-lineage"
import { targetOf } from "@/lib/project-target"
import { projectPageHref } from "@/lib/sections"
import type { Project, ProjectSession } from "@/lib/session"
import { cn } from "@/lib/utils"
import { TransitionLink } from "@/lib/view-transitions"
import { useActiveWorkspace, useWorkspaceHash } from "@/lib/workspace-context"

const COLLAPSED_KEY = "ucch:context-card-collapsed"
const DONE_OPEN_KEY = "ucch:context-card-done-open"

/**
 * The card beside the conversation: where this session's work lives, what
 * has changed, and who the agent has sent off -- each a click from the view
 * that handles it.
 *
 * Floats at the top right once the chat panel is 84rem wide -- the reading
 * column plus a card's width of margin on each side, so it never covers a
 * line of the thread; narrower, it is one button that opens the same card as a
 * persistent card when opened. Collapsible to that button on wide screens
 * too, remembered per browser. Reopening restores the same card.
 */
export function SessionContextCard({
  project,
  session,
}: {
  project: Project & { sessionHash?: string | null }
  session?: ProjectSession | null
}) {
  const [collapsed, setCollapsed] = React.useState(false)
  const [openedOnNarrow, setOpenedOnNarrow] = React.useState(false)
  React.useEffect(() => {
    try {
      setCollapsed(localStorage.getItem(COLLAPSED_KEY) === "1")
    } catch {}
  }, [])
  function toggle(next: boolean) {
    setCollapsed(next)
    try {
      localStorage.setItem(COLLAPSED_KEY, next ? "1" : "0")
    } catch {}
  }
  const lineage = useLineage()
  const shells = useShellCalls()
  const running = lineage.filter((entry) => entry.run.status === "running").length + shells.length

  return (
    <>
      <button
        type="button"
        title="Session details"
        aria-label="Session details"
        aria-expanded={false}
        onClick={() => {
          toggle(false)
          setOpenedOnNarrow(true)
        }}
        className={cn(
          "bg-popover/90 text-muted-foreground hover:text-foreground absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-lg border shadow-sm backdrop-blur",
          !collapsed && (openedOnNarrow ? "hidden" : "@[84rem]/session:hidden"),
        )}
      >
        <PanelRightOpenIcon className="size-4" />
        {running > 0 && (
          <span className="bg-ucch-active absolute -top-0.5 -right-0.5 size-2 rounded-full" aria-hidden />
        )}
      </button>

      {!collapsed && (
        <aside
          aria-label="Session details"
          className={cn(
            "bg-popover/90 absolute top-3 right-3 z-10 w-64 flex-col rounded-xl border text-sm shadow-sm backdrop-blur",
            openedOnNarrow ? "flex" : "hidden @[84rem]/session:flex",
          )}
        >
          <CardBody project={project} session={session} onHide={() => {
              toggle(true)
              setOpenedOnNarrow(false)
            }} />
        </aside>
      )}
    </>
  )
}

function CardBody({
  project,
  session,
  onHide,
}: {
  project: Project & { sessionHash?: string | null }
  session?: ProjectSession | null
  onHide?: () => void
}) {
  const { setMode } = useFilesPanel()
  const ws = useWorkspaceHash()
  const read = useGitStatus(project)
  const noRepo = read === "none"
  const status = read === "none" ? null : read
  const lineage = useLineage()
  const shells = useShellCalls()
  const branch = status?.branch ?? session?.branch ?? project.defaultBranch ?? null
  const manageable = project.workspaceKind !== "session"
  const running = lineage.filter((entry) => entry.run.status === "running").length
  const { active, done, lingering } = useLineagePartition(lineage)
  const kind = useActiveWorkspace()?.kind ?? "project"
  const hrefOf = (entry: LineageEntry) =>
    subagentHref(entry, { ws, projectHash: project.hash, parentHash: session?.hash ?? null, kind })
  /** Opens a call's row in the thread and scrolls to it. */
  function reveal(anchor: string) {
    setMode("chat")
    const row = document.getElementById(anchor)
    if (row instanceof HTMLDetailsElement) row.open = true
    row?.scrollIntoView({ behavior: "smooth", block: "start" })
  }

  return (
    <div className="flex flex-col text-sm">
      {/* Where: the tree this session works in, and its doors. */}
      <div className="flex flex-col px-1.5 py-1.5">
        <div className="flex h-8 items-center gap-2 px-1.5">
          <FolderIcon className="text-muted-foreground size-4 shrink-0" />
          <span className="truncate font-medium">{project.name}</span>
          {onHide && (
            <button
              type="button"
              onClick={onHide}
              title="Hide"
              className="text-muted-foreground hover:text-foreground hover:bg-muted ml-auto -mr-1 grid size-6 shrink-0 place-items-center rounded-md"
            >
              <ChevronsRightIcon className="size-3.5" />
              <span className="sr-only">Hide session details</span>
            </button>
          )}
        </div>
        <Row
          icon={GlobeIcon}
          href={project.previewUrl ?? undefined}
          title={project.previewPort ? "Open the preview" : "Set up a preview from the globe in the header"}
        >
          <span>Preview</span>
          <span className="text-muted-foreground ml-auto shrink-0 text-2xs tabular-nums">
            {project.previewPort ? `:${project.previewPort}` : "off"}
          </span>
        </Row>
        {manageable && (
          <Row icon={SquareKanbanIcon} to={projectPageHref(ws, project.hash, "tasks")} title="The project's task board">
            <span>Tasks</span>
          </Row>
        )}
        {manageable && (
          <Row icon={HistoryIcon} to={projectPageHref(ws, project.hash, "timeline")} title="The project's timeline">
            <span>Timeline</span>
          </Row>
        )}
      </div>

      {/* Git: a session without a repository has nothing to say here. */}
      {!noRepo && (
        <div className="flex flex-col border-t px-1.5 py-1.5">
          <Row icon={GitBranchIcon} onClick={() => setMode("git")} title="Open Git">
            <span className="truncate font-medium">{branch ?? "…"}</span>
            {status && (status.ahead > 0 || status.behind > 0) && (
              <span className="text-muted-foreground ml-auto flex shrink-0 items-center gap-1.5 text-2xs tabular-nums">
                {status.ahead > 0 && (
                  <span className="flex items-center">
                    <ArrowUpIcon className="size-3" />
                    {status.ahead}
                  </span>
                )}
                {status.behind > 0 && (
                  <span className="flex items-center">
                    <ArrowDownIcon className="size-3" />
                    {status.behind}
                  </span>
                )}
              </span>
            )}
          </Row>
          <GitOwnership project={project} session={session} />

        </div>
      )}

      {/* Subagents: who is out now, and who came back a moment ago. */}
      {active.length > 0 && (
        <div className="flex flex-col border-t px-1.5 py-1.5" data-testid="session-lineage">
          <p className="text-muted-foreground flex h-7 items-center px-1.5 text-2xs">
            Subagents
            {running > 0 && <span className="text-ucch-active">&nbsp;· {running} running</span>}
          </p>
          <div className="flex flex-col">
            {active.map((entry) => (
              <LineageRow
                key={lineageKey(entry)}
                entry={entry}
                href={hrefOf(entry)}
                fading={lingering(entry)}
                onReveal={() => reveal(subagentAnchor(entry.callId))}
              />
            ))}
          </div>
        </div>
      )}

      {/* Done: everyone back for a while, folded, and searchable. */}
      {done.length > 0 && (
        <DoneLineage entries={done} hrefOf={hrefOf} onReveal={(entry) => reveal(subagentAnchor(entry.callId))} />
      )}

      {/* Terminal: the shell commands the agent is running right now. */}
      {shells.length > 0 && (
        <div className="flex flex-col border-t px-1.5 py-1.5" data-testid="session-terminal">
          <p className="text-muted-foreground flex h-7 items-center px-1.5 text-2xs">
            Terminal
            <span className="text-ucch-active">&nbsp;· {shells.length} running</span>
          </p>
          <div className="flex flex-col">
            {shells.map((entry) => (
              <button
                key={entry.callId}
                type="button"
                onClick={() => reveal(toolAnchor(entry.callId))}
                title={entry.command}
                className="hover:bg-muted focus-visible:ring-ring flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left outline-none focus-visible:ring-2"
              >
                <SquareTerminalIcon className="text-ucch-active size-4 shrink-0" />
                <span className="truncate font-mono text-xs">{entry.command}</span>
                <span className="text-muted-foreground ml-auto flex shrink-0 items-center text-2xs tabular-nums">
                  {entry.status === "approval" ? (
                    <span className="text-ucch-active">needs approval</span>
                  ) : (
                    <Loader2Icon className="size-3 animate-spin" aria-label="running" />
                  )}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/**
 * The finished subagents, folded under one line until asked for: the list
 * a long session builds up would otherwise push everything else off the
 * card. Open, a search over what each was asked and ran as.
 */
/** Finished subagents per page of the Done list. */
const DONE_PAGE_SIZE = 5

function DoneLineage({
  entries,
  hrefOf,
  onReveal,
}: {
  entries: readonly LineageEntry[]
  hrefOf: (entry: LineageEntry) => string | null
  onReveal: (entry: LineageEntry) => void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  React.useEffect(() => {
    try {
      setOpen(localStorage.getItem(DONE_OPEN_KEY) === "1")
    } catch {}
  }, [])
  function toggle() {
    const next = !open
    setOpen(next)
    try {
      localStorage.setItem(DONE_OPEN_KEY, next ? "1" : "0")
    } catch {}
  }
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? entries.filter(({ run }) =>
        [run.description, run.agent, run.model, run.prompt, run.provider].some((field) =>
          field?.toLowerCase().includes(needle),
        ),
      )
    : entries
  // A page at a time: a long session's finished subagents would bury the card.
  const [page, setPage] = React.useState(0)
  const pages = Math.max(1, Math.ceil(shown.length / DONE_PAGE_SIZE))
  // A search, or entries ageing out, can leave the page past the end.
  const current = Math.min(page, pages - 1)
  const visible = shown.slice(current * DONE_PAGE_SIZE, (current + 1) * DONE_PAGE_SIZE)

  return (
    <div className="flex flex-col border-t px-1.5 py-1.5" data-testid="session-lineage-done">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="text-muted-foreground hover:text-foreground flex h-7 items-center gap-1 rounded-md px-1.5 text-left text-2xs"
      >
        <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", open && "rotate-90")} />
        Done
        <span className="tabular-nums">&nbsp;· {entries.length}</span>
      </button>
      {open && (
        <>
          <label className="bg-muted/50 focus-within:ring-ring mx-1 mb-1 flex h-7 items-center gap-1.5 rounded-md border px-1.5 focus-within:ring-2">
            <SearchIcon className="text-muted-foreground size-3.5 shrink-0" />
            <input
              type="search"
              value={query}
              onChange={(event) => {
                setQuery(event.target.value)
                setPage(0)
              }}
              placeholder="Find a subagent"
              aria-label="Find a finished subagent"
              className="placeholder:text-muted-foreground min-w-0 flex-1 bg-transparent text-xs outline-none"
            />
          </label>
          <div className="flex flex-col">
            {shown.length === 0 ? (
              <p className="text-muted-foreground px-1.5 py-1.5 text-2xs">No match</p>
            ) : (
              visible.map((entry) => (
                <LineageRow
                  key={lineageKey(entry)}
                  entry={entry}
                  href={hrefOf(entry)}
                  onReveal={() => onReveal(entry)}
                />
              ))
            )}
          </div>
          {pages > 1 && (
            <nav
              aria-label="Finished subagents pages"
              className="text-muted-foreground mt-1 flex items-center gap-1 px-1.5 text-2xs"
              data-testid="session-lineage-pages"
            >
              <span className="tabular-nums">
                {current * DONE_PAGE_SIZE + 1}–{Math.min((current + 1) * DONE_PAGE_SIZE, shown.length)} of {shown.length}
              </span>
              <button
                type="button"
                onClick={() => setPage(current - 1)}
                disabled={current === 0}
                aria-label="Previous page"
                className="hover:text-foreground hover:bg-muted ml-auto grid size-6 place-items-center rounded-md disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronLeftIcon className="size-3.5" />
              </button>
              <span className="tabular-nums">
                {current + 1} / {pages}
              </span>
              <button
                type="button"
                onClick={() => setPage(current + 1)}
                disabled={current === pages - 1}
                aria-label="Next page"
                className="hover:text-foreground hover:bg-muted grid size-6 place-items-center rounded-md disabled:pointer-events-none disabled:opacity-40"
              >
                <ChevronRightIcon className="size-3.5" />
              </button>
            </nav>
          )}
        </>
      )}
    </div>
  )
}

/**
 * One subagent: its harness's mark, what it is on, how it is getting on.
 * The row opens its own page where it has one, and its card in the thread
 * otherwise; the crosshair always finds the card.
 */
function LineageRow({
  entry,
  href,
  fading = false,
  onReveal,
}: {
  entry: LineageEntry
  href: string | null
  /** Back a moment ago, and about to fold into Done. */
  fading?: boolean
  onReveal: () => void
}) {
  const { run } = entry
  const progress = run.status === "running" ? run.summary : null
  const className =
    "hover:bg-muted focus-visible:ring-ring flex min-h-8 w-full min-w-0 flex-col justify-center rounded-md px-1.5 py-1 text-left outline-none focus-visible:ring-2"
  const body = (
    <>
      <span className="flex w-full min-w-0 items-center gap-2">
        {/* Its harness's mark: its own, or the one it ran inside. */}
        <HarnessIcon
          harness={run.provider ?? entry.harness ?? "native"}
          size={16}
          pulse={run.status === "running"}
          className={run.status === "failed" ? "text-destructive" : undefined}
        />
        <span className="truncate">{run.description ?? run.agent}</span>
        {run.model && run.provider && (
          <span className="text-muted-foreground min-w-0 truncate font-mono text-2xs">{run.model}</span>
        )}
        <span
          className={cn(
            "text-muted-foreground ml-auto shrink-0 text-2xs tabular-nums",
            // The crosshair takes this corner on hover.
            href && "group-focus-within/lineage:invisible group-hover/lineage:invisible",
          )}
        >
          {run.status === "running"
            ? run.toolCalls
              ? `${run.toolCalls} ${run.toolCalls === 1 ? "call" : "calls"}`
              : "running"
            : run.status === "failed"
              ? "failed"
              : run.status === "aborted"
                ? "stopped"
                : (formatDuration(run.durationMs) ?? "done")}
        </span>
      </span>
      {progress && <span className="text-muted-foreground w-full truncate pl-6 text-2xs">{progress}</span>}
    </>
  )
  return (
    <div
      className={cn("group/lineage relative", fading && "bg-muted/40 rounded transition-colors")}
      data-testid="lineage-row"
      data-status={run.status}
    >
      {href ? (
        <TransitionLink href={href} title={lineageTitle(run)} className={className}>
          {body}
        </TransitionLink>
      ) : (
        <button type="button" onClick={onReveal} title={lineageTitle(run)} className={className}>
          {body}
        </button>
      )}
      {href && (
        <button
          type="button"
          onClick={onReveal}
          title="Show in the thread"
          className="text-muted-foreground hover:text-foreground hover:bg-background absolute top-1.5 right-1 hidden size-5 place-items-center rounded group-focus-within/lineage:grid group-hover/lineage:grid"
        >
          <CrosshairIcon className="size-3" />
          <span className="sr-only">Show in the thread</span>
        </button>
      )}
    </div>
  )
}

/** The hover line for a subagent: what it ran as, and what it cost. */
function lineageTitle(run: LineageEntry["run"]): string {
  return [
    run.agent,
    run.model,
    run.toolCalls !== null ? `${run.toolCalls} ${run.toolCalls === 1 ? "call" : "calls"}` : null,
    formatDuration(run.durationMs),
    run.costUsd ? formatUsd(run.costUsd) : null,
  ]
    .filter(Boolean)
    .join(" · ")
}

function Row({
  icon: Icon,
  onClick,
  href,
  to,
  title,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  onClick?: () => void
  /** An address outside the app, opened in a new tab. */
  href?: string
  /** A page of the app. */
  to?: string
  title?: string
  children: React.ReactNode
}) {
  const className =
    "hover:bg-muted focus-visible:ring-ring flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left outline-none focus-visible:ring-2"
  const body = (
    <>
      <Icon className="text-muted-foreground size-4 shrink-0" />
      {children}
    </>
  )
  if (to)
    return (
      <TransitionLink href={to} title={title} className={className}>
        {body}
      </TransitionLink>
    )
  if (href)
    return (
      <a href={href} target="_blank" rel="noreferrer" title={title} className={className}>
        {body}
      </a>
    )
  return (
    <button type="button" onClick={onClick} title={title} className={className} disabled={!onClick}>
      {body}
    </button>
  )
}

/**
 * The working tree's status, read when the card mounts, every 20 seconds
 * while the tab is visible, and when the window regains focus -- enough to
 * follow an agent's edits without a socket of its own.
 */
function useGitStatus(project: { hash: string; sessionHash?: string | null }): GitStatus | null | "none" {
  // "none": the tree has no repository to read (or the server said no).
  const [status, setStatus] = React.useState<GitStatus | null | "none">(null)
  const target = targetOf(project)
  const key = typeof target === "string" ? target : `${target.hash}:${target.session ?? ""}`

  React.useEffect(() => {
    let cancelled = false
    setStatus(null)
    const load = () => {
      if (document.visibilityState !== "visible") return
      fetchGitStatus(target)
        .then((next) => !cancelled && setStatus(next))
        .catch(() => !cancelled && setStatus("none"))
    }
    load()
    const timer = window.setInterval(load, 20_000)
    window.addEventListener("focus", load)
    return () => {
      cancelled = true
      window.clearInterval(timer)
      window.removeEventListener("focus", load)
    }
    // `target` is rebuilt every render; `key` is what it says.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  return status
}

/**
 * Whose repository this is and where the session's work goes:
 * `ucch/x → main` while it works, `merged into main @ abc1234` once
 * settled, and the files that conflicted when a settle failed.
 */
function GitOwnership({ project, session }: { project: Project; session?: ProjectSession | null }) {
  const base = session?.settleBaseBranch ?? project.defaultBranch ?? session?.baseBranch ?? null
  const repo = project.repoUrl ? repoLabel(project.repoUrl) : "local repository"
  return (
    <div className="text-muted-foreground -mt-0.5 flex min-w-0 flex-col gap-0.5 pb-1 pl-8 text-2xs">
      <span className="truncate" title={project.repoUrl ?? undefined}>
        {project.name} · {repo}
      </span>
      {session?.settleState === "settled" ? (
        <span className="truncate font-mono">
          merged into {base}
          {session.mergeCommitSha ? ` @ ${session.mergeCommitSha.slice(0, 7)}` : ""}
        </span>
      ) : session?.branch ? (
        <span className="truncate font-mono" title={`Settling merges ${session.branch} into ${base ?? "the base branch"}`}>
          {session.branch} → {base ?? "base"}
        </span>
      ) : base ? (
        <span className="truncate font-mono">on {base}</span>
      ) : null}
      {session?.settleState === "failed" && (
        <span className="text-destructive flex flex-col gap-0.5" role="status">
          <span>Settle failed{session.settleConflicts?.length ? " – conflicts" : ""}</span>
          {session.settleConflicts?.slice(0, 10).map((path) => (
            <span key={path} className="truncate font-mono">
              {path}
            </span>
          ))}
        </span>
      )}
    </div>
  )
}

/** `host/owner/name` from a repository URL, with no scheme, credentials or `.git`. */
function repoLabel(url: string): string {
  try {
    const parsed = new URL(url)
    return `${parsed.host}${parsed.pathname}`.replace(/\.git$/, "").replace(/\/$/, "")
  } catch {
    return url.replace(/^[^@]*@/, "").replace(":", "/").replace(/\.git$/, "")
  }
}
