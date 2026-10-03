"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import {
  CylinderIcon,
  EraserIcon,
  EyeIcon,
  ListTreeIcon,
  MoreHorizontalIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  TableIcon,
  Trash2Icon,
} from "lucide-react"
import type { TableSummary } from "@ucch/protocol"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { CreateTableDialog } from "@/components/database/create-table-dialog"
import { useDb } from "@/components/database/db-context"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Skeleton } from "@/components/ui/skeleton"
import { dropTable, truncateTable } from "@/lib/database-api"
import { compactNumber } from "@/lib/stats-format"
import { databaseHref, databasePathFromPath } from "@/lib/sections"
import { cn } from "@/lib/utils"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"

/**
 * The column at the right: every table in the open database, the one the
 * URL is on lit, and a way to add another.
 *
 * Hidden below `md`, where the view already takes the whole width; there
 * the Structure tab lists the same tables. The list itself comes from the
 * provider, so a table made or dropped from any view shows up here too.
 */
export function TablesColumn() {
  const { db, connection, tables, reloadTables } = useDb()
  const pathname = usePathname()
  const router = useTransitionRouter()
  const current = databasePathFromPath(pathname)?.table ?? null
  const [filter, setFilter] = React.useState("")
  const [creating, setCreating] = React.useState(false)
  const [dropping, setDropping] = React.useState<TableSummary | null>(null)
  const [emptying, setEmptying] = React.useState<TableSummary | null>(null)

  const shown = React.useMemo(() => {
    if (tables.state !== "loaded") return []
    const needle = filter.trim().toLowerCase()
    return needle ? tables.data.filter((t) => t.name.toLowerCase().includes(needle)) : tables.data
  }, [tables, filter])

  async function drop(table: TableSummary) {
    await dropTable({ connectionId: connection.id, db }, table.name)
    if (current === table.name) router.push(databaseHref(connection.id, db))
    await reloadTables()
  }

  async function empty(table: TableSummary) {
    await truncateTable({ connectionId: connection.id, db }, table.name)
    // The grid on that table is reading stale rows now; a refresh of the
    // route re-runs its query.
    if (current === table.name) router.refresh()
  }

  return (
    <aside
      data-slot="tables-column"
      className="bg-sidebar text-sidebar-foreground hidden w-64 shrink-0 flex-col overflow-hidden border-l md:flex"
    >
      <div className="flex h-10 shrink-0 items-center gap-1 border-b pr-1.5 pl-3 text-sm">
        <TransitionLink
          href={databaseHref(connection.id, db)}
          className="flex min-w-0 items-center gap-1.5 font-medium hover:underline"
          title={`${connection.name} · ${db}`}
        >
          <CylinderIcon className="text-muted-foreground size-3.5 shrink-0" />
          <span className="truncate">{db}</span>
        </TransitionLink>
        <span className="text-muted-foreground ml-auto text-xs tabular-nums">
          {tables.state === "loaded" ? tables.data.length : ""}
        </span>
        <Button variant="ghost" size="icon-xs" onClick={() => void reloadTables()} title="Refresh tables">
          <RefreshCwIcon />
          <span className="sr-only">Refresh tables</span>
        </Button>
        <Button variant="ghost" size="icon-xs" onClick={() => setCreating(true)} title="New table">
          <PlusIcon />
          <span className="sr-only">New table</span>
        </Button>
      </div>

      <div className="border-b px-2 py-1.5">
        <label className="bg-background text-muted-foreground focus-within:border-ring flex h-7 items-center gap-1.5 rounded-md border px-2 text-xs">
          <SearchIcon className="size-3.5 shrink-0" />
          <input
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder="Filter tables"
            className="text-foreground min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            spellCheck={false}
          />
        </label>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto py-1">
        {tables.state === "loading" ? (
          <div className="flex flex-col gap-1 px-3 py-1">
            {Array.from({ length: 6 }, (_, i) => (
              <div key={i} className="flex items-center gap-2 py-1">
                <Skeleton className="size-3.5 rounded-sm" />
                <Skeleton className="h-3" style={{ width: `${40 + ((i * 23) % 45)}%` }} />
              </div>
            ))}
          </div>
        ) : tables.state === "failed" ? (
          <div className="px-3 py-2">
            <p role="alert" className="text-destructive text-xs">
              {tables.error}
            </p>
            <button type="button" className="text-muted-foreground mt-1 text-xs underline" onClick={() => void reloadTables()}>
              Retry
            </button>
          </div>
        ) : tables.data.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">
            No tables yet. The <PlusIcon className="inline size-3 align-text-bottom" /> above creates one.
          </p>
        ) : shown.length === 0 ? (
          <p className="text-muted-foreground px-3 py-2 text-xs">No table matches.</p>
        ) : (
          <ul className="flex flex-col px-1.5">
            {shown.map((table) => (
              <TableRow
                key={table.name}
                table={table}
                active={current === table.name}
                href={databaseHref(connection.id, db, table.name)}
                onEmpty={() => setEmptying(table)}
                onDrop={() => setDropping(table)}
              />
            ))}
          </ul>
        )}
      </div>

      <CreateTableDialog open={creating} onOpenChange={setCreating} />
      <ConfirmDialog
        open={dropping !== null}
        onOpenChange={(open) => !open && setDropping(null)}
        title={`Drop ${dropping?.name ?? "table"}?`}
        description="The table and every row in it are gone for good."
        confirmLabel="Drop table"
        typeToConfirm={dropping?.name}
        onConfirm={() => (dropping ? drop(dropping) : Promise.resolve())}
      />
      <ConfirmDialog
        open={emptying !== null}
        onOpenChange={(open) => !open && setEmptying(null)}
        title={`Empty ${emptying?.name ?? "table"}?`}
        description="Every row is deleted; the table and its columns stay."
        confirmLabel="Empty table"
        onConfirm={() => (emptying ? empty(emptying) : Promise.resolve())}
      />
    </aside>
  )
}

