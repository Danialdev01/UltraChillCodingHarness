"use client"

import * as React from "react"
import { BotIcon, CheckIcon, GitBranchIcon, PencilIcon } from "lucide-react"

import { useFilesPanel } from "@/components/files-panel"
import { FIELD, FormDialog, FormDialogFooter, FormField } from "@/components/form-dialog"
import { SidebarGroup, SidebarGroupContent, SidebarGroupLabel } from "@/components/ui/sidebar"
import { renameProject } from "@/lib/create-project"
import { useAgentActivity, useToast } from "@/lib/realtime"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"
import { uptime, useMinuteClock } from "@/lib/uptime"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"
import { useProjectHref, useWorkspaceHash } from "@/lib/workspace-context"

/**
 * A session workspace's sidebar: one card per session.
 *
 * Flat, unlike the project list: a session has no pages to unfold -- its
 * chat, files and terminal are the tabs at the top of the one page it has --
 * so a row is just a place to go. Each card reads title, then metadata: the
 * title as the one bright line, then the branch beside the
 * agent's live status. A session's actions live in the header's settings
 * menu, beside the file search, rather than on every card.
 * Newest first, since a session is something you pick up where you left off.
 */
export function SessionList({
  sessions,
  activeProjectHash,
}: {
  sessions: readonly Project[]
  activeProjectHash?: string
}) {
  const agentStatusOf = useAgentActivity(sessions)
  const { project: openProject, closeFiles } = useFilesPanel()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const hrefOf = useProjectHref()
  const [settling, setSettling] = React.useState<string | null>(null)
  const toast = useToast()
  const now = useMinuteClock()

  const ordered = React.useMemo(
    () =>
      [...sessions].sort((a, b) =>
        (b.lastActiveAt ?? b.createdAt ?? "").localeCompare(a.lastActiveAt ?? a.createdAt ?? ""),
      ),
    [sessions],
  )

  function afterDelete(deleted: Project) {
    if (openProject?.id === deleted.id) closeFiles()
    if (deleted.hash === activeProjectHash) router.push(`/${ws}`)
    router.refresh()
  }

  /**
   * Settling a session is done with it: the session is deleted outright,
   * with no confirmation, since the corner only offers it on a deliberate hover.
   */
  async function settle(session: Project) {
    if (settling) return
    setSettling(session.id)
    try {
      const response = await fetch(`/api/projects/${session.hash}`, {
        method: "DELETE",
        credentials: "include",
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        // A running turn comes back as 409 with the remedy in the message.
        toast({ title: "Could not settle the session", description: body.error, tone: "error" })
        return
      }
      afterDelete(session)
    } catch {
      toast({ title: "Could not settle the session", description: "Could not reach the server.", tone: "error" })
    } finally {
      setSettling(null)
    }
  }

  return (
    <SidebarGroup className="px-0">
      <SidebarGroupLabel className="px-4">Sessions</SidebarGroupLabel>
      <SidebarGroupContent className="flex flex-col gap-[5px] px-2">
        {ordered.length === 0 ? (
          <p className="text-muted-foreground px-2 py-2 text-sm">
            No sessions yet.
          </p>
        ) : (
          <ul className="flex flex-col gap-[5px]">
            {ordered.map((session) => {
              const isActive = session.hash === activeProjectHash
              const agent = agentStatusOf(session)
              return (
                <li key={session.id} className="group/session relative">
                  <TransitionLink
                    href={hrefOf(session.hash)}
                    aria-current={isActive ? "page" : undefined}
                    className={cn(
                      "focus-visible:ring-sidebar-ring flex flex-col gap-1 rounded-[10px] px-3 py-2.5 transition-colors focus-visible:ring-2 focus-visible:outline-none",
                      isActive
                        ? "bg-sidebar-accent text-sidebar-accent-foreground"
                        : "bg-sidebar-accent/40 hover:bg-sidebar-accent/70",
                    )}
                  >
                    {/* Row 1: what -- the one bright line. */}
                    <span className="text-sidebar-foreground truncate text-[14px] leading-snug font-medium">
                      {session.name}
                    </span>
                    {/* Row 2: which branch, and what the agent is doing, with
                        room on the right for the uptime / Settle corner. */}
                    <span className="text-muted-foreground flex min-w-0 items-center gap-1.5 pr-16 text-xs">
                      <span className="flex min-w-0 items-center gap-1">
                        <GitBranchIcon className="size-3 shrink-0" aria-hidden />
                        <span className="truncate">{session.defaultBranch ?? "main"}</span>
                      </span>
                      <BotIcon
                        className="ucch-agent-icon size-3.5 shrink-0"
                        data-status={agent}
                        aria-hidden
                      />
                      {agent !== "idle" && (
                        <span className="sr-only">
                          {agent === "working" ? "(agent working)" : "(agent done)"}
                        </span>
                      )}
                    </span>
                  </TransitionLink>

                  {/* The bottom-right corner: how long the session has been up,
                      swapped for Settle while the corner itself is hovered. */}
                  <button
                    type="button"
                    onClick={() => void settle(session)}
                    disabled={settling !== null}
                    className="group/settle text-muted-foreground focus-visible:ring-sidebar-ring absolute right-2 bottom-2 flex h-5 min-w-14 cursor-pointer items-center justify-end rounded-md px-1.5 text-xs tabular-nums focus-visible:ring-2 focus-visible:outline-none disabled:cursor-default"
                  >
                    <span className="group-hover/settle:hidden group-focus-visible/settle:hidden">
                      {settling === session.id ? "Settling…" : uptime(session.createdAt, now)}
                    </span>
                    <span className="hidden items-center gap-1 text-foreground group-hover/settle:flex group-focus-visible/settle:flex">
                      <CheckIcon className="size-3.5" aria-hidden />
                      Settle
                    </span>
                    <span className="sr-only">Settle {session.name} (deletes the session)</span>
                  </button>

                </li>
              )
            })}
          </ul>
        )}
      </SidebarGroupContent>

    </SidebarGroup>
  )
}

export function RenameSessionDialog({
  session,
  onOpenChange,
  onRenamed,
}: {
  session: Project | null
  onOpenChange: (open: boolean) => void
  onRenamed: () => void
}) {
  const [name, setName] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!session) return
    setName(session.name)
    setError(null)
  }, [session])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || pending || !name.trim()) return
    setPending(true)
    setError(null)
    try {
      await renameProject(session.hash, name.trim())
      onOpenChange(false)
      onRenamed()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename it.")
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={session !== null}
      onOpenChange={onOpenChange}
      busy={pending}
      icon={PencilIcon}
      title="Rename session"
      description="The title shown on the session's card."
      onSubmit={submit}
      footer={
        <FormDialogFooter busy={pending} disabled={!name.trim() || name.trim() === session?.name}>
          {pending ? "Saving…" : "Rename"}
        </FormDialogFooter>
      }
    >
      <FormField label="Title" htmlFor="session-title" error={error}>
        <input
          id="session-title"
          className={FIELD}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          autoFocus
          required
          disabled={pending}
        />
      </FormField>
    </FormDialog>
  )
}
