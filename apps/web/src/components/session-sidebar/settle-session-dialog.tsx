"use client"

import * as React from "react"
import { ArrowRightIcon, GitMergeIcon, Loader2Icon, TriangleAlertIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchSettleCheck, SettleConflictError, type SettleCheck } from "@/lib/project-sessions"
import type { SidebarSession } from "@/lib/session-sidebar"

type Check = { state: "loading" } | { state: "ready"; check: SettleCheck } | { state: "unknown" }

/**
 * Settling a project session: its work committed and merged into the
 * project's base branch, then its worktree removed.
 *
 * The dialog names both ends -- `ucch/{hash} → base` -- so it is plain which
 * repository and which branch the work lands in. A conflict aborts the
 * merge on the server and comes back here as the list of files, with the
 * session left as it was. "Don't commit" drops the changes with the
 * worktree and branch instead.
 */
export function SettleSessionDialog({
  session,
  onOpenChange,
  onSettle,
  onDiscard,
}: {
  session: SidebarSession | null
  onOpenChange(open: boolean): void
  onSettle(session: SidebarSession): Promise<void>
  onDiscard(session: SidebarSession): Promise<void>
}) {
  const [check, setCheck] = React.useState<Check>({ state: "loading" })
  const [pending, setPending] = React.useState<"settle" | "discard" | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [conflicts, setConflicts] = React.useState<string[] | null>(null)

  const projectHash = session?.project.hash
  const sessionHash = session?.hash

  const refresh = React.useCallback(async () => {
    if (!projectHash || !sessionHash) return
    setCheck({ state: "loading" })
    try {
      setCheck({ state: "ready", check: await fetchSettleCheck(projectHash, sessionHash) })
    } catch {
      // Unknown: offer both, and let the server say why if settling fails.
      setCheck({ state: "unknown" })
    }
  }, [projectHash, sessionHash])

  React.useEffect(() => {
    if (!session) {
      setPending(null)
      setError(null)
      setConflicts(null)
      return
    }
    void refresh()
  }, [session, refresh])

  async function run(kind: "settle" | "discard") {
    if (!session) return
    setPending(kind)
    setError(null)
    setConflicts(null)
    try {
      await (kind === "settle" ? onSettle(session) : onDiscard(session))
      onOpenChange(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.")
      if (caught instanceof SettleConflictError) setConflicts(caught.conflicts)
    } finally {
      setPending(null)
    }
  }

  const ready = check.state === "ready" ? check.check : null
  const changes = ready ? ready.changes : check.state === "unknown"
  const busy = pending !== null || check.state === "loading" || ready?.running === true
  const branch = ready?.branch ?? session?.branch ?? null
  const base = ready?.baseBranch ?? session?.project.baseBranch ?? session?.baseBranch ?? null

  const description =
    check.state === "loading"
      ? null
      : !branch
        ? "This session works in the project's own checkout, so there is nothing to merge: the session is just removed."
        : ready && !ready.changes
          ? `It has no changes of its own, so there is nothing to merge into ${base ?? "the base branch"}. Its worktree is removed.`
          : `Uncommitted changes are committed, then the session's branch is merged into ${base ?? "the base branch"} and its worktree removed. If the merge conflicts it is aborted and nothing changes.`

  return (
    <Dialog open={session !== null} onOpenChange={(next) => pending === null && !next && onOpenChange(false)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Settle ${(session?.title ?? "session").replace(/\?+$/, "")}?`}</DialogTitle>
          <DialogDescription render={<div />}>
            {description ?? (
              <span className="flex flex-col gap-1.5" aria-busy="true">
                <Skeleton className="h-3.5 w-full" />
                <Skeleton className="h-3.5 w-2/3" />
              </span>
            )}
          </DialogDescription>
        </DialogHeader>
        {branch && (
          <div className="bg-muted/50 flex min-w-0 flex-col gap-1 rounded-md px-3 py-2 text-xs">
            <span className="text-muted-foreground truncate">
              {session?.project.name}
              {session?.project.repo ? ` · ${session.project.repo}` : " · local repository"}
            </span>
            <span className="flex min-w-0 items-center gap-1.5 font-mono">
              <GitMergeIcon className="text-muted-foreground size-3.5 shrink-0" aria-hidden />
              <span className="truncate">{branch}</span>
              <ArrowRightIcon className="text-muted-foreground size-3 shrink-0" aria-label="into" />
              <span className="truncate font-medium">{base ?? "…"}</span>
            </span>
          </div>
        )}
        {ready?.running && (
          <p className="text-muted-foreground text-sm">The agent is still working in this session. Stop it first.</p>
        )}
        {error && (
          <div role="alert" className="text-destructive flex flex-col gap-1 text-sm">
            <p className="flex items-start gap-1.5">
              <TriangleAlertIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              {error}
            </p>
            {conflicts && conflicts.length > 0 && (
              <ul className="text-muted-foreground max-h-32 overflow-y-auto pl-5 font-mono text-xs">
                {conflicts.map((path) => (
                  <li key={path} className="truncate">
                    {path}
                  </li>
                ))}
              </ul>
            )}
            {conflicts && (
              <p className="text-muted-foreground text-xs">
                The merge was aborted; {base ?? "the base branch"} is unchanged. Resolve it in the session (merge{" "}
                {base ?? "the base"} into its branch), then settle again.
              </p>
            )}
          </div>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" disabled={pending !== null} />}>
            Cancel
          </DialogClose>
          {changes && (
            <Button
              type="button"
              variant="outline"
              className="text-destructive hover:text-destructive"
              disabled={busy}
              onClick={() => void run("discard")}
            >
              {pending === "discard" && <Loader2Icon className="animate-spin" />}
              Don&apos;t commit
            </Button>
          )}
          <Button type="button" disabled={busy} onClick={() => void run("settle")}>
            {pending === "settle" && <Loader2Icon className="animate-spin" />}
            {branch && changes ? `Merge into ${base ?? "base"}` : "Settle"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
