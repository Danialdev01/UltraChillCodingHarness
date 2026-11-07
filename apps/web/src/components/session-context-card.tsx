"use client"

import * as React from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  BotIcon,
  ChevronsRightIcon,
  FileDiffIcon,
  FolderIcon,
  GitBranchIcon,
  GitCommitHorizontalIcon,
  GlobeIcon,
  HistoryIcon,
  PanelRightOpenIcon,
  PinIcon,
  SquareKanbanIcon,
} from "lucide-react"
import type { GitStatus } from "@ucch/protocol"

import { useFilesPanel } from "@/components/files-panel"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { formatDuration } from "@/lib/chat-messages"
import { fetchGitStatus } from "@/lib/git-api"
import { formatUsd } from "@/lib/stats-format"
import { subagentAnchor, useLineage, type LineageEntry } from "@/lib/subagent-lineage"
import { targetOf } from "@/lib/project-target"
import { projectPageHref } from "@/lib/sections"
import type { Project, ProjectSession } from "@/lib/session"
import { cn } from "@/lib/utils"
import { TransitionLink } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

const COLLAPSED_KEY = "ucch:context-card-collapsed"

/**
 * The card beside the conversation: where this session's work lives, what
 * has changed, and who the agent has sent off -- each a click from the view
 * that handles it.
 *
 * Floats at the top right once the chat panel is 84rem wide -- the reading
 * column plus a card's width of margin on each side, so it never covers a
 * line of the thread; narrower, it is one button that opens the same card as a
 * popover, so it never sits over the messages uninvited. Collapsible to
 * that button on wide screens too, remembered per browser.
 */
export function SessionContextCard({
  project,
  session,
}: {
  project: Project & { sessionHash?: string | null }
  session?: ProjectSession | null
}) {
  const [collapsed, setCollapsed] = React.useState(false)
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
  const running = lineage.filter((entry) => entry.run.status === "running").length

  return (
    <>
      {/* Narrow, or hidden on wide: one button, the card as a popover. */}
      <Popover>
        <PopoverTrigger
          render={
            <button
              type="button"
              title="Session details"
              className={cn(
                "bg-popover/90 text-muted-foreground hover:text-foreground data-popup-open:text-foreground absolute top-3 right-3 z-10 grid size-8 place-items-center rounded-lg border shadow-sm backdrop-blur",
                !collapsed && "@[84rem]/session:hidden",
              )}
            />
          }
        >
          <PanelRightOpenIcon className="size-4" />
          {running > 0 && (
            <span className="bg-ucch-active absolute -top-0.5 -right-0.5 size-2 rounded-full" aria-hidden />
          )}
          <span className="sr-only">Session details</span>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-64 p-0">
          <CardBody project={project} session={session} />
          {collapsed && (
            <div className="border-t p-1.5">
              <button
                type="button"
                onClick={() => toggle(false)}
                className="text-muted-foreground hover:text-foreground hover:bg-muted flex h-7 w-full items-center gap-2 rounded-md px-1.5 text-xs"
              >
                <PinIcon className="size-3.5" />
                Keep beside the chat
              </button>
            </div>
          )}
        </PopoverContent>
      </Popover>

      {!collapsed && (
        <aside
          aria-label="Session details"
          className="bg-popover/90 absolute top-3 right-3 z-10 hidden w-64 flex-col rounded-xl border text-sm shadow-sm backdrop-blur @[84rem]/session:flex"
        >
          <CardBody project={project} session={session} onHide={() => toggle(true)} />
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
  const changes = status?.files.length ?? null
  const branch = status?.branch ?? session?.branch ?? project.defaultBranch ?? null
  const manageable = project.workspaceKind !== "session"
  const running = lineage.filter((entry) => entry.run.status === "running").length
  const busy = status?.mergeInProgress ? "merging" : status?.rebaseInProgress ? "rebasing" : null

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
          {session?.baseBranch && (
            <p className="text-muted-foreground -mt-0.5 truncate pb-1 pl-8 text-2xs">from {session.baseBranch}</p>
          )}
          <Row
            icon={GitCommitHorizontalIcon}
            onClick={changes ? () => setMode("git") : undefined}
            title={changes ? "Commit these changes" : "Nothing to commit"}
          >
            <span className={cn(!changes && "text-muted-foreground")}>Commit</span>
            {busy && <span className="text-warning ml-auto shrink-0 text-2xs">{busy}</span>}
          </Row>
          <Row icon={FileDiffIcon} onClick={() => setMode("git")} title="Review changes">
            <span>Changes</span>
            <span
              className={cn(
                "ml-auto flex shrink-0 items-center gap-1.5 text-2xs tabular-nums",
                changes ? "text-ucch-active font-medium" : "text-muted-foreground",
              )}
            >
              {changes ? <span className="bg-ucch-active size-1.5 rounded-full" aria-hidden /> : null}
              {changes === null
                ? "…"
                : changes === 0
                  ? "clean"
                  : `${changes}${status?.truncated ? "+" : ""} ${changes === 1 ? "file" : "files"}`}
            </span>
          </Row>
        </div>
      )}

      {/* Lineage: who the agent sent off in this thread, newest last. */}
      {lineage.length > 0 && (
        <div className="flex flex-col border-t px-1.5 py-1.5" data-testid="session-lineage">
          <p className="text-muted-foreground flex h-7 items-center px-1.5 text-2xs">
            Lineage
            {running > 0 && <span className="text-ucch-active">&nbsp;· {running} running</span>}
          </p>
          <div className="flex max-h-48 flex-col overflow-y-auto">
            {lineage.map(({ callId, run }) => (
              <button
                key={`${callId}:${run.id}`}
                type="button"
                onClick={() => {
                  setMode("chat")
                  const card = document.getElementById(subagentAnchor(callId))
                  if (card instanceof HTMLDetailsElement) card.open = true
                  card?.scrollIntoView({ behavior: "smooth", block: "start" })
                }}
                title={lineageTitle(run)}
                className="hover:bg-muted focus-visible:ring-ring flex h-8 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left outline-none focus-visible:ring-2"
              >
                <BotIcon
                  className={cn(
                    "size-4 shrink-0",
                    run.status === "running"
                      ? "text-ucch-active"
                      : run.status === "failed"
                        ? "text-destructive"
                        : "text-muted-foreground",
                  )}
                />
                <span className="truncate">{run.description ?? run.agent}</span>
                <span className="text-muted-foreground ml-auto shrink-0 text-2xs tabular-nums">
                  {run.status === "running"
                    ? "running"
                    : run.status === "failed"
                      ? "failed"
                      : run.status === "aborted"
                        ? "stopped"
                        : (formatDuration(run.durationMs) ?? "done")}
                </span>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

/** The hover line for a subagent: what it ran as, and what it cost. */
function lineageTitle(run: LineageEntry["run"]): string {
  return [
    run.agent,
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
