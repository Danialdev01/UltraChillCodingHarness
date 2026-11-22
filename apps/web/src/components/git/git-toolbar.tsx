"use client"

import * as React from "react"
import { SESSION_BRANCH_PREFIX, isReservedBranchName, isSessionBranch } from "@ucch/protocol/plain"
import type { GitBranchList, GitStatus } from "@ucch/protocol"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CloudUploadIcon,
  FolderGit2Icon,
  GitBranchIcon,
  HistoryIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
  ShieldCheckIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { relativeTime } from "@/lib/stats-format"
import { cn } from "@/lib/utils"

import type { ProjectRepoBranch } from "./use-git-state"

/**
 * The strip along the top: which branch, and the one button that talks to
 * the remote.
 *
 * The button reads like GitHub Desktop's: it says what pressing it would do
 * given where the branch stands -- add a remote when there is none, publish
 * when it has no upstream, pull when behind, push when ahead, fetch
 * otherwise -- so there is never a question of which of three buttons is
 * the right one.
 */
export function GitToolbar({
  status,
  branches,
  busy,
  onCheckout,
  onCreateBranch,
  onFetch,
  onPull,
  onPush,
  onAddRemote,
  review,
  projectRepo,
  inSession = false,
  sessionBranch = null,
  defaultBranch = null,
}: {
  status: GitStatus
  branches: GitBranchList | null
  busy: string | null
  onCheckout(branch: string, remote: boolean): void
  onCreateBranch(name: string): void
  onFetch(unshallow?: boolean): void
  onPull(): void
  onPush(): void
  onAddRemote(): void
  /** OMP's code review (OM7.8): of the working tree, or of the branch since `base`. */
  review?: { running: boolean; base: string | null; onReview(scope: "uncommitted" | "branch"): void }
  /** In a session: the branch the project's own repository is on. */
  projectRepo?: ProjectRepoBranch | null
  /** The view is of a session's worktree rather than the project's checkout. */
  inSession?: boolean
  /** In a session: its own branch, `ucch/{hash}`, offered apart from the project's. */
  sessionBranch?: string | null
  /** The project's default (production) branch, from its settings. */
  defaultBranch?: string | null
}) {
  const sync = syncAction(status)
  return (
    <div className="flex items-stretch gap-px border-b bg-muted/40">
      <BranchMenu
        status={status}
        branches={branches}
        disabled={busy !== null}
        inSession={inSession}
        sessionBranch={sessionBranch}
        defaultBranch={defaultBranch}
        onCheckout={onCheckout}
        onCreate={onCreateBranch}
      />
      {projectRepo && (
        <>
          <div className="bg-border w-px" />
          <ProjectRepoSegment repo={projectRepo} defaultBranch={defaultBranch} />
        </>
      )}
      <div className="bg-border w-px" />
      <ToolbarButton
        icon={busy === sync.busyLabel ? <Loader2Icon className="animate-spin" /> : sync.icon}
        title={sync.title}
        subtitle={sync.subtitle(status)}
        disabled={busy !== null || sync.disabled}
        onClick={() => {
          if (sync.kind === "publish" || sync.kind === "push") onPush()
          else if (sync.kind === "pull") onPull()
          else if (sync.kind === "add-remote") onAddRemote()
          else onFetch()
        }}
        trailing={
          <>
            {status.behind > 0 && (
              <Count icon={<ArrowDownIcon className="size-3" />} n={status.behind} />
            )}
            {status.ahead > 0 && <Count icon={<ArrowUpIcon className="size-3" />} n={status.ahead} />}
          </>
        }
      />
      {review && (
        <>
          <div className="bg-border w-px" />
          <ReviewMenu status={status} review={review} />
        </>
      )}
      {status.isShallow && status.hasRemote && (
        <>
          <div className="bg-border w-px" />
          <ToolbarButton
            icon={busy === "Fetch full history" ? <Loader2Icon className="animate-spin" /> : <HistoryIcon />}
            title="Fetch full history"
            subtitle="This clone is shallow"
            disabled={busy !== null}
            onClick={() => onFetch(true)}
          />
        </>
      )}
    </div>
  )
}

