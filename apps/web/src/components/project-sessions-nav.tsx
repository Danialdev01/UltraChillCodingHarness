"use client"

import * as React from "react"
import { AlertCircleIcon, BotIcon, CheckIcon, GitBranchIcon, Loader2Icon } from "lucide-react"
import { usePathname } from "next/navigation"

import { FormDialog, FormDialogFooter, FormField } from "@/components/form-dialog"
import { BranchPicker } from "@/components/new-project-dialog"
import { Skeleton } from "@/components/ui/skeleton"
import { SidebarMenuSubButton, SidebarMenuSubItem } from "@/components/ui/sidebar"
import { fetchGitBranches } from "@/lib/git-api"
import {
  settleProjectSession,
  startProjectSession,
  useProjectSessions,
  type ProjectSession,
} from "@/lib/project-sessions"
import { useRealtime, useToast } from "@/lib/realtime"
import { projectHref, projectSessionHashFromPath } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { isTaskThreadTitle } from "@/lib/tasks-api"
import { uptime, useMinuteClock } from "@/lib/uptime"
import { cn } from "@/lib/utils"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/**
 * A project's sessions, as rows under it in the sidebar. A new one is
 * started from the + on the project's own row.
 *
 * Every session is a conversation of its own at `/{ws}/p/{project}/{hash}`,
 * running in its own worktree, so several can run at once; the row says
 * whether its agent is working, and its corner how long it has been up --
 * swapped for Settle while the corner is hovered, as a session workspace's
 * cards do. Settling pushes the session's work to origin first and refuses
 * when it cannot. The Tasks board's own threads are left out -- they are the
 * pipeline's, and reached from the board. Fetched only while the project is
 * unfolded.
 */
export function ProjectSessionRows({ project, onNavigate }: { project: Project; onNavigate?: () => void }) {
  const ws = useWorkspaceHash()
  const router = useTransitionRouter()
  const toast = useToast()
  const now = useMinuteClock()
  const activeSession = projectSessionHashFromPath(usePathname())
  const { sessions, refresh } = useProjectSessions(project)
  const [settling, setSettling] = React.useState<string | null>(null)
  const shown = sessions?.filter((s) => !isTaskThreadTitle(s.title))

  async function settle(session: ProjectSession) {
    if (settling) return
    setSettling(session.id)
    try {
      const { pushed } = await settleProjectSession(project.hash, session.hash)
      toast({
        title: `Settled ${session.title}`,
        description: pushed ? `Its changes were pushed to ${pushed}.` : undefined,
      })
      refresh()
      if (session.hash === activeSession) router.push(projectHref(ws, "project", project.hash))
    } catch (e) {
      toast({
        title: "Could not settle the session",
        description: e instanceof Error ? e.message : undefined,
        tone: "error",
      })
    } finally {
      setSettling(null)
    }
  }

  return (
    <>
      {shown === undefined ? (
        <SidebarMenuSubItem>
          <div className="flex h-7 items-center px-2">
            <Skeleton className="h-3 w-24" />
          </div>
        </SidebarMenuSubItem>
      ) : (
        shown.map((session) => {
          const working = session.status === "running" || session.status === "cancelling"
          return (
            <SidebarMenuSubItem key={session.id} className="relative">
              <SidebarMenuSubButton
                isActive={session.hash === activeSession}
                onClick={onNavigate}
                render={<TransitionLink href={projectHref(ws, "project", project.hash, session.hash)} />}
                title={session.baseBranch ? `${session.title} · from ${session.baseBranch}` : session.title}
                className="pr-16"
              >
                <SessionIcon session={session} />
                <span className="truncate">{session.title}</span>
              </SidebarMenuSubButton>

              {/* The right-hand corner: how long the session has been up,
                  swapped for Settle while the corner itself is hovered. Not
                  while its agent works -- the server would refuse. */}
              <button
                type="button"
                onClick={() => void settle(session)}
                disabled={settling !== null || working}
                className="group/settle text-muted-foreground focus-visible:ring-sidebar-ring absolute top-1/2 right-1 flex h-5 min-w-12 -translate-y-1/2 cursor-pointer items-center justify-end rounded-md px-1.5 text-[11px] tabular-nums focus-visible:ring-2 focus-visible:outline-none disabled:cursor-default"
              >
                <span className={cn(!working && "group-hover/settle:hidden group-focus-visible/settle:hidden")}>
                  {settling === session.id ? "Settling…" : uptime(session.createdAt, now)}
                </span>
                {!working && (
                  <span className="text-foreground hidden items-center gap-1 group-hover/settle:flex group-focus-visible/settle:flex">
                    <CheckIcon className="size-3" aria-hidden />
                    Settle
                  </span>
                )}
                <span className="sr-only">
                  Settle {session.title} (pushes its changes to origin, then deletes the session)
                </span>
              </button>
            </SidebarMenuSubItem>
          )
        })
      )}
    </>
  )
}

/** The agent's state for a working session; the worktree's while it is not ready. */
function SessionIcon({ session }: { session: ProjectSession }) {
  if (session.worktreeState === "creating") return <Loader2Icon className="animate-spin" aria-label="Preparing worktree" />
  if (session.worktreeState === "error") return <AlertCircleIcon className="text-destructive" aria-label="Worktree failed" />
  const working = session.status === "running" || session.status === "cancelling"
  return <BotIcon className="ucch-agent-icon" data-status={working ? "working" : "idle"} aria-hidden />
}

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
