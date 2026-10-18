"use client"

import * as React from "react"
import { ChevronRightIcon, KeyRoundIcon, Loader2Icon, PencilIcon, PlusIcon, Trash2Icon } from "lucide-react"
import { Identifier, type ColumnInfo, type IndexInfo, type TableDetail } from "@ucch/protocol"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { ColumnFormDialog, Flag, selectClass } from "@/components/database/column-form"
import { errorText, useDb } from "@/components/database/db-context"
import { CodeLinesSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { addColumn, addIndex, dropColumn, dropIndex, fetchCreateSql, modifyColumn } from "@/lib/database-api"
import { cn } from "@/lib/utils"

/**
 * What a table is made of: its columns, its indexes, the keys pointing out
 * of it, and the statement that would make it again. Every change here
 * calls `onChanged`, which re-reads the description; the tab does not try
 * to guess what the engine did with the request.
 */
export function TableStructureTab({ detail, onChanged }: { detail: TableDetail; onChanged: () => void }) {
  const { ref, engine } = useDb()
  const isView = detail.tableType === "view"
  const [adding, setAdding] = React.useState(false)
  const [editing, setEditing] = React.useState<ColumnInfo | null>(null)
  const [droppingColumn, setDroppingColumn] = React.useState<ColumnInfo | null>(null)
  const [addingIndex, setAddingIndex] = React.useState(false)
  const [droppingIndex, setDroppingIndex] = React.useState<IndexInfo | null>(null)

  return (
    <div className="flex flex-col gap-6 p-4">
      <section className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <h2 className="text-sm font-medium">Columns</h2>
          <span className="text-muted-foreground text-xs">{detail.columns.length}</span>
          {!isView && (
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAdding(true)}>
              <PlusIcon />
              Add column
            </Button>
          )}
        </div>
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Type</TableHead>
                <TableHead>Null</TableHead>
                <TableHead>Default</TableHead>
                <TableHead>Attributes</TableHead>
                <TableHead>Comment</TableHead>
                {!isView && <TableHead className="w-16" />}
              </TableRow>
            </TableHeader>
            <TableBody>
              {detail.columns.map((column) => (
                <TableRow key={column.name}>
                  <TableCell className="font-mono text-xs font-medium">
                    <span className="flex items-center gap-1.5">
                      {column.primary && <KeyRoundIcon className="size-3 text-warning" aria-label="primary key" />}
                      {column.name}
                    </span>
                  </TableCell>
                  <TableCell className="font-mono text-xs">{column.type}</TableCell>
                  <TableCell className="text-xs">{column.nullable ? "Yes" : "No"}</TableCell>
                  <TableCell className="max-w-48 truncate font-mono text-xs" title={column.default ?? undefined}>
                    {column.default === null ? <span className="text-muted-foreground italic">None</span> : column.default}
                  </TableCell>
                  <TableCell className="text-xs">
                    <span className="flex flex-wrap gap-1">
                      {column.autoincrement && <Badge>auto increment</Badge>}
                      {column.unique && !column.primary && <Badge>unique</Badge>}
                      {column.generated && <Badge>generated</Badge>}
                    </span>
                  </TableCell>
                  <TableCell className="text-muted-foreground max-w-48 truncate text-xs">{column.comment}</TableCell>
                  {!isView && (
                    <TableCell className="py-1">
                      <span className="flex items-center">
                        <Button variant="ghost" size="icon-xs" onClick={() => setEditing(column)} title="Change">
                          <PencilIcon />
                          <span className="sr-only">Change {column.name}</span>
                        </Button>
                        <Button variant="ghost" size="icon-xs" onClick={() => setDroppingColumn(column)} title="Drop">
                          <Trash2Icon />
                          <span className="sr-only">Drop {column.name}</span>
                        </Button>
                      </span>
                    </TableCell>
                  )}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </section>

      {!isView && (
        <section className="flex flex-col gap-2">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">Indexes</h2>
            <span className="text-muted-foreground text-xs">{detail.indexes.length}</span>
            <Button size="sm" variant="outline" className="ml-auto" onClick={() => setAddingIndex(true)}>
              <PlusIcon />
              Add index
            </Button>
          </div>
          {detail.indexes.length === 0 ? (
            <p className="text-muted-foreground rounded-lg border p-4 text-center text-sm">No indexes.</p>
          ) : (
            <div className="rounded-lg border">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Columns</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead className="w-10" />
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.indexes.map((index) => (
                    <TableRow key={index.name}>
                      <TableCell className="font-mono text-xs font-medium">{index.name}</TableCell>
                      <TableCell className="font-mono text-xs">{index.columns.join(", ")}</TableCell>
                      <TableCell className="text-xs">
                        <span className="flex gap-1">
                          {index.primary ? <Badge>primary</Badge> : index.unique ? <Badge>unique</Badge> : null}
                          {index.type && <Badge>{index.type.toLowerCase()}</Badge>}
                        </span>
                      </TableCell>
                      <TableCell className="py-1">
                        {!index.primary && (
                          <Button variant="ghost" size="icon-xs" onClick={() => setDroppingIndex(index)} title="Drop">
                            <Trash2Icon />
                            <span className="sr-only">Drop {index.name}</span>
                          </Button>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </section>
      )}

      {detail.foreignKeys.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-medium">Foreign keys</h2>
          <div className="rounded-lg border">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Name</TableHead>
                  <TableHead>Columns</TableHead>
                  <TableHead>References</TableHead>
                  <TableHead>On update</TableHead>
                  <TableHead>On delete</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {detail.foreignKeys.map((fk) => (
                  <TableRow key={fk.name}>
                    <TableCell className="font-mono text-xs font-medium">{fk.name}</TableCell>
                    <TableCell className="font-mono text-xs">{fk.columns.join(", ")}</TableCell>
                    <TableCell className="font-mono text-xs">
                      {fk.refTable}({fk.refColumns.join(", ")})
                    </TableCell>
                    <TableCell className="text-xs">{fk.onUpdate}</TableCell>
                    <TableCell className="text-xs">{fk.onDelete}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </section>
      )}

      <CreateStatement table={detail.name} />

      <ColumnFormDialog
        open={adding}
        onOpenChange={setAdding}
        engine={engine}
        columns={detail.columns}
        onSubmit={async (spec, after) => {
          await addColumn(ref, detail.name, { column: spec, ...(after ? { after } : {}) })
          onChanged()
        }}
      />
      {editing && (
        <ColumnFormDialog
          open
          onOpenChange={(open) => !open && setEditing(null)}
          engine={engine}
          existing={editing}
          columns={detail.columns}
          onSubmit={async (spec) => {
            await modifyColumn(ref, detail.name, editing.name, spec)
            onChanged()
          }}
        />
      )}
      <ConfirmDialog
        open={droppingColumn !== null}
        onOpenChange={(open) => !open && setDroppingColumn(null)}
        title={`Drop column ${droppingColumn?.name ?? ""}?`}
        description="Its value in every row is gone for good."
        confirmLabel="Drop column"
        onConfirm={async () => {
          if (!droppingColumn) return
          await dropColumn(ref, detail.name, droppingColumn.name)
          onChanged()
        }}
      />
      <AddIndexDialog
        open={addingIndex}
        onOpenChange={setAddingIndex}
        columns={detail.columns}
        onSubmit={async (spec) => {
          await addIndex(ref, detail.name, spec)
          onChanged()
        }}
      />
      <ConfirmDialog
        open={droppingIndex !== null}
        onOpenChange={(open) => !open && setDroppingIndex(null)}
        title={`Drop index ${droppingIndex?.name ?? ""}?`}
        description="Queries that used it get slower; no data changes."
        confirmLabel="Drop index"
        onConfirm={async () => {
          if (!droppingIndex) return
          await dropIndex(ref, detail.name, droppingIndex.name)
          onChanged()
        }}
      />
    </div>
  )
}

function Badge({ children }: { children: React.ReactNode }) {
  return <span className="bg-muted text-muted-foreground rounded px-1.5 py-0.5 text-[11px] whitespace-nowrap">{children}</span>
}

/** The CREATE statement, fetched only when unfolded: it is a round trip of its own. */
function CreateStatement({ table }: { table: string }) {
  const { ref } = useDb()
  const [open, setOpen] = React.useState(false)
  const [sql, setSql] = React.useState<{ text?: string; error?: string } | null>(null)

  React.useEffect(() => {
    if (!open || sql) return
    fetchCreateSql(ref, table)
      .then((text) => setSql({ text }))
      .catch((error) => setSql({ error: errorText(error) }))
  }, [open, sql, ref, table])

  // A structural change elsewhere makes this stale; forget it so the next
  // unfold fetches again.
  React.useEffect(() => setSql(null), [table])

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1 text-sm font-medium">
        <ChevronRightIcon className={cn("size-4 transition-transform", open && "rotate-90")} />
        CREATE statement
      </CollapsibleTrigger>
      <CollapsibleContent>
        {sql === null ? (
          <div className="mt-2 rounded-lg border">
            <CodeLinesSkeleton rows={6} />
          </div>
        ) : sql.error ? (
          <p role="alert" className="text-destructive py-2 text-sm">
            {sql.error}
          </p>
        ) : (
          <pre className="bg-muted/40 mt-2 overflow-x-auto rounded-lg border p-3 font-mono text-xs whitespace-pre">{sql.text}</pre>
        )}
      </CollapsibleContent>
    </Collapsible>
  )
}

function AddIndexDialog({
  open,
  onOpenChange,
  columns,
  onSubmit,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  columns: ColumnInfo[]
  onSubmit: (spec: { name: string; columns: string[]; unique: boolean }) => Promise<void>
}) {
  const [name, setName] = React.useState("")
  const [chosen, setChosen] = React.useState<string[]>([])
  const [unique, setUnique] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setName("")
    setChosen([])
    setUnique(false)
    setPending(false)
    setError(null)
  }, [open])

  // A name suggested from the columns, until one is typed.
  const suggested = chosen.length > 0 ? `idx_${chosen.join("_")}`.slice(0, 63) : ""

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const parsed = Identifier.safeParse((name || suggested).trim())
    if (!parsed.success) return setError(`name: ${parsed.error.issues[0]!.message}`)
    if (chosen.length === 0) return setError("pick at least one column")
    setPending(true)
    setError(null)
    try {
      await onSubmit({ name: parsed.data, columns: chosen, unique })
      onOpenChange(false)
    } catch (caught) {
      setError(errorText(caught))
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Add index</DialogTitle>
            <DialogDescription>Columns are indexed in the order chosen.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-4">
            <Field>
              <FieldLabel htmlFor="index-name">Name</FieldLabel>
              <Input
                id="index-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder={suggested || "idx_column"}
                autoComplete="off"
                spellCheck={false}
                disabled={pending}
                className="font-mono text-sm"
              />
            </Field>
            <div className="flex flex-col gap-1">
              <span className="text-sm font-medium">Columns</span>
              <select
                multiple
                aria-label="Columns"
                value={chosen}
                onChange={(e) => setChosen(Array.from(e.target.selectedOptions, (o) => o.value))}
                disabled={pending}
                className={cn(selectClass, "h-32 py-1 font-mono text-xs")}
              >
                {columns.map((c) => (
                  <option key={c.name} value={c.name}>
                    {c.name}
                  </option>
                ))}
              </select>
              {chosen.length > 0 && <span className="text-muted-foreground font-mono text-xs">{chosen.join(", ")}</span>}
            </div>
            <Flag id="index-unique" label="Unique" checked={unique} disabled={pending} onChange={setUnique} className="text-sm" />
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Add index
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
