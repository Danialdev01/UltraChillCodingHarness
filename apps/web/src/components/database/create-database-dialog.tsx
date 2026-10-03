"use client"

import * as React from "react"
import { Loader2Icon } from "lucide-react"
import { CreateDatabaseBody } from "@ucch/protocol"

import { errorText } from "@/components/database/db-context"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { createDatabase } from "@/lib/database-api"

/** A new, empty database on the connection's server. */
export function CreateDatabaseDialog({
  connectionId,
  connectionName,
  open,
  onOpenChange,
  onCreated,
}: {
  connectionId: string
  connectionName: string
  open: boolean
  onOpenChange: (open: boolean) => void
  onCreated: (name: string) => void | Promise<void>
}) {
  const [name, setName] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setName("")
    setPending(false)
    setError(null)
  }, [open])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const parsed = CreateDatabaseBody.safeParse({ name: name.trim() })
    if (!parsed.success) return setError(parsed.error.issues[0]!.message)
    setPending(true)
    setError(null)
    try {
      await createDatabase(connectionId, parsed.data.name)
      await onCreated(parsed.data.name)
      onOpenChange(false)
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
            <DialogTitle>New database</DialogTitle>
            <DialogDescription>On {connectionName}. Empty until something is created or imported into it.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-4">
            <Field>
              <FieldLabel htmlFor="new-db-name">Name</FieldLabel>
              <Input
                id="new-db-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="app_production"
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
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
