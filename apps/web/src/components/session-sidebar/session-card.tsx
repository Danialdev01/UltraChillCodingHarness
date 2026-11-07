"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"
import { CheckIcon, ClockIcon, FolderIcon, GitBranchIcon, HardDriveIcon, MoreHorizontalIcon, PinIcon } from "lucide-react"

import { HarnessIcon } from "@/components/harness-icon"
import { ProjectStackIcon } from "@/components/project-stack-icon"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "@/components/ui/context-menu"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { highlightRanges, type SessionStatus, type SidebarSession } from "@/lib/session-sidebar"
import { cn } from "@/lib/utils"
import { TransitionLink } from "@/lib/view-transitions"

export type SessionAction = {
  label: string
  icon?: React.ComponentType<{ className?: string }>
  onSelect: () => void
  disabled?: boolean
  destructive?: boolean
}

/** How long the pointer rests on a card before its details open beside it. */
export const HOVER_DELAY_MS = 300

/**
 * One session in the sidebar.
 *
 * Three lines: its project (left out inside a project's group, where it
 * would repeat the header) with the status at the right, the title as the
 * one bright line, then the branch and the harness's mark. At rest the
 * status column shows how long ago it last did anything; hovered, focused
 * or open it shows the status badge instead (the full card). A running
 * session's mark breathes in the compact card rather than adding a badge.
 *
 * Its details -- project, where it runs, branch, model -- open beside it
 * after a short rest, or at once on keyboard focus (`role="tooltip"`). Its
 * actions are behind ⋯ and on right-click, the same list in both.
 */
