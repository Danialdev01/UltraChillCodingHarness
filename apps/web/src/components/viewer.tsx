"use client"

import * as React from "react"

/**
 * Who is signed in, for the client components that address them by name.
 *
 * The session is read on the server by the app shell; this hands the one
 * field the client needs down to it, instead of each component fetching the
 * session again for a first name.
 */
const ViewerContext = React.createContext<{ name: string } | null>(null)

export function ViewerProvider({ name, children }: { name: string; children: React.ReactNode }) {
  const value = React.useMemo(() => ({ name }), [name])
  return <ViewerContext.Provider value={value}>{children}</ViewerContext.Provider>
}

/** The viewer's first name, or null outside the app shell. */
export function useViewerFirstName(): string | null {
  const viewer = React.useContext(ViewerContext)
  return viewer?.name.trim().split(/\s+/)[0] || null
}
