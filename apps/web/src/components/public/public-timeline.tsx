"use client"

import * as React from "react"
import type { GitCommit, GitLogPage } from "@ucch/protocol"
import { GitCommitHorizontalIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchPublicLog } from "@/lib/public-api"
import { relativeTime } from "@/lib/stats-format"

/**
 * The project's history as a timeline: commits, newest first, grouped by
 * the day they were made.
 *
 * Read from git rather than from anything the harness records, because git
 * is the record -- every change the agent or the owner made that was worth
 * keeping is a commit, and a visitor who wants to know what happened to a
 * project is asking for exactly that list.
 */
export function PublicTimeline({ slug }: { slug: string }) {
  const [page, setPage] = React.useState<GitLogPage | null>(null)
  const [commits, setCommits] = React.useState<GitCommit[]>([])
  const [error, setError] = React.useState<string | null>(null)
  const [loading, setLoading] = React.useState(false)

  const load = React.useCallback(
    async (skip: number) => {
      setLoading(true)
      try {
        const next = await fetchPublicLog(slug, skip, 50)
        setPage(next)
        setCommits((prev) => (skip === 0 ? next.commits : [...prev, ...next.commits]))
      } catch (e) {
        setError(e instanceof Error ? e.message : "Could not load the history.")
      } finally {
        setLoading(false)
      }
    },
    [slug],
  )
  React.useEffect(() => {
    void load(0)
  }, [load])

  if (error) return <p className="text-muted-foreground p-8 text-sm">{error}</p>
  if (!page) {
    return (
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        {Array.from({ length: 6 }, (_, i) => (
          <div key={i} className="mb-5 flex gap-4">
            <Skeleton className="size-3 shrink-0 rounded-full" />
            <div className="flex-1">
              <Skeleton className="mb-2 h-3.5" style={{ width: `${45 + ((i * 23) % 40)}%` }} />
              <Skeleton className="h-3 w-32" />
            </div>
          </div>
        ))}
      </div>
    )
  }
  if (commits.length === 0) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-2 p-8 text-sm">
        <GitCommitHorizontalIcon className="size-8 opacity-40" />
        <p>Nothing has happened here yet.</p>
      </div>
    )
  }

  const days = groupByDay(commits)
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto w-full max-w-3xl px-8 py-10">
        <ol className="relative border-l pl-6">
          {days.map(([day, items]) => (
            <li key={day} className="mb-8 last:mb-0">
              <div className="bg-background text-muted-foreground sticky top-0 -ml-6 mb-3 flex items-center gap-3 py-1 text-xs font-medium">
                <span className="bg-border size-2.5 rounded-full ring-4 ring-background" />
                {day}
              </div>
              <ul className="flex flex-col gap-3">
                {items.map((commit) => (
                  <li key={commit.sha} className="relative">
                    <span className="bg-ucch-active absolute top-2 -left-[27px] size-1.5 rounded-full" />
                    <p className="text-sm font-medium">{commit.subject || "(no message)"}</p>
                    {commit.body && (
                      <p className="text-muted-foreground mt-0.5 line-clamp-3 text-xs whitespace-pre-wrap">{commit.body}</p>
                    )}
                    <p className="text-muted-foreground mt-1 flex items-center gap-2 text-xs">
                      <span>{commit.authorName}</span>
                      <span>·</span>
                      <span title={new Date(commit.date).toLocaleString()}>{relativeTime(commit.date)}</span>
                      <span>·</span>
                      <span className="font-mono">{commit.shortSha}</span>
                    </p>
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ol>
        {page.hasMore && (
          <div className="mt-6 flex justify-center">
            <Button variant="outline" size="sm" disabled={loading} onClick={() => void load(commits.length)}>
              {loading ? "Loading…" : "Show older"}
            </Button>
          </div>
        )}
        {page.isShallow && !page.hasMore && (
          <p className="text-muted-foreground mt-6 text-center text-xs">Older history is not available on this copy.</p>
        )}
      </div>
    </div>
  )
}

function groupByDay(commits: GitCommit[]): [string, GitCommit[]][] {
  const groups = new Map<string, GitCommit[]>()
  for (const commit of commits) {
    const day = new Date(commit.date).toLocaleDateString(undefined, { year: "numeric", month: "long", day: "numeric" })
    const list = groups.get(day)
    if (list) list.push(commit)
    else groups.set(day, [commit])
  }
  return [...groups.entries()]
}
