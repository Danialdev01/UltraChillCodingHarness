/**
 * A project's command buttons, over the API.
 *
 * The list lives in the project's `.agent/commands.json`; the server reads
 * and writes that file. Running one opens a terminal tab with
 * `program: "command"` and the command's id -- never the command line.
 */

import type { ProjectCommand, ProjectCommandsResponse } from "@ucch/protocol"

export type { ProjectCommand, ProjectCommandsResponse }

async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  throw new Error(body.error ?? fallback)
}

export async function listCommands(hash: string): Promise<ProjectCommandsResponse> {
  const response = await fetch(`/api/projects/${hash}/commands`, { credentials: "include" })
  if (!response.ok) await fail(response, "Could not load the command buttons.")
  return (await response.json()) as ProjectCommandsResponse
}

export async function saveCommands(hash: string, commands: ProjectCommand[]): Promise<ProjectCommandsResponse> {
  const response = await fetch(`/api/projects/${hash}/commands`, {
    method: "PUT",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ commands }),
  })
  if (!response.ok) await fail(response, "Could not save the command buttons.")
  return (await response.json()) as ProjectCommandsResponse
}
