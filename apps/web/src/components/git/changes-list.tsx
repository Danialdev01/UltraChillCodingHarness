"use client"

import * as React from "react"
import type { GitFileStatus, GitResolveStrategy } from "@ucch/protocol"
import { AlertTriangleIcon, CheckIcon, ChevronRightIcon, MoreHorizontalIcon } from "lucide-react"

import { FileTypeIcon } from "@/components/file-type-icon"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { cn } from "@/lib/utils"

import { scopeFor, type GitSelection } from "./use-git-state"

/**
 * Every changed file, each with a checkbox that is its staged state.
 *
 * Checking stages, unchecking unstages, the header box does all of them --
 * the GitHub Desktop convention, where "what goes in the commit" and "what
 * is staged" are the same question. A conflicted file has no checkbox: it
 * gets resolved instead, and resolving stages it.
 */
export function ChangesList({
  files,
  truncated,
  selection,
  disabled,
  onSelect,
  onStage,
  onUnstage,
  onDiscard,
  onResolve,
  onOpen,
}: {
  files: GitFileStatus[]
  truncated: boolean
  selection: GitSelection | null
  disabled: boolean
  onSelect(selection: GitSelection): void
  onStage(paths: string[] | "all"): void
  onUnstage(paths: string[] | "all"): void
  onDiscard(paths: string[] | "all"): void
  onResolve(path: string, strategy: GitResolveStrategy): void
  onOpen(path: string): void
}) {
  const stageable = files.filter((f) => !f.conflicted)
  const staged = stageable.filter((f) => isStaged(f))
  const allStaged = stageable.length > 0 && staged.length === stageable.length
  const someStaged = staged.length > 0 && !allStaged
  const headerRef = React.useRef<HTMLInputElement>(null)
  React.useEffect(() => {
    if (headerRef.current) headerRef.current.indeterminate = someStaged
  }, [someStaged])

  if (files.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-sm">
        <CheckIcon className="size-6 opacity-40" />
        <p>No local changes</p>
        <p className="text-xs">Edits in the editor or by the agent show up here.</p>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <label className="flex items-center gap-2 border-b px-3 py-2 text-xs">
        <input
          ref={headerRef}
          type="checkbox"
          className="accent-ucch-active size-3.5"
          checked={allStaged}
          disabled={disabled || stageable.length === 0}
          onChange={() => (allStaged ? onUnstage("all") : onStage("all"))}
          aria-label={allStaged ? "Unstage all" : "Stage all"}
        />
        <span className="font-medium">
          {files.length} changed {files.length === 1 ? "file" : "files"}
        </span>
        {truncated && <span className="text-muted-foreground">(more not shown)</span>}
        <span className="text-muted-foreground ml-auto tabular-nums">{staged.length} staged</span>
      </label>
      <ul className="min-h-0 flex-1 overflow-y-auto py-1">
        {files.map((file) => (
          <ChangeRow
            key={file.path}
            file={file}
            selected={selection?.kind === "change" && selection.path === file.path}
            disabled={disabled}
            onSelect={() => onSelect({ kind: "change", path: file.path, scope: scopeFor(file) })}
            onToggle={() => (isStaged(file) ? onUnstage([file.path]) : onStage([file.path]))}
            onDiscard={() => onDiscard([file.path])}
            onResolve={(strategy) => onResolve(file.path, strategy)}
            onOpen={() => onOpen(file.path)}
          />
        ))}
      </ul>
    </div>
  )
}

/** Staged as far as the checkbox is concerned: some of it is in the index. */
function isStaged(file: GitFileStatus): boolean {
  return !file.untracked && file.index !== "."
}

