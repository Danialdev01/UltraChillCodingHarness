/**
 * Framework profiles over the API (plan3). The profiles themselves come from
 * `@ucch/protocol/plain`; the server adds what it can do (`/api/frameworks`)
 * and what a project chose (`/api/projects/:hash/framework`). Changing a
 * project's framework is the `project.framework_set` command.
 */

import type { FrameworksResponse, ProjectFrameworkResponse } from "@ucch/protocol"

export type { FrameworksResponse, ProjectFrameworkResponse }

async function get<T>(url: string, fallback: string): Promise<T> {
  const response = await fetch(url, { credentials: "include" })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(body.error ?? fallback)
  }
  return (await response.json()) as T
}

export function fetchFrameworks(): Promise<FrameworksResponse> {
  return get("/api/frameworks", "Could not load what this server can set up.")
}

export function fetchProjectFramework(hash: string): Promise<ProjectFrameworkResponse> {
  return get(`/api/projects/${hash}/framework`, "Could not load the project's framework.")
}