/**
 * The project repository's default branch (Project Settings), beside a
 * session's: where the session's work lands once it is settled. Falls back
 * to the branch the main checkout is on when no default is set. Read-only --
 * switching it from here would move it under every other session.
 */
function ProjectRepoSegment({ repo, defaultBranch }: { repo: ProjectRepoBranch; defaultBranch: string | null }) {
  const checkedOut = repo.detached ? "Detached HEAD" : (repo.branch ?? "No branch")
  const label = defaultBranch ?? checkedOut
  const subtitle =
    defaultBranch && repo.branch !== defaultBranch ? `Project repo · checkout on ${checkedOut}` : "Project repo"
  return (
    <div
      data-testid="project-repo-branch"
      title={
        defaultBranch
          ? `The project's default branch is ${defaultBranch}; its repository is on ${checkedOut}`
          : `The project's repository is on ${checkedOut}`
      }
      className="flex h-12 min-w-0 flex-1 items-center gap-3 px-3 sm:min-w-44 sm:flex-initial"
    >
      <span className="text-muted-foreground [&_svg]:size-4">
        <FolderGit2Icon />
      </span>
      <span className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate text-sm font-medium">{label}</span>
        <span className="text-muted-foreground truncate text-xs">{repo.unborn ? "Project repo · no commits yet" : subtitle}</span>
      </span>
    </div>
  )
}

/** What to review: the uncommitted changes, or the branch since it left its base. */
function ReviewMenu({ status, review }: { status: GitStatus; review: NonNullable<Parameters<typeof GitToolbar>[0]["review"]> }) {
  const onBase = !!review.base && status.branch === review.base
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <ToolbarButton
            data-testid="review-menu"
            icon={review.running ? <Loader2Icon className="animate-spin" /> : <ShieldCheckIcon />}
            title={review.running ? "Reviewing…" : "Review"}
            subtitle="OMP's reviewer reads the diff"
            disabled={review.running || status.unborn}
            trailing={<ChevronDownIcon className="text-muted-foreground size-3.5" />}
          />
        }
      />
      <DropdownMenuContent align="start" className="w-64">
        <DropdownMenuItem disabled={status.files.length === 0} onClick={() => review.onReview("uncommitted")}>
          <div className="grid leading-tight">
            <span>Review changes</span>
            <span className="text-muted-foreground text-xs">
              {status.files.length === 0 ? "Nothing uncommitted" : `${status.files.length} changed ${status.files.length === 1 ? "file" : "files"}`}
            </span>
          </div>
        </DropdownMenuItem>
        <DropdownMenuItem disabled={!review.base || onBase} onClick={() => review.onReview("branch")}>
          <div className="grid leading-tight">
            <span>Review branch</span>
            <span className="text-muted-foreground text-xs">
              {!review.base ? "No base branch to compare with" : onBase ? `This is ${review.base} itself` : `Since it left ${review.base}`}
            </span>
          </div>
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type SyncKind = "fetch" | "pull" | "push" | "publish" | "add-remote" | "none"

function syncAction(status: GitStatus): {
  kind: SyncKind
  title: string
  busyLabel: string
  icon: React.ReactNode
  disabled: boolean
  subtitle(status: GitStatus): string
} {
  const fetched = (s: GitStatus) => (s.lastFetchedAt ? `Last fetched ${relativeTime(s.lastFetchedAt)}` : "Never fetched")
  if (!status.hasRemote) {
    return { kind: "add-remote", title: "Add remote", busyLabel: "Connect remote", icon: <CloudUploadIcon />, disabled: false, subtitle: () => "Connect a repository to push to" }
  }
  if (status.mergeInProgress || status.rebaseInProgress) {
    return { kind: "none", title: "Resolve conflicts", busyLabel: "", icon: <RefreshCwIcon />, disabled: true, subtitle: () => "Finish the merge first" }
  }
  if (status.detached) {
    return { kind: "fetch", title: "Fetch origin", busyLabel: "Fetch", icon: <RefreshCwIcon />, disabled: false, subtitle: fetched }
  }
  if (!status.upstream && !status.unborn) {
    return { kind: "publish", title: "Publish branch", busyLabel: "Push", icon: <CloudUploadIcon />, disabled: false, subtitle: () => `Push ${status.branch ?? "this branch"} to origin` }
  }
  if (status.behind > 0) {
    return { kind: "pull", title: "Pull origin", busyLabel: "Pull", icon: <ArrowDownIcon />, disabled: false, subtitle: fetched }
  }
  if (status.ahead > 0) {
    return { kind: "push", title: "Push origin", busyLabel: "Push", icon: <ArrowUpIcon />, disabled: false, subtitle: fetched }
  }
  return { kind: "fetch", title: "Fetch origin", busyLabel: "Fetch", icon: <RefreshCwIcon />, disabled: status.unborn, subtitle: fetched }
}

