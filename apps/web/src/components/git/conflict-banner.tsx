"use client"

import * as React from "react"
import { AlertTriangleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"

/**
 * Shown while a merge is waiting on someone.
 *
 * Every conflicted file gets resolved from its row; this is the summary and
 * the way out. Aborting asks first, because it throws away the merge and
 * anything resolved so far.
 */
export function ConflictBanner({
  unresolved,
  rebase,
  busy,
  onAbort,
}: {
  unresolved: number
  rebase: boolean
  busy: boolean
  onAbort(): void
}) {
  const [confirming, setConfirming] = React.useState(false)
  const what = rebase ? "rebase" : "merge"
  return (
    <div className="flex items-center gap-2 border-b bg-[color-mix(in_oklch,var(--ucch-note-orange)_15%,transparent)] px-3 py-2 text-xs">
      <AlertTriangleIcon className="size-4 shrink-0 text-[var(--ucch-note-orange)]" />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {unresolved > 0
            ? `${unresolved} conflicted ${unresolved === 1 ? "file" : "files"} to resolve`
            : `All conflicts resolved`}
        </p>
        <p className="text-muted-foreground truncate">
          {unresolved > 0
            ? `Pick "Use ours", "Use theirs" or edit the file and mark it resolved, then commit to finish the ${what}.`
            : `Commit to finish the ${what}.`}
        </p>
      </div>
      <Button variant="outline" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
        Abort {what}
      </Button>
      <Dialog open={confirming} onOpenChange={setConfirming}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Abort the {what}?</DialogTitle>
            <DialogDescription>
              The working tree goes back to how it was before the {what} started. Anything resolved so far is lost.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirming(false)}>
              Keep going
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                setConfirming(false)
                onAbort()
              }}
            >
              Abort {what}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}
