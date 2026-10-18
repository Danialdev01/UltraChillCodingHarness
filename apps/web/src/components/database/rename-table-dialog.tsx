"use client"

import * as React from "react"
import { Loader2Icon } from "lucide-react"
import { Identifier } from "@ucch/protocol"

import { errorText, useDb } from "@/components/database/db-context"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { renameTable } from "@/lib/database-api"
import { databaseHref } from "@/lib/sections"
import { useWorkspaceHash } from "@/lib/workspace-context"
import { useTransitionRouter } from "@/lib/view-transitions"

/** Rename a table, then follow it if its page was the one open. */
export function RenameTableDialog({
  table,
  open,
  onOpenChange,
  follow = false,
}: {
  table: string
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Navigate to the renamed table afterwards (from its own Operations tab). */
  follow?: boolean
}) {
  const { ref, connection, db, reloadTables } = useDb()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const [name, setName] = React.useState(table)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setName(table)
    setPending(false)
    setError(null)
  }, [open, table])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const parsed = Identifier.safeParse(name.trim())
    if (!parsed.success) return setError(parsed.error.issues[0]!.message)
    if (parsed.data === table) return onOpenChange(false)
    setPending(true)
    setError(null)
    try {
      await renameTable(ref, table, parsed.data)
      await reloadTables()
      onOpenChange(false)
      // Stay on Operations: that is where the rename was asked for.
      if (follow) router.replace(`${databaseHref(ws, connection.id, db, parsed.data)}?tab=operations`)
    } catch (caught) {
      setError(errorText(caught))
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Rename {table}</DialogTitle>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-4">
            <Field>
              <FieldLabel htmlFor="rename-table">New name</FieldLabel>
              <Input
                id="rename-table"
                value={name}
                onChange={(e) => setName(e.target.value)}
                autoComplete="off"
                spellCheck={false}
                autoFocus
                disabled={pending}
                className="font-mono text-sm"
              />
            </Field>
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
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