function ToolbarButton({
  icon,
  title,
  subtitle,
  trailing,
  className,
  ...props
}: {
  icon: React.ReactNode
  title: string
  subtitle: string
  trailing?: React.ReactNode
} & Omit<React.ComponentProps<typeof Button>, "title" | "children">) {
  // The rest is spread so a `PopoverTrigger render={<ToolbarButton />}`
  // reaches the button with its own handlers and aria state.
  return (
    <Button
      variant="ghost"
      size="lg"
      {...props}
      className={cn("h-12 min-w-0 flex-1 justify-start gap-3 rounded-none px-3 sm:min-w-44 sm:flex-initial", className)}
    >
      <span className="text-muted-foreground [&_svg]:size-4">{icon}</span>
      <span className="grid min-w-0 flex-1 text-left leading-tight">
        <span className="truncate text-sm font-medium">{title}</span>
        <span className="text-muted-foreground truncate text-xs font-normal">{subtitle}</span>
      </span>
      {trailing}
    </Button>
  )
}

function Count({ icon, n }: { icon: React.ReactNode; n: number }) {
  return (
    <span className="text-muted-foreground bg-background inline-flex items-center gap-0.5 rounded border px-1 text-[0.7rem] tabular-nums">
      {icon}
      {n}
    </span>
  )
}

/**
 * The branch picker: a searchable list of local then remote branches, with
 * a way to start a new one from whatever was typed.
 */
