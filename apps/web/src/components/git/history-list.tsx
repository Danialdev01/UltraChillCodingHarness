"use client"

import type { GitCommit, GitLogPage } from "@ucch/protocol"
import { HistoryIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { relativeTime } from "@/lib/stats-format"
import { cn } from "@/lib/utils"

/**
 * The commits on this branch, newest first.
 *
 * A shallow clone shows what it has and says so: the footer offers the rest,
 * since `--depth 1` is how projects arrive here and one commit of history is
 * rarely what someone opened this tab for.
 */
export function HistoryList({
  commits,
  page,
  selectedSha,
  onSelect,
  onLoadMore,
  onUnshallow,
  busy,
}: {
  commits: GitCommit[]
  page: GitLogPage | null
  selectedSha: string | null
  onSelect(sha: string): void
  onLoadMore(): void
  onUnshallow(): void
  busy: boolean
}) {
  if (commits.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-1 p-6 text-center text-sm">
        <HistoryIcon className="size-6 opacity-40" />
        <p>No commits yet</p>
      </div>
    )
  }
  return (
    <ul className="min-h-0 flex-1 overflow-y-auto py-1">
      {commits.map((commit) => {
        const selected = commit.sha === selectedSha
        return (
          <li key={commit.sha}>
            <button
              type="button"
              onClick={() => onSelect(commit.sha)}
              aria-current={selected || undefined}
              className={cn(
                "flex w-full flex-col gap-0.5 px-3 py-1.5 text-left text-xs",
                selected ? "bg-ucch-active-bg" : "hover:bg-muted/60",
              )}
            >
              <span className="truncate font-medium">{commit.subject || "(no message)"}</span>
              <span className="text-muted-foreground flex items-center gap-1.5 truncate">
                <span className="truncate">{commit.authorName}</span>
                <span>·</span>
                <span className="shrink-0">{relativeTime(commit.date)}</span>
                <span className="ml-auto shrink-0 font-mono">{commit.shortSha}</span>
                {commit.parents.length > 1 && <span className="shrink-0" title="Merge commit">⑂</span>}
              </span>
            </button>
          </li>
        )
      })}
      {page?.hasMore && (
        <li className="p-2">
          <Button variant="ghost" size="sm" className="w-full" onClick={onLoadMore} disabled={busy}>
            Load more
          </Button>
        </li>
      )}
      {page?.isShallow && (
        <li className="text-muted-foreground border-t p-3 text-center text-xs">
          <p>History is shallow: only what the clone brought.</p>
          <Button variant="link" size="sm" className="h-auto p-0 text-xs" onClick={onUnshallow} disabled={busy}>
            Fetch full history
          </Button>
        </li>
      )}
    </ul>
  )
}
