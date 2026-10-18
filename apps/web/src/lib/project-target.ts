/**
 * Which tree a files or git call works on: a project hash alone for the
 * project's own checkout, or with `session` for a project session's
 * worktree. A plain string is the checkout, so every caller that never
 * deals in sessions keeps passing `project.hash`.
 */
export type ProjectTarget = string | { hash: string; session?: string | null }

/** The tree a project's view is showing: its session's worktree when it has one. */
export function targetOf(project: { hash: string; sessionHash?: string | null }): ProjectTarget {
  return project.sessionHash ? { hash: project.hash, session: project.sessionHash } : project.hash
}

/**
 * `/api/projects/{hash}/{path}`, with `query` and the session -- which the
 * server reads as `?session={threadHash}` on every files and git route.
 */
export function projectApiUrl(target: ProjectTarget, path: string, query: Record<string, string> = {}): string {
  const { hash, session } = typeof target === "string" ? { hash: target, session: null } : target
  // A path may carry a query of its own (`diff?path=…`); the rest joins it.
  const [route, own = ""] = path.split("?", 2) as [string, string?]
  const params = new URLSearchParams(own)
  for (const [key, value] of Object.entries(query)) params.set(key, value)
  if (session) params.set("session", session)
  const search = params.toString()
  return `/api/projects/${hash}/${route}${search ? `?${search}` : ""}`
}