function BranchMenu({
  status,
  branches,
  disabled,
  inSession,
  sessionBranch,
  defaultBranch,
  onCheckout,
  onCreate,
}: {
  status: GitStatus
  branches: GitBranchList | null
  disabled: boolean
  inSession: boolean
  sessionBranch: string | null
  defaultBranch: string | null
  onCheckout(branch: string, remote: boolean): void
  onCreate(name: string): void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  // The server leaves sessions' branches out; a list it answered before
  // that still could hold them, so they are left out here as well.
  const local = (branches?.local ?? []).filter((b) => !isSessionBranch(b.name))
  const localNames = new Set(local.map((b) => b.name))
  // A remote branch that already has a local one is reached through the local.
  const remote = (branches?.remote ?? []).filter(
    (b) => !isSessionBranch(b.name, true) && !localNames.has(b.name.replace(/^[^/]+\//, "")),
  )
  const trimmed = query.trim()
  // `ucch/` is the harness's: a branch made by hand there would pass for a session's.
  const reserved = isReservedBranchName(trimmed)
  const canCreate =
    trimmed.length > 0 && !reserved && !localNames.has(trimmed) && /^[^\s~^:?*[\\]+$/.test(trimmed) && !trimmed.startsWith("-")
  const isDefault = (name: string, remote: boolean) =>
    !!defaultBranch && (remote ? name.replace(/^[^/]+\//, "") : name) === defaultBranch
  // The session's own branch, apart from the project's: shown, never listed
  // among them, and picked only to come back to it from elsewhere.
  const ownBranch = inSession ? (sessionBranch ?? (branches?.currentIsSession ? branches.current : null)) : null
  const onOwnBranch = !!ownBranch && status.branch === ownBranch

  const label = status.detached ? "Detached HEAD" : (status.branch ?? "No branch")
  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next)
        if (!next) setQuery("")
      }}
    >
      <PopoverTrigger
        render={
          <ToolbarButton
            icon={<GitBranchIcon />}
            title={label}
            subtitle={status.unborn ? "No commits yet" : inSession ? "Session branch" : "Current branch"}
            disabled={disabled}
            trailing={<ChevronDownIcon className="text-muted-foreground size-3.5" />}
          />
        }
      />
      <PopoverContent side="bottom" align="start" sideOffset={4} className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Filter or create a branch…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{canCreate || reserved ? "" : "No branch matches that."}</CommandEmpty>
            {reserved && (
              <p data-testid="reserved-branch-prefix" role="alert" className="text-destructive px-3 py-2 text-sm">
                “{SESSION_BRANCH_PREFIX.slice(0, -1)}” and names starting with “{SESSION_BRANCH_PREFIX}” are reserved for UCCH
                session branches.
              </p>
            )}
            {ownBranch && trimmed === "" && (
              <>
                <CommandGroup heading="Current session">
                  <CommandItem
                    value={`session ${ownBranch}`}
                    forceMount
                    disabled={onOwnBranch}
                    data-testid="current-session-branch"
                    onSelect={() => {
                      setOpen(false)
                      if (!onOwnBranch) onCheckout(ownBranch, false)
                    }}
                  >
                    <GitBranchIcon className={cn(onOwnBranch && "text-ucch-active")} />
                    <div className="grid min-w-0 flex-1 leading-tight">
                      <span className="truncate font-mono text-xs">{ownBranch}</span>
                      <span className="text-muted-foreground truncate text-xs">
                        {onOwnBranch ? "This session's branch" : "This session's branch · switch back"}
                      </span>
                    </div>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {canCreate && (
              <>
                <CommandGroup>
                  <CommandItem
                    value={`create ${trimmed}`}
                    forceMount
                    onSelect={() => {
                      setOpen(false)
                      onCreate(trimmed)
                    }}
                  >
                    <PlusIcon />
                    <span className="truncate">
                      Create branch <span className="font-medium">{trimmed}</span>
                    </span>
                  </CommandItem>
                </CommandGroup>
                <CommandSeparator />
              </>
            )}
            {local.length > 0 && (
              <CommandGroup heading="Branches">
                {local.map((branch) => (
                  <CommandItem
                    key={branch.name}
                    value={branch.name}
                    data-checked={branch.current}
                    onSelect={() => {
                      setOpen(false)
                      if (!branch.current) onCheckout(branch.name, false)
                    }}
                  >
                    <GitBranchIcon className={cn(branch.current && "text-ucch-active")} />
                    <div className="grid min-w-0 flex-1 leading-tight">
                      <span className="flex min-w-0 items-center gap-1.5">
                        <span className="truncate">{branch.name}</span>
                        {isDefault(branch.name, false) && <DefaultBadge />}
                      </span>
                      <span className="text-muted-foreground truncate text-xs">
                        {branch.upstream ? `tracks ${branch.upstream}` : "local only"} · {relativeTime(branch.date)}
                      </span>
                    </div>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
            {remote.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Remote branches">
                  {remote.map((branch) => (
                    <CommandItem
                      key={branch.name}
                      value={branch.name}
                      onSelect={() => {
                        setOpen(false)
                        onCheckout(branch.name, true)
                      }}
                    >
                      <CloudUploadIcon />
                      <div className="grid min-w-0 flex-1 leading-tight">
                        <span className="flex min-w-0 items-center gap-1.5">
                          <span className="truncate">{branch.name}</span>
                          {isDefault(branch.name, true) && <DefaultBadge />}
                        </span>
                        <span className="text-muted-foreground truncate text-xs">{relativeTime(branch.date)}</span>
                      </div>
                    </CommandItem>
                  ))}
                </CommandGroup>
              </>
            )}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

/** Marks the project's default (production) branch, as set in Project Settings. */
function DefaultBadge() {
  return (
    <span
      data-testid="default-branch-badge"
      title="The project's default branch: sessions settle into it"
      className="text-muted-foreground bg-background shrink-0 rounded border px-1 text-[0.65rem] leading-4"
    >
      default
    </span>
  )
}
