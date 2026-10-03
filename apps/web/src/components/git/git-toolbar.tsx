"use client"

import * as React from "react"
import type { GitBranchList, GitStatus } from "@ucch/protocol"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronDownIcon,
  CloudUploadIcon,
  GitBranchIcon,
  HistoryIcon,
  Loader2Icon,
  PlusIcon,
  RefreshCwIcon,
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
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { relativeTime } from "@/lib/stats-format"
import { cn } from "@/lib/utils"

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
}) {
  const sync = syncAction(status)
  return (
    <div className="flex items-stretch gap-px border-b bg-muted/40">
      <BranchMenu status={status} branches={branches} disabled={busy !== null} onCheckout={onCheckout} onCreate={onCreateBranch} />
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
  onCheckout,
  onCreate,
}: {
  status: GitStatus
  branches: GitBranchList | null
  disabled: boolean
  onCheckout(branch: string, remote: boolean): void
  onCreate(name: string): void
}) {
  const [open, setOpen] = React.useState(false)
  const [query, setQuery] = React.useState("")
  const local = branches?.local ?? []
  const localNames = new Set(local.map((b) => b.name))
  // A remote branch that already has a local one is reached through the local.
  const remote = (branches?.remote ?? []).filter((b) => !localNames.has(b.name.replace(/^[^/]+\//, "")))
  const trimmed = query.trim()
  const canCreate = trimmed.length > 0 && !localNames.has(trimmed) && /^[^\s~^:?*[\\]+$/.test(trimmed) && !trimmed.startsWith("-")

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
            subtitle={status.unborn ? "No commits yet" : "Current branch"}
            disabled={disabled}
            trailing={<ChevronDownIcon className="text-muted-foreground size-3.5" />}
          />
        }
      />
      <PopoverContent side="bottom" align="start" sideOffset={4} className="w-80 p-0">
        <Command>
          <CommandInput placeholder="Filter or create a branch…" value={query} onValueChange={setQuery} />
          <CommandList>
            <CommandEmpty>{canCreate ? "" : "No branch matches that."}</CommandEmpty>
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
                      <span className="truncate">{branch.name}</span>
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
                        <span className="truncate">{branch.name}</span>
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
