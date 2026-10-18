"use client"

import * as React from "react"
import type { GitStatus } from "@ucch/protocol"
import { GitCommitHorizontalIcon, Loader2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Textarea } from "@/components/ui/textarea"

/**
 * Summary, description, and a button that names the branch it commits to.
 *
 * The button is the only place the target is stated, which is how GitHub
 * Desktop stops people committing to the wrong branch: it is written on the
 * thing they press. ⌘/Ctrl+Enter from either field commits.
 */
export function CommitForm({
  status,
  busy,
  onCommit,
}: {
  status: GitStatus
  busy: boolean
  onCommit(summary: string, description: string): Promise<boolean>
}) {
  const [summary, setSummary] = React.useState("")
  const [description, setDescription] = React.useState("")
  const staged = status.files.filter((f) => !f.untracked && f.index !== ".").length
  const unresolved = status.files.filter((f) => f.conflicted).length
  const merging = status.mergeInProgress || status.rebaseInProgress
  const canCommit = summary.trim().length > 0 && unresolved === 0 && (staged > 0 || (merging && status.files.length === 0)) && !busy

  const submit = async () => {
    if (!canCommit) return
    const ok = await onCommit(summary.trim(), description)
    if (ok) {
      setSummary("")
      setDescription("")
    }
  }
  const onKeyDown = (e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault()
      void submit()
    }
  }

  const target = status.detached ? "detached HEAD" : (status.branch ?? "HEAD")
  const hint =
    unresolved > 0
      ? `Resolve ${unresolved} conflicted ${unresolved === 1 ? "file" : "files"} first`
      : staged === 0 && !merging
        ? "Stage a file to commit it"
        : null

  return (
    <form
      className="flex flex-col gap-2 border-t p-3"
      onSubmit={(e) => {
        e.preventDefault()
        void submit()
      }}
    >
      <Input
        value={summary}
        onChange={(e) => setSummary(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={merging ? "Merge commit" : "Summary (required)"}
        maxLength={200}
        disabled={busy}
        aria-label="Commit summary"
        className="h-8 text-xs"
      />
      <Textarea
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Description"
        rows={3}
        maxLength={5000}
        disabled={busy}
        aria-label="Commit description"
        className="min-h-16 resize-none text-xs"
      />
      <Button type="submit" size="sm" disabled={!canCommit} className="justify-start gap-2">
        {busy ? <Loader2Icon className="animate-spin" /> : <GitCommitHorizontalIcon />}
        <span className="truncate">
          Commit to <span className="font-semibold">{target}</span>
        </span>
        {staged > 0 && <span className="text-muted-foreground ml-auto text-xs tabular-nums">{staged}</span>}
      </Button>
      {hint && <p className="text-muted-foreground text-xs">{hint}</p>}
    </form>
  )
}
