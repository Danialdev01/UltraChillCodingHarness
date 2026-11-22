/** A running terminal of the project's, as `GET /api/projects/:id/terminals` lists it. */
export interface ProjectTerminal {
  id: string
  label: string
  /** The session whose worktree it opened in; null for the project's checkout. */
  sessionHash: string | null
  program: "shell" | "claude-login" | "codex-login" | "command"
  /** The command button a `command` terminal runs. */
  commandId?: string
  /** How its command ended (its exit status), or null while it still runs. */
  commandExit?: number | null
  createdAt: string
}

export interface ProjectTerminals {
  /** The caller's own, from every session of the project, oldest first. */
  terminals: ProjectTerminal[]
  /** How many may be open in the project at once (Workspace Settings > General). */
  limit: number
  /** How many are open in it now, every member's counted. */
  open: number
}

/** The caller's terminals in a project, and its room for more. */
export async function fetchProjectTerminals(projectId: string): Promise<ProjectTerminals> {
  const response = await fetch(`/api/projects/${projectId}/terminals`, { credentials: "include" })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? "Could not list the terminals.")
  }
  return (await response.json()) as ProjectTerminals
}
