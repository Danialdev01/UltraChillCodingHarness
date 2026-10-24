"use client"

import * as React from "react"
import { useQuery, useQueryClient } from "@tanstack/react-query"

import { qk } from "@/lib/query-keys"
import type { Project } from "@/lib/session"

/**
 * One project as its pages show it -- name, preview port and address, and
 * the rest of the single-project shape. The server renders the page with it
 * and seeds it here (`ProjectSeed`), and from then on it is a query like any
 * other: a rename or a preview-port change in another tab invalidates it
 * (`realtime-cache.ts`) and the page shows the new copy without being
 * rendered again.
 */
export async function fetchProject(hash: string): Promise<Project> {
  const response = await fetch(`/api/projects/${hash}`, { credentials: "include" })
  if (!response.ok) throw new Error(`project failed: ${response.status}`)
  return (await response.json()) as Project
}

/** Puts the server's copy of the project into the cache before the page below reads it. */
export function ProjectSeed({ data }: { data: Project }) {
  const client = useQueryClient()
  // As `BootstrapSeed`: during render, so the page's first render finds it,
  // and only over a copy older than this render, so a server render that
  // lost a race with a realtime event never wins.
  const seeded = React.useRef(false)
  if (!seeded.current) {
    seeded.current = true
    const state = client.getQueryState(qk.project(data.hash))
    if (!state || state.dataUpdatedAt < Date.now() - 1000) client.setQueryData(qk.project(data.hash), data)
  }
  return null
}

/** The project, live: the cache's copy, which `ProjectSeed` fills and events keep current. */
export function useProject(hash: string): Project | undefined {
  return useQuery({ queryKey: qk.project(hash), queryFn: () => fetchProject(hash) }).data
}
