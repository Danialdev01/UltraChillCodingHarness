"use client"

import * as React from "react"
import { usePathname, useRouter, useSearchParams } from "next/navigation"

/**
 * The open tab, kept in `?tab=` so a view is a URL the way it is in
 * phpMyAdmin: a link to a table's structure opens its structure.
 *
 * Replaced rather than pushed, so the back button leaves the database
 * rather than stepping back through every tab visited on it. Anything the
 * list does not know falls back to the first tab, so a stale link still
 * lands somewhere.
 */
export function useTab<const T extends readonly string[]>(tabs: T): [T[number], (tab: T[number]) => void] {
  const pathname = usePathname()
  const router = useRouter()
  const params = useSearchParams()
  const wanted = params.get("tab")
  const tab = (tabs as readonly string[]).includes(wanted ?? "") ? (wanted as T[number]) : tabs[0]!

  const setTab = React.useCallback(
    (next: T[number]) => {
      const search = new URLSearchParams(params.toString())
      if (next === tabs[0]) search.delete("tab")
      else search.set("tab", next)
      const query = search.toString()
      router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false })
    },
    [params, pathname, router, tabs],
  )

  return [tab, setTab]
}
