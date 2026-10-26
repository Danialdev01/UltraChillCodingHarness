"use client"

import * as React from "react"
import { Loader2Icon, PlusIcon, Trash2Icon } from "lucide-react"
import { Identifier } from "@ucch/protocol/database"

import { ColumnFields, emptyColumn, specFromDraft, type ColumnDraft } from "@/components/database/column-form"
import { errorText, useDb } from "@/components/database/db-context"
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
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { createTable } from "@/lib/database-api"
import { databaseHref } from "@/lib/sections"
import { useWorkspaceHash } from "@/lib/workspace-context"
import { useTransitionRouter } from "@/lib/view-transitions"

/** The column most tables start with, so a new table is one click from usable. */
function idColumn(engine: "mysql" | "postgresql"): ColumnDraft {
  return {
    ...emptyColumn(),
    name: "id",
    type: engine === "mysql" ? "INT" : "integer",
    nullable: false,
    autoincrement: true,
    primaryKey: true,
  }
}

/**
 * A new table: a name and a list of columns. Opens on the new table when
 * done, since the next thing is nearly always to put something in it.
 */
export function CreateTableDialog({ open, onOpenChange }: { open: boolean; onOpenChange: (open: boolean) => void }) {
  const { ref, engine, connection, db, reloadTables } = useDb()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const [name, setName] = React.useState("")
  const [columns, setColumns] = React.useState<ColumnDraft[]>([])
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setName("")
    setColumns([idColumn(engine)])
    setPending(false)
    setError(null)
  }, [open, engine])

  function update(index: number, next: ColumnDraft) {
    setColumns((all) => all.map((c, i) => (i === index ? next : c)))
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const tableName = Identifier.safeParse(name.trim())
    if (!tableName.success) return setError(`name: ${tableName.error.issues[0]!.message}`)
    const specs = []
    for (const [i, draft] of columns.entries()) {
      const result = specFromDraft(draft)
      if ("error" in result) return setError(`column ${i + 1}, ${result.error}`)
      specs.push(result.spec)
    }
    if (specs.length === 0) return setError("a table needs at least one column")
    setPending(true)
    setError(null)
    try {
      await createTable(ref, { name: tableName.data, columns: specs })
      await reloadTables()
      onOpenChange(false)
      router.push(databaseHref(ws, connection.id, db, tableName.data))
    } catch (caught) {
      setError(errorText(caught))
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="max-h-[90svh] overflow-y-auto sm:max-w-2xl">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New table</DialogTitle>
            <DialogDescription>In {db}. Columns can be added and changed later from the Structure tab.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-4 py-4">
            <Field>
              <FieldLabel htmlFor="table-name">Table name</FieldLabel>
              <Input
                id="table-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="orders"
                autoComplete="off"
                spellCheck={false}
                autoFocus
                disabled={pending}
                className="font-mono text-sm"
              />
            </Field>

            <ol className="flex flex-col gap-3">
              {columns.map((draft, index) => (
                <li key={index} className="rounded-lg border p-3">
                  <div className="mb-2 flex items-center justify-between">
                    <span className="text-muted-foreground text-xs font-medium">Column {index + 1}</span>
                    <Button
                      type="button"
                      variant="ghost"
                      size="icon-xs"
                      disabled={pending || columns.length === 1}
                      onClick={() => setColumns((all) => all.filter((_, i) => i !== index))}
                    >
                      <Trash2Icon />
                      <span className="sr-only">Remove column {index + 1}</span>
                    </Button>
                  </div>
                  <ColumnFields draft={draft} onChange={(next) => update(index, next)} engine={engine} disabled={pending} idPrefix={`new-${index}`} />
                </li>
              ))}
            </ol>
            <Button type="button" variant="outline" size="sm" className="self-start" disabled={pending} onClick={() => setColumns((all) => [...all, emptyColumn()])}>
              <PlusIcon />
              Add column
            </Button>

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
              Create table
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
