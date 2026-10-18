"use client"

import type { DatabaseConnectionSummary } from "@ucch/protocol"

import { DbProvider } from "@/components/database/db-context"
import { TablesColumn } from "@/components/database/tables-column"

/**
 * The frame every database view sits in: the view on the left, the tables
 * column on the right, the way phpMyAdmin keeps the table list beside
 * whatever you are looking at.
 *
 * The column is a flex sibling of the view rather than an overlay, so a
 * wide grid narrows beside it instead of running underneath. Both scroll
 * on their own; `min-h-0` on this row is what lets them.
 */
export function DatabaseShell({
  connection,
  db,
  children,
}: {
  connection: DatabaseConnectionSummary
  db: string
  children: React.ReactNode
}) {
  return (
    <DbProvider connection={connection} db={db}>
      <div className="flex min-h-0 flex-1">
        {/* A div, not <main>: this sits inside the app shell's <main> already. */}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-y-auto">{children}</div>
        <TablesColumn />
      </div>
    </DbProvider>
  )
}
