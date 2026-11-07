"use client"

import * as React from "react"
import { EyeIcon, EyeOffIcon } from "lucide-react"
import { PROJECT_KEY_MAX } from "@ucch/protocol/plain"

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
import { unlockEnv } from "@/lib/env-api"
import { unlockProject } from "@/lib/project-key-store"

/**
 * Asks for the project key and, once the server says it is the right one,
 * holds it in this tab's memory (`project-key-store.ts`).
 */
export function UnlockDialog({
  projectHash,
  open,
  onOpenChange,
}: {
  projectHash: string
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [key, setKey] = React.useState("")
  const [show, setShow] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (open) return
    setKey("")
    setShow(false)
    setError(null)
  }, [open])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!key) return setError("Enter the project key.")
    setBusy(true)
    try {
      await unlockEnv(projectHash, key)
      unlockProject(projectHash, key)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent>
        <form onSubmit={submit} className="grid gap-4" autoComplete="off">
          <DialogHeader>
            <DialogTitle>Unlock environment variables</DialogTitle>
            <DialogDescription>
              Enter the project key. It stays in this tab only, until you lock, reload, or leave it
              idle for 15 minutes.
            </DialogDescription>
          </DialogHeader>
          <div className="grid gap-2">
            <Label htmlFor="unlock-project-key">Project key</Label>
            <div className="relative">
              <Input
                id="unlock-project-key"
                autoFocus
                type={show ? "text" : "password"}
                value={key}
                maxLength={PROJECT_KEY_MAX}
                onChange={(e) => setKey(e.target.value)}
                className="pr-9"
                autoComplete="off"
                data-1p-ignore
                data-lpignore="true"
              />
              <button
                type="button"
                onClick={() => setShow((v) => !v)}
                aria-label={show ? "Hide project key" : "Show project key"}
                className="text-muted-foreground hover:text-foreground absolute inset-y-0 right-0 flex w-9 items-center justify-center"
              >
                {show ? <EyeOffIcon className="size-4" /> : <EyeIcon className="size-4" />}
              </button>
            </div>
          </div>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              Unlock
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
