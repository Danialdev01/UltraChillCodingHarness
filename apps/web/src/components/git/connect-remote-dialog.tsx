"use client"

import * as React from "react"
import type { GitConnectResult, GitStatus } from "@ucch/protocol"
import { CheckIcon, CloudUploadIcon, GitMergeIcon, Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { looksLikeRepoUrl } from "@/lib/repo-url"

/**
 * Connecting a project that was started here to a repository somewhere else.
 *
 * Two steps, in the order that keeps the remote from refusing us: first the
 * URL is added and whatever the remote already holds is fetched and merged
 * in, then -- once the histories agree -- the push is offered. A merge that
 * conflicts ends the dialog early: the resolver in the view behind it is
 * where those get settled, and the toolbar's push is there when they are.
 */
export function ConnectRemoteDialog({
  open,
  status,
  busy,
  error,
  onOpenChange,
  onConnect,
  onPush,
}: {
  open: boolean
  status: GitStatus
  busy: string | null
  error: string | null
  onOpenChange(open: boolean): void
  onConnect(url: string): Promise<GitConnectResult | null>
  onPush(): Promise<GitStatus | null>
}) {
  const [url, setUrl] = React.useState("")
  const [connected, setConnected] = React.useState<GitConnectResult | null>(null)
  const [pushed, setPushed] = React.useState(false)

  React.useEffect(() => {
    if (!open) {
      setUrl("")
      setConnected(null)
      setPushed(false)
    }
  }, [open])

  const trimmed = url.trim()
  const canConnect = looksLikeRepoUrl(trimmed) && busy === null

  const connect = async () => {
    if (!canConnect) return
    const result = await onConnect(trimmed)
    if (!result) return
    // Conflicts are the view's to show; nothing here can help with them.
    if (result.conflicts) {
      onOpenChange(false)
      return
    }
    setConnected(result)
  }

  const push = async () => {
    const result = await onPush()
    if (result) setPushed(true)
  }

  const branch = status.branch ?? "this branch"
  const step = pushed ? "done" : connected ? "push" : "url"

  return (
    <Dialog open={open} onOpenChange={(next) => busy === null && onOpenChange(next)}>
      <DialogContent>
        {step === "url" && (
          <form
            className="contents"
            onSubmit={(e) => {
              e.preventDefault()
              void connect()
            }}
          >
            <DialogHeader>
              <DialogTitle>Add a remote</DialogTitle>
              <DialogDescription>
                Point <span className="font-mono">origin</span> at a repository. Anything already there is
                fetched and merged into {branch} first, so you can resolve conflicts here before pushing.
              </DialogDescription>
            </DialogHeader>
            <Field>
              <FieldLabel htmlFor="connect-remote-url">Repository URL</FieldLabel>
              <Input
                id="connect-remote-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                placeholder="https://github.com/owner/repo.git"
                spellCheck={false}
                autoComplete="off"
                autoFocus
                disabled={busy !== null}
              />
              {error && (
                <p role="alert" className="text-destructive text-xs whitespace-pre-wrap">
                  {error}
                </p>
              )}
            </Field>
            <DialogFooter>
              <Button type="button" variant="outline" disabled={busy !== null} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={!canConnect}>
                {busy === "Connect remote" ? <Loader2Icon className="animate-spin" /> : <GitMergeIcon />}
                Connect and fetch
              </Button>
            </DialogFooter>
          </form>
        )}

        {step === "push" && connected && (
          <>
            <DialogHeader>
              <DialogTitle>Push to origin?</DialogTitle>
              <DialogDescription>
                {connected.mergedFrom
                  ? `${connected.mergedFrom} was merged into ${branch} without conflicts.`
                  : "The repository is empty, so there was nothing to merge."}{" "}
                {connected.status.ahead > 0
                  ? `Push ${connected.status.ahead} ${connected.status.ahead === 1 ? "commit" : "commits"} to origin now?`
                  : `Publish ${branch} to origin now?`}
              </DialogDescription>
            </DialogHeader>
            {error && (
              <p role="alert" className="text-destructive text-xs whitespace-pre-wrap">
                {error}
              </p>
            )}
            <DialogFooter>
              <Button variant="outline" disabled={busy !== null} onClick={() => onOpenChange(false)}>
                Not now
              </Button>
              <Button disabled={busy !== null} onClick={() => void push()}>
                {busy === "Push" ? <Loader2Icon className="animate-spin" /> : <CloudUploadIcon />}
                Push {branch}
              </Button>
            </DialogFooter>
          </>
        )}

        {step === "done" && (
          <>
            <DialogHeader>
              <DialogTitle className="flex items-center gap-2">
                <CheckIcon className="text-ucch-active size-4" />
                Pushed
              </DialogTitle>
              <DialogDescription>{branch} is on origin and tracks it from here on.</DialogDescription>
            </DialogHeader>
            <DialogFooter>
              <Button onClick={() => onOpenChange(false)}>Done</Button>
            </DialogFooter>
          </>
        )}
      </DialogContent>
    </Dialog>
  )
}
