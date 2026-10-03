"use client"

import * as React from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { KEY_NAME_MAX, KEY_URL_MAX, KEY_VALUE_MAX } from "@ucch/protocol"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { parseTags, type ProjectKey, type ProjectKeyInput } from "@/lib/keys-api"

/** What the dialog is open for: a new key, or one already saved. */
export type KeyDialogState = { mode: "create" } | { mode: "edit"; key: ProjectKey } | null

/**
 * The form behind a row: name, value, tags and URL.
 *
 * Editing never shows the stored value -- the field starts empty and a blank
 * one keeps the key as it is, so opening the dialog to fix a tag cannot
 * put the secret on screen or overwrite it by accident.
 */
export function KeyDialog({
  state,
  busy,
  onClose,
  onSave,
}: {
  state: KeyDialogState
  busy: boolean
  onClose: () => void
  onSave: (input: Partial<ProjectKeyInput>) => Promise<void>
}) {
  const editing = state?.mode === "edit" ? state.key : null

  const [name, setName] = React.useState("")
  const [value, setValue] = React.useState("")
  const [showValue, setShowValue] = React.useState(false)
  const [tags, setTags] = React.useState("")
  const [url, setUrl] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!state) return
    setName(editing?.name ?? "")
    setValue("")
    setShowValue(false)
    setTags(editing?.tags.join(", ") ?? "")
    setUrl(editing?.url ?? "")
    setError(null)
  }, [state, editing])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const trimmed = name.trim()
    if (!trimmed) return setError("Give the key a name.")
    if (!editing && !value) return setError("Paste the key's value.")
    const link = url.trim()
    if (link && !/^https?:\/\//i.test(link)) return setError("The URL must start with http:// or https://.")
    setError(null)
    try {
      await onSave({
        name: trimmed,
        ...(value ? { value } : {}),
        tags: parseTags(tags),
        url: link || null,
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  return (
    <Dialog open={state !== null} onOpenChange={(open) => !open && !busy && onClose()}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4" autoComplete="off">
          <DialogHeader>
            <DialogTitle>{editing ? "Edit key" : "New key"}</DialogTitle>
            <DialogDescription>
              {editing
                ? "Leave the value empty to keep the one already saved."
                : "Stored encrypted. Only shown again when you ask for it."}
            </DialogDescription>
          </DialogHeader>

          <div className="grid gap-2">
            <Label htmlFor="key-name">Name</Label>
            <Input
              id="key-name"
              autoFocus
              value={name}
              maxLength={KEY_NAME_MAX}
              onChange={(e) => setName(e.target.value)}
              placeholder="OPENAI_API_KEY"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="key-value">{editing ? "New value" : "Value"}</Label>
            <div className="relative">
              <Input
                id="key-value"
                type={showValue ? "text" : "password"}
                value={value}
                maxLength={KEY_VALUE_MAX}
                onChange={(e) => setValue(e.target.value)}
                placeholder={editing ? "Unchanged" : "sk-…"}
                className="pr-9 font-mono"
                // Not a login: keep password managers from offering to save it.
                autoComplete="new-password"
                data-1p-ignore
                data-lpignore="true"
              />
              <button
                type="button"
                onClick={() => setShowValue((v) => !v)}
                aria-label={showValue ? "Hide value" : "Show value"}
                title={showValue ? "Hide value" : "Show value"}
                className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-9 items-center justify-center"
              >
                {showValue ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
              </button>
            </div>
          </div>

          <div className="grid gap-2">
            <Label htmlFor="key-tags">
              Tags <span className="text-muted-foreground font-normal">· comma separated</span>
            </Label>
            <Input
              id="key-tags"
              value={tags}
              onChange={(e) => setTags(e.target.value)}
              placeholder="openai, production"
            />
          </div>

          <div className="grid gap-2">
            <Label htmlFor="key-url">URL</Label>
            <Input
              id="key-url"
              type="url"
              value={url}
              maxLength={KEY_URL_MAX}
              onChange={(e) => setUrl(e.target.value)}
              placeholder="https://platform.openai.com/api-keys"
            />
          </div>

          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {editing ? "Save" : "Add key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
