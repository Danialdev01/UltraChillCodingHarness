"use client"

import * as React from "react"

import { ProjectSkeleton } from "@/components/page-skeletons"
import { startProjectSession } from "@/lib/project-sessions"
import { useRealtime } from "@/lib/realtime"
import { projectHref } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { useTransitionRouter } from "@/lib/view-transitions"

/**
 * A project with no session yet: starts its first, and goes to it.
 *
 * Done here rather than on the server because a session is started with a
 * command over the socket. The first session works in the project's main
 * checkout -- the one the preview serves and a fresh repository may not yet
 * have a commit to fork from; every session started after it gets a
 * worktree of its own. The page is the conversation skeleton meanwhile,
 * which is what it becomes.
 */
export function FirstSession({ project }: { project: Project }) {
  const { client } = useRealtime()
  const router = useTransitionRouter()
  const [failure, setFailure] = React.useState<string | null>(null)
  const started = React.useRef(false)

  React.useEffect(() => {
    if (!client || started.current || !project.workspaceHash) return
    started.current = true
    const ws = project.workspaceHash
    void client
      .whenReady()
      .then(() => startProjectSession(client, project))
      .then((session) => router.replace(projectHref(ws, "project", project.hash, session.hash)))
      .catch((e: unknown) => setFailure(e instanceof Error ? e.message : String(e)))
  }, [client, project, router])

  if (failure) {
    return (
      <div className="flex flex-1 items-center justify-center p-4">
        <p className="text-destructive text-sm">Could not start a session: {failure}</p>
      </div>
    )
  }
  return <ProjectSkeleton />
}
