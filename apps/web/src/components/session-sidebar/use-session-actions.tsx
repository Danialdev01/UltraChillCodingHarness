"use client"

import * as React from "react"
import { usePathname } from "next/navigation"
import { ArchiveIcon, ArchiveRestoreIcon, CheckIcon, CopyIcon, PencilIcon, PinIcon, PinOffIcon, Trash2Icon } from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { RenameSessionDialog } from "@/components/on-demand"
import type { SessionAction } from "@/components/session-sidebar/session-card"
import { SettleSessionDialog } from "@/components/session-sidebar/settle-session-dialog"
import { renameProject } from "@/lib/create-project"
import { rememberLastModel, rememberLastProvider } from "@/lib/model-preference"
import {
  deleteSettledSession,
  fetchSessionSettleCheck,
  settleProjectSession,
  settleWorkspaceSession,
  startProjectSession,
} from "@/lib/project-sessions"
import { qk } from "@/lib/query-keys"
import { useRealtime, useToast } from "@/lib/realtime"
import { projectHref, projectSessionHashFromPath } from "@/lib/sections"
import type { Project, Workspace } from "@/lib/session"
import type { SessionStatus, SidebarSession } from "@/lib/session-sidebar"
import { useInvalidate } from "@/lib/use-invalidate"
import { useNewSession } from "@/lib/use-new-session"
import { useTransitionRouter } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/**
 * What can be done to a session -- rename, pin, duplicate, archive, settle,
 * delete -- and the dialogs those open.
 *
 * Shared by the sidebar's cards and the session menu in the top bar, so the
 * two offer the same verbs and confirm them the same way. Render `dialogs`
 * once wherever the hook is used.
 */
