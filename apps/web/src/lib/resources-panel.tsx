"use client"

import * as React from "react"

const STORAGE_KEY = "ucch:resources-open"

interface ResourcesPanelValue {
  /** The sidebar's second column shows Resources rather than the section's own panel. */
  open: boolean
  setOpen: (open: boolean) => void
  toggle: () => void
}

const ResourcesPanelContext = React.createContext<ResourcesPanelValue>({
  open: false,
  setOpen: () => {},
  toggle: () => {},
})

/**
 * Whether the Resources browser is in the sidebar.
 *
 * State rather than a route, unlike every other rail icon: Resources is
 * opened beside whatever page you are on -- the chat stays put, and its
 * files are dragged into it -- so changing the URL would defeat the point.
 * Remembered per browser, so a reload keeps the sidebar as it was.
 */
export function ResourcesPanelProvider({ children }: { children: React.ReactNode }) {
  const [open, setOpenState] = React.useState(false)

  React.useEffect(() => {
    try {
      if (window.localStorage.getItem(STORAGE_KEY) === "1") setOpenState(true)
    } catch {
      // Storage blocked: start closed.
    }
  }, [])

  const setOpen = React.useCallback((next: boolean) => {
    setOpenState(next)
    try {
      window.localStorage.setItem(STORAGE_KEY, next ? "1" : "0")
    } catch {
      // Only a convenience.
    }
  }, [])

  const value = React.useMemo(
    () => ({ open, setOpen, toggle: () => setOpen(!open) }),
    [open, setOpen],
  )
  return <ResourcesPanelContext.Provider value={value}>{children}</ResourcesPanelContext.Provider>
}

export function useResourcesPanel(): ResourcesPanelValue {
  return React.useContext(ResourcesPanelContext)
}
