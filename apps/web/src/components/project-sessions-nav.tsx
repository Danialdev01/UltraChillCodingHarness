"use client"

import * as React from "react"
import { AlertCircleIcon, BotIcon, CheckIcon, Loader2Icon } from "lucide-react"
import { usePathname } from "next/navigation"

import { Skeleton } from "@/components/ui/skeleton"
import { SidebarMenuSubButton, SidebarMenuSubItem } from "@/components/ui/sidebar"
import {
  settleProjectSession,
  useProjectSessions,
  type ProjectSession,
} from "@/lib/project-sessions"
import { useToast } from "@/lib/realtime"
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
