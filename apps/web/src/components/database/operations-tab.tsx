"use client"

import * as React from "react"
import type { TableDetail } from "@ucch/protocol"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { useDb } from "@/components/database/db-context"
import { RenameTableDialog } from "@/components/database/rename-table-dialog"
import { Button } from "@/components/ui/button"
import { dropTable, truncateTable } from "@/lib/database-api"
import { databaseHref } from "@/lib/sections"
import { useWorkspaceHash } from "@/lib/workspace-context"
import { useTransitionRouter } from "@/lib/view-transitions"

/** What can be done to the table as a whole: renamed, emptied, dropped. */
export function OperationsTab({ detail }: { detail: TableDetail }) {
  const { ref, connection, db, reloadTables } = useDb()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const [renaming, setRenaming] = React.useState(false)
  const [emptying, setEmptying] = React.useState(false)
  const [dropping, setDropping] = React.useState(false)
  const isView = detail.tableType === "view"

  return (
    <div className="flex max-w-2xl flex-col gap-3 p-4">
      <Operation
        title="Rename"
        description={`Give ${detail.name} a new name. Views, foreign keys and code that name it are not updated.`}
        action={<Button variant="outline" size="sm" onClick={() => setRenaming(true)} disabled={isView}>Rename</Button>}
      />
      <Operation
        title="Empty"
        description="Delete every row and keep the table. Faster than deleting rows one page at a time, and cannot be undone."
        action={<Button variant="outline" size="sm" onClick={() => setEmptying(true)} disabled={isView}>Empty table</Button>}
      />
      <Operation
        title="Drop"
        description={`Remove ${detail.name} and everything in it from the database.`}
        action={<Button variant="destructive" size="sm" onClick={() => setDropping(true)}>Drop {isView ? "view" : "table"}</Button>}
      />

      <RenameTableDialog table={detail.name} open={renaming} onOpenChange={setRenaming} follow />
      <ConfirmDialog
        open={emptying}
        onOpenChange={setEmptying}
        title={`Empty ${detail.name}?`}
        description="Every row is deleted; the table and its columns stay."
        confirmLabel="Empty table"
        onConfirm={async () => {
          await truncateTable(ref, detail.name)
          await reloadTables()
        }}
      />
      <ConfirmDialog
        open={dropping}
        onOpenChange={setDropping}
        title={`Drop ${detail.name}?`}
        description="The table and every row in it are gone for good."
        confirmLabel="Drop"
        typeToConfirm={detail.name}
        onConfirm={async () => {
          await dropTable(ref, detail.name)
          await reloadTables()
          router.replace(databaseHref(ws, connection.id, db))
        }}
      />
    </div>
  )
}

function Operation({ title, description, action }: { title: string; description: string; action: React.ReactNode }) {
  return (
    <div className="flex items-center gap-4 rounded-lg border p-4">
      <div className="min-w-0 flex-1">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="text-muted-foreground text-xs">{description}</p>
      </div>
      {action}
    </div>
  )
}