function ChangeRow({
  file,
  selected,
  disabled,
  onSelect,
  onToggle,
  onDiscard,
  onResolve,
  onOpen,
}: {
  file: GitFileStatus
  selected: boolean
  disabled: boolean
  onSelect(): void
  onToggle(): void
  onDiscard(): void
  onResolve(strategy: GitResolveStrategy): void
  onOpen(): void
}) {
  const slash = file.path.lastIndexOf("/")
  const dir = slash >= 0 ? file.path.slice(0, slash + 1) : ""
  const name = file.path.slice(slash + 1)
  const partial = isStaged(file) && file.worktree !== "."
  return (
    <li
      className={cn(
        "group/row flex items-center gap-2 px-3 py-1 text-xs",
        selected ? "bg-ucch-active-bg" : "hover:bg-muted/60",
      )}
    >
      {file.conflicted ? (
        <AlertTriangleIcon className="size-3.5 shrink-0 text-warning" aria-label="Conflicted" />
      ) : (
        <input
          type="checkbox"
          className="accent-ucch-active size-3.5 shrink-0"
          checked={isStaged(file)}
          disabled={disabled}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          aria-label={isStaged(file) ? `Unstage ${file.path}` : `Stage ${file.path}`}
          title={partial ? "Partly staged: some edits are not in the index yet" : undefined}
        />
      )}
      <button
        type="button"
        onClick={onSelect}
        className="flex min-w-0 flex-1 items-center gap-1.5 text-left"
        aria-current={selected || undefined}
      >
        <FileTypeIcon name={name} kind="file" className="size-3.5 shrink-0" />
        <span className="truncate">
          {dir && <span className="text-muted-foreground">{dir}</span>}
          {name}
          {file.origPath && <span className="text-muted-foreground"> ← {file.origPath}</span>}
        </span>
        {partial && <span className="text-muted-foreground" title="Partly staged">◐</span>}
      </button>
      <StatusBadge file={file} />
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <button
              type="button"
              className="text-muted-foreground hover:text-foreground rounded p-0.5 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 data-open:opacity-100"
              aria-label={`Actions for ${file.path}`}
              disabled={disabled}
            />
          }
        >
          <MoreHorizontalIcon className="size-3.5" />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {file.conflicted && (
            <>
              <DropdownMenuItem onClick={() => onResolve("ours")}>Use ours (current branch)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onResolve("theirs")}>Use theirs (incoming)</DropdownMenuItem>
              <DropdownMenuItem onClick={() => onResolve("mark")}>Mark as resolved</DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
          {file.worktree !== "D" && file.index !== "D" && (
            <DropdownMenuItem onClick={onOpen}>
              Open in editor <ChevronRightIcon className="ml-auto size-3" />
            </DropdownMenuItem>
          )}
          <DropdownMenuItem onClick={() => void navigator.clipboard?.writeText(file.path)}>Copy path</DropdownMenuItem>
          {!file.conflicted && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem variant="destructive" onClick={onDiscard}>
                {file.untracked || file.index === "A" ? "Delete file" : "Discard changes"}
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}

/** One letter for what happened, coloured the way every git UI colours it. */
export function StatusBadge({ file }: { file: Pick<GitFileStatus, "index" | "worktree" | "untracked" | "conflicted"> }) {
  const letter = file.conflicted
    ? "!"
    : file.untracked
      ? "U"
      : file.worktree !== "."
        ? file.worktree
        : file.index
  const tone =
    letter === "A" || letter === "U"
      ? "var(--success)"
      : letter === "D"
        ? "var(--danger)"
        : letter === "R" || letter === "C"
          ? "var(--info)"
          : "var(--warning)"
  const LABELS: Record<string, string> = { A: "Added", M: "Modified", D: "Deleted", R: "Renamed", C: "Copied", T: "Type changed", U: "Untracked", "!": "Conflicted" }
  const label = LABELS[letter] ?? letter
  return (
    <span
      className="inline-flex size-4 shrink-0 items-center justify-center rounded border text-[0.65rem] font-semibold"
      style={{ color: tone, borderColor: `color-mix(in oklch, ${tone} 50%, transparent)` }}
      title={label}
      aria-label={label}
    >
      {letter}
    </span>
  )
}
