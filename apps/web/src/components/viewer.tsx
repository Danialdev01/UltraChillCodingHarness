"use client"

import * as React from "react"

import { useMe } from "@/lib/queries/bootstrap"

/**
 * Who is signed in, for the client components that address them by name.
 *
 * The session is read on the server by the app shell, which hands its name
 * down; from then on the shell's cached bootstrap has the live one, so a
 * renamed account reads right without each component fetching the session
 * again for a first name.
 */
const ViewerContext = React.createContext<{ name: string } | null>(null)

export function ViewerProvider({ name: initial, children }: { name: string; children: React.ReactNode }) {
  const me = useMe()
  const name = me ? (me.name ?? me.login ?? "User") : initial
  const value = React.useMemo(() => ({ name }), [name])
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>
}

/** The viewer's first name, or null outside the app shell. */
export function useViewerFirstName(): string | null {
  const viewer = React.useContext(ViewerContext)
  return viewer?.name.trim().split(/\s+/)[0] || null
}
