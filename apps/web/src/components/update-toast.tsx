"use client"

import * as React from "react"
import { RefreshCwIcon, XIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { reportServerBuild, subscribeUpdate, takeUpdate, updateAvailable } from "@/lib/app-update"
import { useBootstrap } from "@/lib/queries/bootstrap"
import { useActiveWorkspace } from "@/lib/workspace-context"

/**
 * "New version available": shown when a newer build is out than this tab
 * runs (see `lib/app-update.ts` for how that is learnt), until the person
 * reloads or puts it off. Put off, it stays away for this tab's life -- the
 * next load is the new build anyway.
 */
export function UpdateToast() {
  const available = React.useSyncExternalStore(subscribeUpdate, updateAvailable, () => false)
  const [dismissed, setDismissed] = React.useState(false)

  // The bootstrap is refetched when the tab comes back; its build id is the
  // second witness, for a socket that never dropped.
  const buildId = useBootstrap(useActiveWorkspace()?.hash ?? null).data?.buildId
  React.useEffect(() => reportServerBuild(buildId), [buildId])

  if (!available || dismissed) return null
  return (
    <div
      role="status"
      className="bg-background text-foreground fixed bottom-4 left-1/2 z-[100] -translate-x-1/2 flex max-w-[calc(100vw-2rem)] items-center gap-3 rounded-md border py-2 pr-2 pl-3 text-sm shadow-lg"
    >
      <span>New version available</span>
      <Button size="sm" onClick={takeUpdate}>
        <RefreshCwIcon />
        Reload
      </Button>
      <Button size="icon-sm" variant="ghost" aria-label="Later" onClick={() => setDismissed(true)}>
        <XIcon />
      </Button>
    </div>
  )
}
