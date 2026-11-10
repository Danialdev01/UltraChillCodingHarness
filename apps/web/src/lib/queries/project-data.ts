import type { QueryKey } from "@tanstack/react-query"
import type { TaskSettings } from "@ucch/protocol"

import { listCommands } from "../commands-api"
import { listRuntimes } from "../runtimes-api"
import { fetchTree } from "../files-api"
import { listEnvVars } from "../env-api"
import { listNotes } from "../notes-api"
import type { ProjectTarget } from "../project-target"
import { qk } from "../query-keys"
import type { ProjectSession } from "../session"
import { fetchTaskSettings, listTasks } from "../tasks-api"
import { listTimelineTasks } from "../timeline-api"

/**
 * A project's lists as the client cache holds them: key, fetcher and whether
 * the copy is persisted, in one place.
 *
 * The views read through these and the boot preload (`lib/preload.ts`) fills
 * the cache through them, so what is fetched ahead of time lands under exactly
 * the key -- and with exactly the persistence -- the view will later ask for.
 */
export interface ProjectQuery<T> {
  queryKey: QueryKey
  queryFn: () => Promise<T>
  persist: boolean
}

/** A project's sessions, newest first. */
export async function fetchProjectSessions(projectHash: string): Promise<ProjectSession[]> {
  const response = await fetch(`/api/projects/${projectHash}/threads`, { credentials: "include" })
  if (!response.ok) throw new Error("Could not list the project's sessions.")
  // A subagent's session opens from its card, never from a list.
  return ((await response.json()) as { threads: ProjectSession[] }).threads.filter((session) => !session.parentThreadId)
}

/** The client-cache key of a project's (or session's) file tree. */
export function treeKey(target: ProjectTarget): QueryKey {
  return typeof target === "string" ? qk.files.tree(target) : qk.files.tree(target.hash, target.session ?? null)
}

export const projectQueries = {
  sessions: (hash: string): ProjectQuery<ProjectSession[]> => ({
    queryKey: qk.sessions.list(hash),
    queryFn: () => fetchProjectSessions(hash),
    persist: true,
  }),
  tasks: (hash: string) => ({ queryKey: qk.tasks.list(hash), queryFn: () => listTasks(hash), persist: true }),
  taskSettings: (hash: string): ProjectQuery<TaskSettings> => ({
    queryKey: qk.tasks.settings(hash),
    queryFn: () => fetchTaskSettings(hash),
    persist: false,
  }),
  notesTree: (hash: string) => ({ queryKey: qk.notes.tree(hash), queryFn: () => listNotes(hash), persist: true }),
  timeline: (hash: string) => ({
    queryKey: qk.timeline.list(hash),
    queryFn: () => listTimelineTasks(hash),
    persist: true,
  }),
  // Names, tags and links only: values never reach the cache.
  env: (hash: string) => ({ queryKey: qk.keys.list(hash), queryFn: () => listEnvVars(hash), persist: true }),
  commands: (hash: string) => ({ queryKey: qk.commands.list(hash), queryFn: () => listCommands(hash), persist: true }),
  // Not persisted: install progress and "update available" go stale fast.
  runtimes: (hash: string) => ({ queryKey: qk.runtimes.list(hash), queryFn: () => listRuntimes(hash), persist: false }),
  filesTree: (target: ProjectTarget) => ({ queryKey: treeKey(target), queryFn: () => fetchTree(target), persist: true }),
} satisfies Record<string, (arg: never) => ProjectQuery<unknown>>
