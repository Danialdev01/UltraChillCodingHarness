/**
 * A project's runtime versions (PHP today), over the API.
 *
 * The choice lives in the project's `.agent/runtimes.json`; the server reads
 * and writes that file, and keeps the installed versions -- shared by every
 * project on the server -- under its runtimes folder.
 */

import type { ProjectRuntimeStatus, ProjectRuntimesResponse, RuntimeId } from "@ucch/protocol"

export type { ProjectRuntimeStatus, ProjectRuntimesResponse, RuntimeId }

async function fail(response: Response, fallback: string): Promise<never> {
  const body = (await response.json().catch(() => ({}))) as { error?: string }
  throw new Error(body.error ?? fallback)
}

async function send(url: string, init: RequestInit, fallback: string): Promise<ProjectRuntimesResponse> {
  const response = await fetch(url, {
    credentials: "include",
    ...init,
    headers: init.body ? { "content-type": "application/json" } : undefined,
  })
  if (!response.ok) await fail(response, fallback)
  return (await response.json()) as ProjectRuntimesResponse
}

export function listRuntimes(hash: string): Promise<ProjectRuntimesResponse> {
  return send(`/api/projects/${hash}/runtimes`, {}, "Could not load the runtime versions.")
}

/** Saves the selection (`latest`, `system`, `8.4` or `8.4.12`); installs it when missing. */
export function selectRuntime(hash: string, id: RuntimeId, selection: string): Promise<ProjectRuntimesResponse> {
  return send(
    `/api/projects/${hash}/runtimes`,
    { method: "PUT", body: JSON.stringify({ runtimes: { [id]: selection } }) },
    "Could not save the runtime version.",
  )
}

/** Installs `version`, or -- without one -- the update the selection is waiting on. */
export function installRuntime(hash: string, id: RuntimeId, version?: string): Promise<ProjectRuntimesResponse> {
  return send(
    `/api/projects/${hash}/runtimes/${id}/install`,
    { method: "POST", body: JSON.stringify(version ? { version } : {}) },
    "Could not start the install.",
  )
}

export function uninstallRuntime(hash: string, id: RuntimeId, version: string): Promise<ProjectRuntimesResponse> {
  return send(
    `/api/projects/${hash}/runtimes/${id}/${encodeURIComponent(version)}`,
    { method: "DELETE" },
    "Could not remove that version.",
  )
}