function TableRow({
  table,
  active,
  href,
  onEmpty,
  onDrop,
}: {
  table: TableSummary
  active: boolean
  href: string
  onEmpty: () => void
  onDrop: () => void
}) {
  const Icon = table.tableType === "view" ? EyeIcon : TableIcon
  const isView = table.tableType === "view"
  return (
    <li className="group/row relative">
      <TransitionLink
        href={href}
        aria-current={active ? "page" : undefined}
        className={cn(
          "flex h-7 items-center gap-2 rounded-md pr-7 pl-2 text-sm",
          active ? "bg-sidebar-accent text-sidebar-accent-foreground font-medium" : "hover:bg-sidebar-accent/60",
        )}
        title={table.comment ?? table.name}
      >
        <Icon className="text-muted-foreground size-3.5 shrink-0" />
        <span className="min-w-0 flex-1 truncate">{table.name}</span>
        {table.rowEstimate !== null && (
          <span className="text-muted-foreground text-xs tabular-nums">{compactNumber(table.rowEstimate)}</span>
        )}
      </TransitionLink>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              size="icon-xs"
              className="absolute top-0.5 right-0.5 opacity-0 group-hover/row:opacity-100 focus-visible:opacity-100 aria-expanded:opacity-100"
            />
          }
        >
          <MoreHorizontalIcon />
          <span className="sr-only">More for {table.name}</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent className="w-44" side="left" align="start">
          <DropdownMenuItem render={<TransitionLink href={`${href}?tab=data`} />}>
            <TableIcon className="text-muted-foreground" />
            Browse
          </DropdownMenuItem>
          <DropdownMenuItem render={<TransitionLink href={`${href}?tab=structure`} />}>
            <ListTreeIcon className="text-muted-foreground" />
            Structure
          </DropdownMenuItem>
          {!isView && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem onClick={onEmpty}>
                <EraserIcon className="text-muted-foreground" />
                Empty
              </DropdownMenuItem>
              <DropdownMenuItem variant="destructive" onClick={onDrop}>
                <Trash2Icon />
                Drop
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </li>
  )
}