export function SessionCard({
  session,
  status,
  href,
  isActive,
  hideProject = false,
  query = "",
  time,
  modelLabel,
  hostName,
  actions,
  onNavigate,
  rovingTabIndex,
  onFocusCard,
}: {
  session: SidebarSession
  status: SessionStatus
  href: string
  isActive?: boolean
  hideProject?: boolean
  /** The search, for highlighting what it matched. */
  query?: string
  /** "6h": since its last activity. */
  time: string
  modelLabel: string
  /** The workspace (or host) it runs in, for the details. */
  hostName: string | null
  actions: readonly (SessionAction | "separator")[]
  onNavigate?: () => void
  /** 0 for the one card in the list that takes the Tab stop, -1 for the rest. */
  rovingTabIndex?: number
  onFocusCard?: () => void
}) {
  const tooltipId = React.useId()
  const [menuOpen, setMenuOpen] = React.useState(false)
  const branch = session.branch ?? session.baseBranch ?? "main"
  const running = status === "running"

  return (
    <ContextMenu>
      <ContextMenuTrigger
        className="group/session relative"
        data-active={isActive || undefined}
        data-session-card={session.id}
      >
        <TooltipPrimitive.Root disabled={menuOpen}>
          <TooltipPrimitive.Trigger
            delay={HOVER_DELAY_MS}
            closeDelay={0}
            render={
              <TransitionLink
                href={href}
                onClick={onNavigate}
                onFocus={onFocusCard}
                tabIndex={rovingTabIndex}
                aria-current={isActive ? "page" : undefined}
                aria-describedby={tooltipId}
                data-session-link=""
              />
            }
            className={cn(
              "focus-visible:ring-sidebar-ring flex min-w-0 flex-col gap-0.5 rounded-lg px-2.5 py-2 transition-colors outline-none focus-visible:ring-2",
              isActive
                ? "bg-sidebar-accent text-sidebar-accent-foreground"
                : "hover:bg-sidebar-accent/60 text-sidebar-foreground",
            )}
          >
            {!hideProject && (
              <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 pr-6 text-2xs">
                <span className="grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5" aria-hidden>
                  <ProjectStackIcon stack={session.project.stack} />
                </span>
                <span className="min-w-0 flex-1 truncate">
                  <Highlighted text={session.project.name} query={query} />
                </span>
                <StatusColumn status={status} time={time} isActive={isActive} />
              </span>
            )}
            <span className={cn("flex min-w-0 items-center gap-1.5", hideProject && "pr-6")}>
              {session.pinned && <PinIcon className="text-muted-foreground size-3 shrink-0" aria-label="Pinned" />}
              <span className={cn("min-w-0 flex-1 truncate text-sm leading-snug", isActive ? "font-medium" : "font-normal")}>
                <Highlighted text={session.title} query={query} />
              </span>
              {hideProject && <StatusColumn status={status} time={time} isActive={isActive} />}
            </span>
            <span className="text-muted-foreground flex min-w-0 items-center justify-between gap-2 text-2xs">
              <span className="flex min-w-0 items-center gap-1 font-mono">
                <GitBranchIcon className="size-3 shrink-0" aria-hidden />
                <span className="truncate">
                  <Highlighted text={branch} query={query} />
                </span>
              </span>
              <HarnessIcon harness={session.provider} size={16} pulse={running} />
            </span>
          </TooltipPrimitive.Trigger>
          <TooltipPrimitive.Portal>
            <TooltipPrimitive.Positioner side="right" align="start" sideOffset={8} className="isolate z-50">
              <TooltipPrimitive.Popup
                id={tooltipId}
                role="tooltip"
                className="bg-popover text-popover-foreground ring-foreground/10 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0 z-50 flex w-64 flex-col gap-1.5 rounded-lg p-3 text-xs shadow-md ring-1"
              >
                <SessionDetails session={session} branch={branch} modelLabel={modelLabel} hostName={hostName} />
              </TooltipPrimitive.Popup>
            </TooltipPrimitive.Positioner>
          </TooltipPrimitive.Portal>
        </TooltipPrimitive.Root>

        {actions.length > 0 && (
          <DropdownMenu open={menuOpen} onOpenChange={setMenuOpen}>
            <DropdownMenuTrigger
              className={cn(
                "text-muted-foreground hover:text-foreground hover:bg-background/70 focus-visible:ring-sidebar-ring absolute top-1.5 right-1.5 grid size-6 place-items-center rounded-md transition-opacity outline-none focus-visible:ring-2",
                // Always there on a touch screen, which has no hover to reveal it.
                "pointer-fine:opacity-0 pointer-fine:group-hover/session:opacity-100 pointer-fine:focus-visible:opacity-100 aria-expanded:opacity-100",
              )}
              tabIndex={-1}
            >
              <MoreHorizontalIcon className="size-4" />
              <span className="sr-only">Actions for {session.title}</span>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-44">
              <ActionItems actions={actions} />
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </ContextMenuTrigger>
      {actions.length > 0 && (
        <ContextMenuContent>
          <ActionItems actions={actions} />
        </ContextMenuContent>
      )}
    </ContextMenu>
  )
}

function ActionItems({ actions }: { actions: readonly (SessionAction | "separator")[] }) {
  return actions.map((action, i) =>
    action === "separator" ? (
      <DropdownMenuSeparator key={`sep-${i}`} />
    ) : (
      <DropdownMenuItem
        key={action.label}
        disabled={action.disabled}
        variant={action.destructive ? "destructive" : "default"}
        onClick={action.onSelect}
      >
        {action.icon && <action.icon />}
        {action.label}
      </DropdownMenuItem>
    ),
  )
}

/**
 * The card's right-hand status: its age at rest, its badge when hovered,
 * focused or open. A session that needs someone, or failed, keeps a dot
 * beside its age even at rest -- that is worth seeing without hovering.
 */
function StatusColumn({ status, time, isActive }: { status: SessionStatus; time: string; isActive?: boolean }) {
  const badge = status !== "idle" && status !== "archived"
  return (
    <span className="flex shrink-0 items-center gap-1.5 text-2xs tabular-nums">
      <span
        className={cn(
          "text-muted-foreground flex items-center gap-1",
          badge && "group-hover/session:hidden group-focus-within/session:hidden",
          badge && isActive && "hidden",
        )}
      >
        {(status === "waiting_input" || status === "error") && <StatusDot status={status} />}
        {status === "archived" ? "Archived" : time}
      </span>
      {badge && (
        <span
          className={cn(
            "hidden items-center gap-1 group-hover/session:flex group-focus-within/session:flex",
            isActive && "flex",
          )}
        >
          {status === "running" && <ClockIcon className="text-muted-foreground size-3" aria-hidden />}
          <StatusBadge status={status} />
        </span>
      )}
      {badge && <span className="sr-only">{STATUS_TEXT[status]}</span>}
    </span>
  )
}

const STATUS_TEXT: Record<SessionStatus, string> = {
  idle: "",
  running: "Running",
  waiting_input: "Needs input",
  settled: "Settled",
  error: "Error",
  archived: "Archived",
}

export function StatusBadge({ status }: { status: SessionStatus }) {
  if (status === "idle" || status === "archived") return null
  if (status === "settled") {
    return (
      <span className="text-success flex items-center gap-0.5" aria-hidden>
        <CheckIcon className="size-3" />
        Settled
      </span>
    )
  }
  return (
    <span
      className={cn(
        "flex items-center gap-1",
        status === "running" && "text-info",
        status === "waiting_input" && "text-warning",
        status === "error" && "text-destructive",
      )}
      aria-hidden
    >
      <StatusDot status={status} />
      {STATUS_TEXT[status]}
    </span>
  )
}

function StatusDot({ status }: { status: SessionStatus }) {
  return (
    <span
      className={cn(
        "ucch-status-dot size-1.5!",
        status === "waiting_input" && "bg-warning",
      )}
      data-status={status === "running" ? "working" : status === "error" ? "error" : undefined}
      aria-hidden
    />
  )
}

/** The hover card: title, then a row per fact, the model with its harness's mark. */
function SessionDetails({
  session,
  branch,
  modelLabel,
  hostName,
}: {
  session: SidebarSession
  branch: string
  modelLabel: string
  hostName: string | null
}) {
  const row = "text-muted-foreground flex min-w-0 items-center gap-2"
  return (
    <>
      <span className="text-sm font-semibold leading-snug break-words">{session.title}</span>
      <span className={row}>
        <span className="grid size-3.5 shrink-0 place-items-center [&_svg]:size-3.5" aria-hidden>
          {session.project.stack ? <ProjectStackIcon stack={session.project.stack} /> : <FolderIcon />}
        </span>
        <span className="truncate">{session.project.name}</span>
      </span>
      {hostName && (
        <span className={row}>
          <HardDriveIcon className="size-3.5 shrink-0" aria-hidden />
          <span className="truncate">{hostName}</span>
        </span>
      )}
      <span className={row}>
        <GitBranchIcon className="size-3.5 shrink-0" aria-hidden />
        <span className="truncate font-mono">{branch}</span>
      </span>
      <span className={row}>
        <HarnessIcon harness={session.provider} size={14} />
        <span className="truncate">{modelLabel}</span>
      </span>
    </>
  )
}

/** `text` with the spans the search matched marked. */
export function Highlighted({ text, query }: { text: string; query: string }) {
  const ranges = highlightRanges(text, query)
  if (ranges.length === 0) return <>{text}</>
  const parts: React.ReactNode[] = []
  let at = 0
  for (const [start, end] of ranges) {
    if (start > at) parts.push(text.slice(at, start))
    parts.push(
      <mark key={start} className="bg-warning-soft text-foreground rounded-xs">
        {text.slice(start, end)}
      </mark>,
    )
    at = end
  }
  if (at < text.length) parts.push(text.slice(at))
  return <>{parts}</>
}
