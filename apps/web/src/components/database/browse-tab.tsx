"use client"

import * as React from "react"
import {
  ArrowDownIcon,
  ArrowUpIcon,
  ChevronLeftIcon,
  ChevronRightIcon,
  FilterIcon,
  PencilIcon,
  PlusIcon,
  RefreshCwIcon,
  SearchIcon,
  Trash2Icon,
  XIcon,
} from "lucide-react"
import { ROW_PAGE_SIZES, type Cell, type RowPage, type TableDetail } from "@ucch/protocol"

import { CellValue } from "@/components/database/cell-value"
import { selectClass } from "@/components/database/column-form"
import { ConfirmDialog } from "@/components/confirm-dialog"
import { errorText, useDb, type Listing } from "@/components/database/db-context"
import { RowFormDialog } from "@/components/database/row-form-dialog"
import { TableRowsSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { deleteRows, fetchRows, insertRow, updateRow } from "@/lib/database-api"
import { editText, isEditable, keyOf, parseCellInput, rowId } from "@/lib/db-cells"
import { cn } from "@/lib/utils"

interface Query {
  page: number
  pageSize: number
  sort?: string
  dir: "asc" | "desc"
  q: string
  where: string
}

/** A cell being typed into: which row, which column, and the text so far. */
interface Editing {
  id: string
  column: number
  text: string
}

/**
 * The rows of a table, the way phpMyAdmin's Browse tab shows them: a page
 * at a time, sorted by whichever header was clicked, filtered by a quick
 * search or a WHERE clause of your own.
 *
 * Editing is in place: double-click a cell, type, Enter. The update names
 * the row by its primary key, which is why a table without one -- or a
 * view -- is read-only here; the note above the grid says so. After a
 * write the page is fetched again rather than patched, so what is shown
 * is what the engine kept, defaults and triggers included.
 */
export function BrowseTab({ table, detail }: { table: string; detail: TableDetail }) {
  const { ref, change } = useDb()
  const [query, setQuery] = React.useState<Query>({ page: 1, pageSize: 100, dir: "asc", q: "", where: "" })
  const [qDraft, setQDraft] = React.useState("")
  const [whereDraft, setWhereDraft] = React.useState("")
  const [showWhere, setShowWhere] = React.useState(false)
  const [data, setData] = React.useState<Listing<RowPage>>({ state: "loading" })
  const [version, setVersion] = React.useState(0)
  const [selected, setSelected] = React.useState<Set<string>>(new Set())
  const [editing, setEditing] = React.useState<Editing | null>(null)
  const [saving, setSaving] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [inserting, setInserting] = React.useState(false)
  const [editingRow, setEditingRow] = React.useState<Cell[] | null>(null)
  const [deleting, setDeleting] = React.useState<Record<string, Cell>[] | null>(null)

  // A new table, or a new query, starts from a clean grid.
  React.useEffect(() => {
    setQuery({ page: 1, pageSize: 100, dir: "asc", q: "", where: "" })
    setQDraft("")
    setWhereDraft("")
    setSelected(new Set())
    setEditing(null)
    setError(null)
  }, [table])

  React.useEffect(() => {
    let cancelled = false
    setData((prev) => (prev.state === "loaded" ? prev : { state: "loading" }))
    fetchRows(ref, table, {
      page: query.page,
      pageSize: query.pageSize,
      sort: query.sort,
      dir: query.dir,
      q: query.q || undefined,
      where: query.where || undefined,
    })
      .then((page) => {
        if (cancelled) return
        setData({ state: "loaded", data: page })
        setSelected(new Set())
      })
      .catch((caught) => !cancelled && setData({ state: "failed", error: errorText(caught, "Could not read the rows.") }))
    return () => {
      cancelled = true
    }
  }, [ref, table, query, version])

  const reload = () => setVersion((v) => v + 1)

  // Rows changed in another tab. Held while something here is mid-edit or
  // selected -- a refetch would drop it -- and taken as soon as it is not.
  const busyHere = editing !== null || editingRow !== null || deleting !== null || selected.size > 0
  const [behind, setBehind] = React.useState(false)
  React.useEffect(() => {
    if (change && (change.table === table || change.table === "")) setBehind(true)
  }, [change, table])
  React.useEffect(() => {
    if (!behind || busyHere) return
    setBehind(false)
    setVersion((v) => v + 1)
  }, [behind, busyHere])

  const page = data.state === "loaded" ? data.data : null
  const columns = page?.columns ?? detail.columns
  const primaryKey = page?.primaryKey ?? detail.primaryKey
  const readOnly = page ? page.readOnly : detail.tableType === "view" || detail.primaryKey.length === 0

  function sortBy(column: string) {
    setQuery((q) => ({
      ...q,
      page: 1,
      sort: column,
      dir: q.sort === column && q.dir === "asc" ? "desc" : "asc",
    }))
  }

  function applyFilters(event?: React.FormEvent) {
    event?.preventDefault()
    setQuery((q) => ({ ...q, page: 1, q: qDraft.trim(), where: whereDraft.trim() }))
  }

  async function commitEdit() {
    if (!editing || !page || saving) return
    const rowIndex = page.rows.findIndex((row, i) => rowId(row, columns, primaryKey, i) === editing.id)
    const row = page.rows[rowIndex]
    const column = columns[editing.column]
    if (!row || !column) return setEditing(null)
    const next = parseCellInput(editing.text, column)
    const before = row[editing.column] ?? null
    if (before === next || (before !== null && next !== null && String(before) === String(next))) return setEditing(null)
    setSaving(true)
    setError(null)
    try {
      await updateRow(ref, table, keyOf(row, columns, primaryKey), { [column.name]: next })
      setEditing(null)
      reload()
    } catch (caught) {
      setError(errorText(caught))
    } finally {
      setSaving(false)
    }
  }

  function toggleAll(on: boolean) {
    if (!page) return
    setSelected(on ? new Set(page.rows.map((row, i) => rowId(row, columns, primaryKey, i))) : new Set())
  }

  function keysOfSelected(): Record<string, Cell>[] {
    if (!page) return []
    return page.rows.filter((row, i) => selected.has(rowId(row, columns, primaryKey, i))).map((row) => keyOf(row, columns, primaryKey))
  }

  const total = page?.total ?? 0
  const first = page ? (page.page - 1) * page.pageSize + 1 : 0
  const last = page ? Math.min(page.page * page.pageSize, total) : 0
  const lastPage = page ? Math.max(1, Math.ceil(total / page.pageSize)) : 1

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <form onSubmit={applyFilters} className="flex shrink-0 flex-wrap items-center gap-2 border-b px-3 py-2">
        <label className="bg-background text-muted-foreground border-input focus-within:border-ring focus-within:ring-2 focus-within:ring-ring flex h-8 w-56 items-center gap-1.5 rounded-lg border px-2 text-sm">
          <SearchIcon className="size-3.5 shrink-0" />
          <input
            value={qDraft}
            onChange={(e) => setQDraft(e.target.value)}
            placeholder="Search text columns"
            className="text-foreground min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground"
            spellCheck={false}
          />
          {qDraft && (
            <button
              type="button"
              onClick={() => {
                setQDraft("")
                setQuery((q) => ({ ...q, page: 1, q: "" }))
              }}
              className="hover:text-foreground"
            >
              <XIcon className="size-3.5" />
              <span className="sr-only">Clear search</span>
            </button>
          )}
        </label>
        <Button type="button" variant={showWhere || query.where ? "secondary" : "outline"} size="sm" onClick={() => setShowWhere((s) => !s)}>
          <FilterIcon />
          WHERE
        </Button>
        {showWhere && (
          <Input
            value={whereDraft}
            onChange={(e) => setWhereDraft(e.target.value)}
            placeholder="status = 'open' AND total > 100"
            className="h-8 min-w-64 flex-1 font-mono text-xs"
            spellCheck={false}
            autoFocus
          />
        )}
        <Button type="submit" variant="outline" size="sm">
          Apply
        </Button>
        <div className="ml-auto flex items-center gap-1">
          {selected.size > 0 && !readOnly && (
            <Button type="button" variant="destructive" size="sm" onClick={() => setDeleting(keysOfSelected())}>
              <Trash2Icon />
              Delete {selected.size}
            </Button>
          )}
          <Button type="button" variant="ghost" size="icon-sm" onClick={reload} title="Refresh">
            <RefreshCwIcon className={cn(data.state === "loading" && "animate-spin")} />
            <span className="sr-only">Refresh</span>
          </Button>
          {detail.tableType === "table" && (
            <Button type="button" size="sm" onClick={() => setInserting(true)}>
              <PlusIcon />
              Insert
            </Button>
          )}
        </div>
      </form>

      {(error || readOnly) && (
        <div className="shrink-0 border-b px-3 py-1.5 text-xs">
          {error ? (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          ) : (
            <p className="text-muted-foreground">
              {detail.tableType === "view" ? "A view: rows can be read but not edited." : "No primary key, so rows cannot be edited or deleted in place."}
            </p>
          )}
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-auto">
        {data.state === "failed" ? (
          <div className="p-4">
            <p role="alert" className="text-destructive text-sm">
              {data.error}
            </p>
            <Button variant="outline" size="sm" className="mt-2" onClick={reload}>
              Retry
            </Button>
          </div>
        ) : data.state === "loading" && !page ? (
          <TableRowsSkeleton />
        ) : page && page.rows.length === 0 ? (
          <p className="text-muted-foreground p-4 text-sm">{query.q || query.where ? "No rows match." : "This table is empty."}</p>
        ) : page ? (
          <table className="w-max min-w-full border-separate border-spacing-0 text-xs">
            <thead className="bg-background sticky top-0 z-10">
              <tr>
                {!readOnly && (
                  <th className="border-b px-2 py-1.5">
                    <input
                      type="checkbox"
                      aria-label="Select all rows on this page"
                      className="accent-ucch-active size-3.5 align-middle"
                      checked={selected.size > 0 && selected.size === page.rows.length}
                      onChange={(e) => toggleAll(e.target.checked)}
                    />
                  </th>
                )}
                {columns.map((column) => (
                  <th key={column.name} className="border-b px-0 text-left font-medium">
                    <button
                      type="button"
                      onClick={() => sortBy(column.name)}
                      className="hover:bg-muted/60 flex h-8 w-full items-center gap-1 px-2 text-left whitespace-nowrap"
                      title={column.type}
                    >
                      <span className={cn(column.primary && "underline decoration-warning decoration-2 underline-offset-2")}>
                        {column.name}
                        {column.primary && <span className="sr-only"> (primary key)</span>}
                      </span>
                      {query.sort === column.name &&
                        (query.dir === "asc" ? <ArrowUpIcon className="size-3 shrink-0" /> : <ArrowDownIcon className="size-3 shrink-0" />)}
                    </button>
                  </th>
                ))}
                {!readOnly && <th className="border-b" />}
              </tr>
            </thead>
            <tbody className={cn(data.state === "loading" && "opacity-60")}>
              {page.rows.map((row, index) => {
                const id = rowId(row, columns, primaryKey, index)
                const isSelected = selected.has(id)
                return (
                  <tr key={id} className={cn("group/row", isSelected ? "bg-ucch-active-bg" : "hover:bg-muted/40")}>
                    {!readOnly && (
                      <td className="border-b px-2 py-1 align-top">
                        <input
                          type="checkbox"
                          aria-label={`Select row ${index + 1}`}
                          className="accent-ucch-active size-3.5 align-middle"
                          checked={isSelected}
                          onChange={(e) => {
                            const next = new Set(selected)
                            if (e.target.checked) next.add(id)
                            else next.delete(id)
                            setSelected(next)
                          }}
                        />
                      </td>
                    )}
                    {columns.map((column, c) => {
                      const cell = row[c] ?? null
                      const isEditing = editing?.id === id && editing.column === c
                      return (
                        <td
                          key={column.name}
                          className={cn("max-w-md border-b px-2 py-1 align-top whitespace-nowrap", isEditing && "p-0")}
                          onDoubleClick={() => {
                            if (readOnly || column.generated || !isEditable(cell)) return
                            setEditing({ id, column: c, text: editText(cell) })
                          }}
                        >
                          {isEditing ? (
                            <input
                              autoFocus
                              value={editing.text}
                              disabled={saving}
                              onChange={(e) => setEditing({ ...editing, text: e.target.value })}
                              onBlur={() => void commitEdit()}
                              onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                  e.preventDefault()
                                  void commitEdit()
                                } else if (e.key === "Escape") {
                                  e.preventDefault()
                                  setEditing(null)
                                }
                              }}
                              className="bg-background ring-ucch-active h-full min-w-32 px-2 py-1 font-mono text-xs ring-2 outline-none ring-inset"
                            />
                          ) : (
                            <CellValue cell={cell} />
                          )}
                        </td>
                      )
                    })}
                    {!readOnly && (
                      <td className="border-b px-1 py-0.5 align-top">
                        <span className="flex opacity-0 group-hover/row:opacity-100 focus-within:opacity-100">
                          <Button variant="ghost" size="icon-xs" title="Edit row" onClick={() => setEditingRow(row)}>
                            <PencilIcon />
                            <span className="sr-only">Edit row {index + 1}</span>
                          </Button>
                          <Button variant="ghost" size="icon-xs" title="Delete row" onClick={() => setDeleting([keyOf(row, columns, primaryKey)])}>
                            <Trash2Icon />
                            <span className="sr-only">Delete row {index + 1}</span>
                          </Button>
                        </span>
                      </td>
                    )}
                  </tr>
                )
              })}
            </tbody>
          </table>
        ) : null}
      </div>

      <div className="text-muted-foreground flex h-10 shrink-0 items-center gap-3 border-t px-3 text-xs">
        {page && (
          <span className="tabular-nums">
            {page.rows.length === 0 ? "0 rows" : `${first.toLocaleString()}–${last.toLocaleString()} of ${page.exact ? "" : "~"}${total.toLocaleString()}`}
          </span>
        )}
        <div className="ml-auto flex items-center gap-1">
          <select
            aria-label="Rows per page"
            value={query.pageSize}
            onChange={(e) => setQuery((q) => ({ ...q, page: 1, pageSize: Number(e.target.value) }))}
            className={cn(selectClass, "h-7 text-xs")}
          >
            {ROW_PAGE_SIZES.map((n) => (
              <option key={n} value={n}>
                {n} / page
              </option>
            ))}
          </select>
          <Button variant="ghost" size="icon-sm" disabled={query.page <= 1} onClick={() => setQuery((q) => ({ ...q, page: q.page - 1 }))}>
            <ChevronLeftIcon />
            <span className="sr-only">Previous page</span>
          </Button>
          <span className="tabular-nums">
            {query.page} / {lastPage}
          </span>
          <Button variant="ghost" size="icon-sm" disabled={query.page >= lastPage} onClick={() => setQuery((q) => ({ ...q, page: q.page + 1 }))}>
            <ChevronRightIcon />
            <span className="sr-only">Next page</span>
          </Button>
        </div>
      </div>

      <RowFormDialog
        open={inserting}
        onOpenChange={setInserting}
        detail={detail}
        title={`Insert into ${table}`}
        submitLabel="Insert"
        onSubmit={async (values) => {
          await insertRow(ref, table, values)
          reload()
        }}
      />
      {editingRow && (
        <RowFormDialog
          open
          onOpenChange={(open) => !open && setEditingRow(null)}
          detail={detail}
          row={editingRow}
          title="Edit row"
          submitLabel="Save"
          onSubmit={async (values) => {
            await updateRow(ref, table, keyOf(editingRow, columns, primaryKey), values)
            reload()
          }}
        />
      )}
      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={deleting && deleting.length > 1 ? `Delete ${deleting.length} rows?` : "Delete this row?"}
        description="Deleted rows cannot be brought back."
        confirmLabel="Delete"
        onConfirm={async () => {
          if (!deleting) return
          await deleteRows(ref, table, deleting)
          reload()
        }}
      />
    </div>
  )
}
