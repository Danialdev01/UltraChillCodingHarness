"use client"

import * as React from "react"
import { Loader2Icon } from "lucide-react"

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
import { confirmsName } from "@/lib/confirm-name"

/**
 * A yes-or-no for something that cannot be undone.
 *
 * With `typeToConfirm` the button stays off until the name is typed back,
 * for the things whose loss is a whole table rather than a row. The action
 * runs inside the dialog so its error lands next to the button that caused
 * it, and the dialog only closes once it has succeeded.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel = "Delete",
  typeToConfirm,
  onConfirm,
  children,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: React.ReactNode
  confirmLabel?: string
  /** The name the user must type back before the button turns on. */
  typeToConfirm?: string
  onConfirm: () => Promise<void>
  children?: React.ReactNode
}) {
  const [typed, setTyped] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) return
    setTyped("")
    setPending(false)
    setError(null)
  }, [open])

  const ready = !typeToConfirm || confirmsName(typed, typeToConfirm)

  async function confirm() {
    setPending(true)
    setError(null)
    try {
      await onConfirm()
      onOpenChange(false)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Something went wrong.")
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description && <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>
        {children}
        {typeToConfirm && (
          <Field>
            <FieldLabel htmlFor="confirm-name">
              Type <span className="font-mono">{typeToConfirm}</span> to confirm
            </FieldLabel>
            <Input
              id="confirm-name"
              value={typed}
              onChange={(e) => setTyped(e.target.value)}
              autoComplete="off"
              spellCheck={false}
              autoFocus
              disabled={pending}
            />
          </Field>
        )}
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
            Cancel
          </DialogClose>
          <Button type="button" variant="destructive" disabled={!ready || pending} onClick={() => void confirm()}>
            {pending && <Loader2Icon className="animate-spin" />}
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
