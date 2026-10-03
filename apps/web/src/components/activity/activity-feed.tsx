"use client"

import * as React from "react"
import { HistoryIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react"
import type { AuditEntry } from "@ucch/protocol"

import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import {
  fetchAccountActivity,
  fetchProjectActivity,
  matchesAction,
  upsertEntry,
  type ActivityQuery,
} from "@/lib/activity-api"
import { cn } from "@/lib/utils"
import { useProjectEvents, useRealtime } from "@/lib/realtime"
import type { Project } from "@/lib/session"
import { relativeTime } from "@/lib/stats-format"

export type ActivitySource = { kind: "project"; project: Project } | { kind: "account" }

/** The filter chips: an action prefix each, matched the way the server does. */
const PROJECT_FILTERS = [
  { label: "All", action: undefined },
  { label: "Chat", action: "chat" },
  { label: "Notes", action: "note" },
  { label: "Files", action: "file" },
  { label: "Timeline", action: "timeline" },
  { label: "Git", action: "git" },
  { label: "Keys", action: "key" },
  { label: "Project", action: "project" },
] as const

const ACCOUNT_FILTERS = [
  { label: "All", action: undefined },
  { label: "Account", action: "account" },
  { label: "Settings", action: "settings" },
  { label: "Databases", action: "database" },
] as const

const PAGE = 50

/**
 * Who changed what, newest first, growing as it happens.
 *
 * Each line is one change, or a run of saves to the same thing by the same
 * person folded together (shown with its count). A refused edit -- one
 * that lost to a change made elsewhere and was reverted -- is kept too,
 * marked, so a conflict is never silent after the fact either.
 */
export function ActivityFeed({ source }: { source: ActivitySource }) {
  const filters = source.kind === "project" ? PROJECT_FILTERS : ACCOUNT_FILTERS
  const [action, setAction] = React.useState<string | undefined>(undefined)
  const [user, setUser] = React.useState<string | undefined>(undefined)
  const [entries, setEntries] = React.useState<AuditEntry[] | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [more, setMore] = React.useState(false)
  const [loadingMore, setLoadingMore] = React.useState(false)
  // Re-renders the relative times; nothing else depends on it.
  const [now, setNow] = React.useState(() => Date.now())
  React.useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])

  const hash = source.kind === "project" ? source.project.hash : null
  const load = React.useCallback(
    (query: ActivityQuery) =>
      hash ? fetchProjectActivity(hash, query) : fetchAccountActivity(query),
    [hash],
  )

  React.useEffect(() => {
    let cancelled = false
    setEntries(null)
    setError(null)
    load({ action, user, limit: PAGE }).then(
      (loaded) => {
        if (cancelled) return
        setEntries(loaded)
        setMore(loaded.length === PAGE)
      },
      (e: unknown) => !cancelled && setError(e instanceof Error ? e.message : String(e)),
    )
    return () => {
      cancelled = true
    }
  }, [load, action, user])

  const loadMore = async () => {
    const last = entries?.at(-1)
    if (!last) return
    setLoadingMore(true)
    try {
      const older = await load({ action, user, limit: PAGE, before: last.id })
      setEntries((current) => [...(current ?? []), ...older.filter((e) => !current?.some((c) => c.id === e.id))])
      setMore(older.length === PAGE)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setLoadingMore(false)
    }
  }

  // Live: every change anyone makes, including this tab's own -- the log is
  // a record, not a notice, so there is no echo to skip.
  const take = (entry: AuditEntry) => {
    if (!matchesAction(entry, action) || (user && entry.userId !== user)) return
    setEntries((current) => (current ? upsertEntry(current, entry) : current))
  }
  useProjectEvents(source.kind === "project" ? source.project.id : null, (event) => {
    if (event.type === "audit.recorded") take(event.entry)
  })
  const { client } = useRealtime()
  const takeRef = React.useRef(take)
  takeRef.current = take
  React.useEffect(() => {
    if (!client || source.kind !== "account") return
    return client.onEvent(({ event }) => {
      if (event.type === "audit.recorded" && event.projectId === null) takeRef.current(event.entry)
    })
  }, [client, source.kind])

  // Who appears in what is loaded, to narrow to one person. Once projects
  // are shared this is the list of collaborators who have changed something.
  const actors = React.useMemo(() => {
    const seen = new Map<string, string>()
    for (const e of entries ?? []) if (e.userId) seen.set(e.userId, e.actor ?? "Someone")
    return [...seen]
  }, [entries])

  return (
    <div className={cn("flex min-h-0 flex-1 flex-col", source.kind === "account" && "rounded-lg border")}>
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <HistoryIcon className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">Activity</span>
        {source.kind === "account" && (
          <span className="text-muted-foreground text-xs">· changes to your account, outside any project</span>
        )}
      </div>

      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b px-4 py-2">
        {filters.map((f) => (
          <Button
            key={f.label}
            size="xs"
            variant={action === f.action ? "secondary" : "ghost"}
            onClick={() => setAction(f.action)}
          >
            {f.label}
          </Button>
        ))}
        {source.kind === "project" && (actors.length > 1 || user) && (
          <select
            aria-label="Only changes by"
            className="bg-background ml-auto h-7 rounded-md border px-2 text-xs"
            value={user ?? ""}
            onChange={(e) => setUser(e.target.value || undefined)}
          >
            <option value="">Everyone</option>
            {actors.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
        )}
      </div>

      {error && (
        <p role="alert" className="text-destructive border-b px-4 py-2 text-xs">
          {error}
        </p>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {entries === null ? (
          !error && <ActivitySkeletonRows />
        ) : entries.length === 0 ? (
          <div className="text-muted-foreground flex flex-col items-center justify-center gap-3 p-8 text-center text-sm">
            <HistoryIcon className="size-8 opacity-50" />
            <p className="max-w-sm">Nothing yet. Changes appear here as they are made, in every open window.</p>
          </div>
        ) : (
          <ol>
            {entries.map((entry) => (
              <ActivityRow key={entry.id} entry={entry} now={now} />
            ))}
          </ol>
        )}
        {entries && more && (
          <div className="flex justify-center p-3">
            <Button variant="outline" size="sm" onClick={() => void loadMore()} disabled={loadingMore}>
              {loadingMore && <Loader2Icon className="animate-spin" />}
              Load older
            </Button>
          </div>
        )}
      </div>
    </div>
  )
}

function ActivityRow({ entry, now }: { entry: AuditEntry; now: number }) {
  const conflict = entry.action.endsWith(".conflict")
  const added = entry.details.charsAdded
  const removed = entry.details.charsRemoved
  return (
    <li className="flex items-baseline gap-3 border-b px-4 py-2 text-sm">
      <span className="text-muted-foreground w-20 shrink-0 text-xs" title={new Date(entry.updatedAt).toLocaleString()}>
        {relativeTime(entry.updatedAt, now)}
      </span>
      <span className="min-w-0 flex-1">
        <span className="font-medium">{entry.actor ?? "Someone"}</span>{" "}
        <span className={cn(conflict && "text-destructive")}>
          {conflict && <TriangleAlertIcon className="mr-1 inline size-3.5 align-[-2px]" />}
          {entry.summary}
        </span>
        {entry.count > 1 && (
          <span className="text-muted-foreground ml-1.5 text-xs" title="Saves folded into this line">
            ×{entry.count}
          </span>
        )}
      </span>
      {typeof added === "number" && typeof removed === "number" && (added > 0 || removed > 0) && (
        <span className="shrink-0 font-mono text-xs">
          {added > 0 && <span className="text-emerald-600 dark:text-emerald-400">+{added}</span>}
          {added > 0 && removed > 0 && " "}
          {removed > 0 && <span className="text-destructive">−{removed}</span>}
        </span>
      )}
    </li>
  )
}

function ActivitySkeletonRows({ rows = 8 }: { rows?: number }) {
  return (
    <>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex h-10 items-center gap-3 border-b px-4">
          <Skeleton className="h-3 w-14" />
          <Skeleton className="h-3" style={{ width: `${30 + ((i * 13) % 35)}%` }} />
        </div>
      ))}
    </>
  )
}

/** The page's shape before the project has been looked up. */
export function ActivitySkeleton() {
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <Skeleton className="size-4 rounded-sm" />
        <Skeleton className="h-3 w-16" />
      </div>
      <div className="h-11 border-b" />
      <ActivitySkeletonRows />
    </div>
  )
}
