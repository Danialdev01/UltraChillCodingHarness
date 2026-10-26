"use client"

import * as React from "react"
import { useQueryClient, type QueryKey } from "@tanstack/react-query"

import { prefixOf } from "@/lib/realtime-cache"

/**
 * Marks cached reads stale after this tab changed what they show, the way
 * the realtime bridge does for everyone else's changes: the views reading
 * them refetch, and nothing is rendered on the server again. Bootstrap keys
 * reach every workspace's copy.
 */
export function useInvalidate(): (...keys: QueryKey[]) => void {
  const queryClient = useQueryClient()
  return React.useCallback(
    (...keys: QueryKey[]) => {
      for (const key of keys) void queryClient.invalidateQueries({ queryKey: prefixOf(key) })
    },
    [queryClient],
  )
}
