"use client"

import * as React from "react"
import { GitBranchIcon } from "lucide-react"

import { FormDialog, FormDialogFooter, FormField } from "@/components/form-dialog"
import { BranchPicker } from "@/components/new-project-dialog"
import { fetchGitBranches } from "@/lib/git-api"
import { startProjectSession } from "@/lib/project-sessions"
import { useRealtime, useToast } from "@/lib/realtime"
import { projectHref } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { useTransitionRouter } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/**
 * Starts a session in a project, forked from the branch picked here.
 *
 * Every session gets a branch and a worktree of its own (`ucch/{hash}`), so
 * picking the same base for two is fine: they run side by side, each on its
 * own copy. The project's current branch is picked to begin with.
 */
export function NewSessionDialog({
  project,
  open,
  onOpenChange,
}: {
  project: Project
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const { client } = useRealtime()
  const toast = useToast()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const [branches, setBranches] = React.useState<string[] | null>(null)
  const [branch, setBranch] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  // Read afresh each time it opens: a branch made since is one to fork from.
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setBranches(null)
    setBranch("")
    setError(null)
    fetchGitBranches(project.hash).then(
      (list) => {
        if (cancelled) return
        const names = [...list.local, ...list.remote].map((b) => b.name)
        setBranches(names)
        setBranch(list.current ?? names[0] ?? "")
      },
      (e: unknown) => {
        if (cancelled) return
        setBranches([])
        setError(e instanceof Error ? e.message : "Could not list the project's branches.")
      },
    )
    return () => {
      cancelled = true
    }
  }, [open, project.hash])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!client || !branch || pending) return
    setPending(true)
    setError(null)
    try {
      await client.whenReady()
      const session = await startProjectSession(client, project, { baseBranch: branch })
      onOpenChange(false)
      router.push(projectHref(ws, "project", project.hash, session.hash))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      toast({ title: "Could not start a session", description: message, tone: "error" })
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={pending}
      icon={GitBranchIcon}
      title="New session"
      description={`A conversation of its own in ${project.name}, on its own branch and worktree, running alongside the others.`}
      onSubmit={(event) => void submit(event)}
      footer={
        <FormDialogFooter busy={pending} disabled={!branch || !client} hint="Forks a new branch from the base">
          Start session
        </FormDialogFooter>
      }
    >
      <FormField
        label="Base branch"
        labelId="new-session-branch-label"
        helper="The session's branch starts here. Sessions can share a base."
        error={error}
      >
        <BranchPicker
          branches={branches ?? []}
          value={branch}
          onChange={setBranch}
          disabled={pending}
          loading={branches === null}
          placeholder="This project has no branches yet"
          labelledBy="new-session-branch-label"
        />
      </FormField>
    </FormDialog>
  )
}
