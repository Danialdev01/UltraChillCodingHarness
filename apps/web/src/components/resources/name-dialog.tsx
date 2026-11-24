"use client"

import * as React from "react"

import { FIELD, FormDialog, FormDialogFooter, FormField } from "@/components/form-dialog"

/** Asks for one name: a new folder's, or a new name for a row. */
export function NameDialog({
  title,
  icon,
  initial,
  submitLabel,
  onClose,
  onSubmit,
}: {
  title: string
  icon: React.ComponentType<{ className?: string; strokeWidth?: number }>
  initial: string
  submitLabel: string
  onClose: (open: boolean) => void
  onSubmit: (name: string) => Promise<void>
}) {
  const [name, setName] = React.useState(initial)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const trimmed = name.trim()
  const valid = trimmed !== "" && !trimmed.includes("/") && trimmed !== "." && trimmed !== ".."

  return (
    <FormDialog
      open
      onOpenChange={onClose}
      busy={busy}
      icon={icon}
      title={title}
      description="Shared with everyone in the workspace."
      onSubmit={async (e) => {
        e.preventDefault()
        if (!valid || busy) return
        setBusy(true)
        setError(null)
        try {
          await onSubmit(trimmed)
          onClose(false)
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err))
        } finally {
          setBusy(false)
        }
      }}
      footer={
        <FormDialogFooter busy={busy} disabled={!valid || trimmed === initial}>
          {submitLabel}
        </FormDialogFooter>
      }
    >
      <FormField label="Name" htmlFor="resource-name" error={error}>
        <input
          id="resource-name"
          className={FIELD}
          value={name}
          autoFocus
          onFocus={(e) => {
            // Select the stem, so typing replaces the name and keeps the extension.
            const dot = e.target.value.lastIndexOf(".")
            e.target.setSelectionRange(0, dot > 0 ? dot : e.target.value.length)
          }}
          onChange={(e) => setName(e.target.value)}
        />
      </FormField>
    </FormDialog>
  )
}
