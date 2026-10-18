"use client"

import * as React from "react"
import { EraserIcon, EyeIcon, ListTreeIcon, MoreHorizontalIcon, PencilIcon, PlusIcon, RefreshCwIcon, TableIcon, Trash2Icon } from "lucide-react"
import type { TableSummary } from "@ucch/protocol"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { CreateTableDialog } from "@/components/database/create-table-dialog"
import { useDb } from "@/components/database/db-context"
import { RenameTableDialog } from "@/components/database/rename-table-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { dropTable, truncateTable } from "@/lib/database-api"
import { compactNumber, formatBytes } from "@/lib/stats-format"
import { databaseHref } from "@/lib/sections"
import { useWorkspaceHash } from "@/lib/workspace-context"
import { TransitionLink } from "@/lib/view-transitions"

/**
 * The database's tables as a table: what phpMyAdmin's Structure tab shows
 * for a database. The same list the column at the right draws, with room
 * here for the size and the comment, and for the actions a row offers.
 */
export function StructureTab() {
  const ws = useWorkspaceHash()
  const { ref, connection, db, tables, reloadTables } = useDb()
  const [creating, setCreating] = React.useState(false)
  const [renaming, setRenaming] = React.useState<TableSummary | null>(null)
  const [dropping, setDropping] = React.useState<TableSummary | null>(null)
  const [emptying, setEmptying] = React.useState<TableSummary | null>(null)

  const totals = React.useMemo(() => {
    if (tables.state !== "loaded") return null
    return {
      count: tables.data.length,
      rows: tables.data.reduce((sum, t) => sum + (t.rowEstimate ?? 0), 0),
      bytes: tables.data.reduce((sum, t) => sum + (t.sizeBytes ?? 0), 0),
    }
  }, [tables])

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">Tables</h2>
        {totals && (
          <span className="text-muted-foreground text-xs">
            {totals.count} · ~{compactNumber(totals.rows)} rows · {formatBytes(totals.bytes)}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => void reloadTables()} title="Refresh">
            <RefreshCwIcon />
            <span className="sr-only">Refresh</span>
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon />
            New table
          </Button>
        </div>
      </div>

      {tables.state === "loading" ? (
        <div className="rounded-lg border">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b px-3 py-2.5 last:border-b-0">
              <Skeleton className="h-3" style={{ width: `${20 + ((i * 17) % 30)}%` }} />
              <Skeleton className="ml-auto h-3 w-16" />
            </div>
          ))}
        </div>
      ) : tables.state === "failed" ? (
        <p role="alert" className="text-destructive text-sm">
          {tables.error}
        </p>
      ) : tables.data.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border p-6 text-center text-sm">This database has no tables yet.</p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Table</TableHead>
                <TableHead className="text-right">Rows</TableHead>
                <TableHead className="text-right">Size</TableHead>
                <TableHead>Comment</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tables.data.map((table) => {
                const href = databaseHref(ws, connection.id, db, table.name)
                const Icon = table.tableType === "view" ? EyeIcon : TableIcon
                return (
                  <TableRow key={table.name}>
                    <TableCell className="font-medium">
                      <TransitionLink href={href} className="flex items-center gap-2 hover:underline">
                        <Icon className="text-muted-foreground size-3.5" />
                        {table.name}
                        {table.tableType === "view" && <span className="text-muted-foreground text-xs font-normal">view</span>}
                      </TransitionLink>
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {table.rowEstimate === null ? <span className="text-muted-foreground">—</span> : `~${compactNumber(table.rowEstimate)}`}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {table.sizeBytes === null ? <span className="text-muted-foreground">—</span> : formatBytes(table.sizeBytes)}
                    </TableCell>
                    <TableCell className="text-muted-foreground max-w-64 truncate">{table.comment}</TableCell>
                    <TableCell className="py-1">
                      <DropdownMenu>
                        <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" />}>
                          <MoreHorizontalIcon />
                          <span className="sr-only">More for {table.name}</span>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent className="w-44" align="end">
                          <DropdownMenuItem render={<TransitionLink href={`${href}?tab=data`} />}>
                            <TableIcon className="text-muted-foreground" />
                            Browse
                          </DropdownMenuItem>
                          <DropdownMenuItem render={<TransitionLink href={`${href}?tab=structure`} />}>
                            <ListTreeIcon className="text-muted-foreground" />
                            Structure
                          </DropdownMenuItem>
                          {table.tableType === "table" && (
                            <>
                              <DropdownMenuSeparator />
                              <DropdownMenuItem onClick={() => setRenaming(table)}>
                                <PencilIcon className="text-muted-foreground" />
                                Rename
                              </DropdownMenuItem>
                              <DropdownMenuItem onClick={() => setEmptying(table)}>
                                <EraserIcon className="text-muted-foreground" />
                                Empty
                              </DropdownMenuItem>
                              <DropdownMenuItem variant="destructive" onClick={() => setDropping(table)}>
                                <Trash2Icon />
                                Drop
                              </DropdownMenuItem>
                            </>
                          )}
                        </DropdownMenuContent>
                      </DropdownMenu>
                    </TableCell>
                  </TableRow>
                )
              })}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateTableDialog open={creating} onOpenChange={setCreating} />
      {renaming && <RenameTableDialog table={renaming.name} open onOpenChange={(open) => !open && setRenaming(null)} />}
      <ConfirmDialog
        open={dropping !== null}
        onOpenChange={(open) => !open && setDropping(null)}
        title={`Drop ${dropping?.name ?? "table"}?`}
        description="The table and every row in it are gone for good."
        confirmLabel="Drop table"
        typeToConfirm={dropping?.name}
        onConfirm={async () => {
          if (!dropping) return
          await dropTable(ref, dropping.name)
          await reloadTables()
        }}
      />
      <ConfirmDialog
        open={emptying !== null}
        onOpenChange={(open) => !open && setEmptying(null)}
        title={`Empty ${emptying?.name ?? "table"}?`}
        description="Every row is deleted; the table and its columns stay."
        confirmLabel="Empty table"
        onConfirm={async () => {
          if (!emptying) return
          await truncateTable(ref, emptying.name)
          await reloadTables()
        }}
      />
    </div>
  )
}
