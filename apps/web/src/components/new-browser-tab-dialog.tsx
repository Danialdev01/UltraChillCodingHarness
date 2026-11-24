"use client"

import * as React from "react"
import { GlobeIcon } from "lucide-react"

import { FIELD, FormDialog, FormDialogFooter, FormField, Optional } from "@/components/form-dialog"

/** Asks for a tab's address and what to call it. Mount it fresh for each opening. */
export function NewBrowserTabDialog({
  open,
  onOpenChange,
  onOpen,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** Rejects with what to show when the tab could not be opened. */
  onOpen: (url: string, name: string | null) => Promise<void>
}) {
  const [url, setUrl] = React.useState("")
  const [name, setName] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!url.trim() || busy) return
    setBusy(true)
    setError(null)
    try {
      await onOpen(url.trim(), name.trim() || null)
      setUrl("")
      setName("")
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      icon={GlobeIcon}
      title="New browser tab"
      description="The AI in this session can see and use the tab."
      onSubmit={(event) => void submit(event)}
      footer={
        <FormDialogFooter busy={busy} disabled={!url.trim()}>
          Open tab
        </FormDialogFooter>
      }
    >
      <FormField label="URL" htmlFor="browser-tab-url" error={error}>
        <input
          id="browser-tab-url"
          autoFocus
          value={url}
          maxLength={4000}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="localhost:3000 or example.com"
          autoComplete="off"
          spellCheck={false}
          className={FIELD}
        />
      </FormField>
      <FormField
        label={
          <>
            Name <Optional />
          </>
        }
        htmlFor="browser-tab-name"
      >
        <input
          id="browser-tab-name"
          value={name}
          maxLength={60}
          onChange={(e) => setName(e.target.value)}
          placeholder="Shop front"
          autoComplete="off"
          className={FIELD}
        />
      </FormField>
    </FormDialog>
  )
}