export function useSessionActions({
  workspace,
  projects,
  activeProjectHash,
}: {
  workspace: Workspace
  projects: readonly Project[]
  activeProjectHash?: string
}) {
  const sessionWorkspace = workspace.kind === "session"
  const ws = useWorkspaceHash()
  const pathname = usePathname()
  const activeSession = projectSessionHashFromPath(pathname)
  const router = useTransitionRouter()
  const toast = useToast()
  const invalidate = useInvalidate()
  const { client } = useRealtime()
  const newQuickSession = useNewSession(workspace.id)

  const permissions = workspace.permissions
  const canWrite = permissions.includes("project.write")
  const canStart = permissions.includes("session.create") && (!sessionWorkspace || permissions.includes("project.create"))

  const [renameTarget, setRenameTarget] = React.useState<SidebarSession | null>(null)
  const [settleTarget, setSettleTarget] = React.useState<SidebarSession | null>(null)
  const [removeTarget, setRemoveTarget] = React.useState<SidebarSession | null>(null)
  /** A session workspace's session being settled: the files it holds besides `.agent/`. */
  const [settleFiles, setSettleFiles] = React.useState<{ count: number; names: string[] }>({ count: 0, names: [] })

  const isActive = (s: SidebarSession) =>
    sessionWorkspace ? s.project.hash === activeProjectHash : s.hash === activeSession && s.project.hash === activeProjectHash

  const projectOf = (projectId: string) => projects.find((p) => p.id === projectId) ?? null

  // -- Actions ------------------------------------------------------------------

  async function update(session: SidebarSession, patch: { title?: string; pinned?: boolean; archived?: boolean }) {
    if (!client) throw new Error("Not connected to the server yet.")
    await client.dispatch({ type: "thread.update", threadId: session.id, ...patch })
    invalidate(qk.sessions.all)
  }

  async function act(label: string, run: () => Promise<unknown>) {
    try {
      await run()
    } catch (e) {
      toast({ title: `Could not ${label}`, description: e instanceof Error ? e.message : undefined, tone: "error" })
    }
  }

  async function duplicate(session: SidebarSession) {
    const project = projectOf(session.project.id)
    if (!project) return
    // The copy opens on the same harness and model: the chat reads these
    // before its first message binds the thread (`model-preference.ts`).
    if (session.provider) rememberLastProvider(project.id, session.provider)
    if (session.model && session.provider) rememberLastModel(`${project.id}:${session.provider}`, session.model)
    if (sessionWorkspace) {
      newQuickSession.start()
      return
    }
    if (!client) throw new Error("Not connected to the server yet.")
    // The project's base as it is now, not the one the original forked from.
    const created = await startProjectSession(client, project, {
      baseBranch: project.defaultBranch ?? session.project.baseBranch ?? session.baseBranch,
    })
    router.push(projectHref(ws, "project", project.hash, created.hash))
  }

  async function settle(session: SidebarSession) {
    if (sessionWorkspace) {
      await settleWorkspaceSession(session.project.hash)
      toast({ title: `Settled ${session.title}` })
      invalidate(qk.sessions.all, qk.project(session.project.hash))
      return
    }
    let result
    try {
      result = await settleProjectSession(session.project.hash, session.hash ?? "")
    } finally {
      // Settled or failed, the row changed.
      invalidate(qk.sessions.all, qk.git.all)
    }
    const merged = result.mergeCommitSha
      ? `Merged into ${result.baseBranch} @ ${result.mergeCommitSha.slice(0, 7)}.`
      : undefined
    const pushed = result.pushed
      ? ` ${result.pushed} was pushed to origin.`
      : result.pushError
        ? ` Pushing ${result.baseBranch} failed: ${result.pushError}`
        : ""
    toast({ title: `Settled ${session.title}`, description: merged ? merged + pushed : undefined })
    if (result.removed && isActive(session)) router.push(projectHref(ws, "project", session.project.hash))
  }

  /**
   * Settling in a session workspace: no name to type. It asks first only
   * when the session holds files besides `.agent/`; otherwise it settles.
   */
  async function beginSettle(session: SidebarSession) {
    if (!sessionWorkspace) {
      setSettleTarget(session)
      return
    }
    const check = await fetchSessionSettleCheck(session.project.hash)
    if (check.running) throw new Error("The agent is still working in this session. Stop it, then settle.")
    if (check.files > 0) {
      setSettleFiles({ count: check.files, names: check.names })
      setSettleTarget(session)
      return
    }
    await settle(session)
  }

  /**
   * Deletes a settled session for good: its work is merged already. In a
   * project workspace the thread goes; in a session workspace the session
   * is its own project, and goes files and all.
   */
  async function remove(session: SidebarSession) {
    if (sessionWorkspace) {
      const { leftFiles } = await deleteSettledSession(session.project.hash)
      toast({ title: `Deleted ${session.title}`, description: leftFiles ? "Some of its files could not be removed." : undefined })
      invalidate(qk.projects.all, qk.sessions.all, qk.bootstrap())
      if (isActive(session)) router.push(`/${ws}`)
      return
    }
    await settleProjectSession(session.project.hash, session.hash ?? "", { discard: true })
    toast({ title: `Deleted ${session.title}` })
    invalidate(qk.sessions.all, qk.git.all)
    if (isActive(session)) router.push(projectHref(ws, "project", session.project.hash))
  }

  /** Removes a project session without committing: its changes go with its worktree and branch. */
  async function discard(session: SidebarSession) {
    await settleProjectSession(session.project.hash, session.hash ?? "", { discard: true })
    toast({ title: `Settled ${session.title}`, description: "Its changes were not committed." })
    invalidate(qk.sessions.all)
    if (isActive(session)) router.push(projectHref(ws, "project", session.project.hash))
  }

  function actionsFor(session: SidebarSession, status: SessionStatus): (SessionAction | "separator")[] {
    const working = status === "running" || status === "waiting_input"
    const archived = Boolean(session.archivedAt)
    const out: (SessionAction | "separator")[] = []
    if (canWrite) {
      out.push(
        { label: "Rename", icon: PencilIcon, onSelect: () => setRenameTarget(session) },
        session.pinned
          ? { label: "Unpin", icon: PinOffIcon, onSelect: () => void act("unpin it", () => update(session, { pinned: false })) }
          : { label: "Pin", icon: PinIcon, onSelect: () => void act("pin it", () => update(session, { pinned: true })) },
      )
    }
    if (canStart) {
      out.push({ label: "Duplicate", icon: CopyIcon, onSelect: () => void act("duplicate it", () => duplicate(session)) })
    }
    if (canWrite) {
      out.push(
        archived
          ? { label: "Restore", icon: ArchiveRestoreIcon, onSelect: () => void act("restore it", () => update(session, { archived: false })) }
          : {
              label: "Archive",
              icon: ArchiveIcon,
              disabled: working,
              onSelect: () => void act("archive it", () => update(session, { archived: true })),
            },
      )
      out.push(
        "separator",
        session.settleState === "settled"
          ? { label: "Delete session…", icon: Trash2Icon, destructive: true, disabled: working, onSelect: () => setRemoveTarget(session) }
          : {
              label: session.settleState === "failed" ? "Retry settle…" : "Settle…",
              icon: CheckIcon,
              destructive: true,
              disabled: working,
              onSelect: () => void act("settle it", () => beginSettle(session)),
            },
      )
    }
    return out
  }

  const dialogs = (
    <>
      <RenameSessionDialog
        session={renameTarget ? { hash: renameTarget.project.hash, name: renameTarget.title } : null}
        onOpenChange={(open) => !open && setRenameTarget(null)}
        save={async (name) => {
          if (!renameTarget) return
          await update(renameTarget, { title: name })
          // A session workspace's card is the project: named the same.
          if (sessionWorkspace) await renameProject(renameTarget.project.hash, name)
        }}
        onRenamed={() => {
          setRenameTarget(null)
          invalidate(qk.sessions.all, qk.bootstrap())
        }}
      />
      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(open) => !open && setRemoveTarget(null)}
        title={`Delete ${removeTarget?.title ?? "session"}?`}
        description={
          sessionWorkspace
            ? "The session, its conversation and its files are deleted for good. This cannot be undone."
            : "The session and its conversation are deleted for good. Its work is already merged and stays. This cannot be undone."
        }
        confirmLabel="Delete"
        onConfirm={async () => {
          if (removeTarget) await remove(removeTarget)
        }}
      />
      {sessionWorkspace ? (
        <ConfirmDialog
          open={settleTarget !== null}
          onOpenChange={(open) => !open && setSettleTarget(null)}
          title={`Settle ${settleTarget?.title ?? "session"}?`}
          description={`This session has ${settleFiles.count === 1 ? "a file" : `${settleFiles.count} files`} besides .agent/. Settled sessions are deleted, files and all, when you delete settled session data in Workspace Settings. Are you sure you want to settle it?`}
          confirmLabel="Settle"
          onConfirm={async () => {
            if (settleTarget) await settle(settleTarget)
          }}
        >
          {settleFiles.names.length > 0 && (
            <ul className="bg-muted/50 text-muted-foreground max-h-32 overflow-y-auto rounded-md px-3 py-2 font-mono text-xs">
              {settleFiles.names.map((name) => (
                <li key={name} className="truncate">
                  {name}
                </li>
              ))}
              {settleFiles.count > settleFiles.names.length && <li>…and {settleFiles.count - settleFiles.names.length} more</li>}
            </ul>
          )}
        </ConfirmDialog>
      ) : (
        <SettleSessionDialog
          session={settleTarget}
          onOpenChange={(open) => !open && setSettleTarget(null)}
          onSettle={settle}
          onDiscard={discard}
        />
      )}
    </>
  )

  return { actionsFor, dialogs, isActive }
}
