"use client"

import { DashboardSkeleton } from "@/components/page-skeletons"
import { usePendingPath } from "@/lib/view-transitions"

/**
 * The page inside the shell. While a switch to another workspace is on its
 * way, the old workspace's page gives way to the new dashboard's skeleton --
 * hidden rather than unmounted, so a navigation that fails brings it back.
 */
export function WorkspacePage({ children }: { children: React.ReactNode }) {
  const switching = usePendingPath() !== null
  return (
    <>
      <div className={switching ? "hidden" : "ucch-page-content contents"}>{children}</div>
      {switching && <DashboardSkeleton />}
    </>
  )
}
