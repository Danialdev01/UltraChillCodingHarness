"use client"

import * as React from "react"
import { useQuery, useQueryClient, type QueryKey } from "@tanstack/react-query"

/**
 * A view's server data as cached state: the shape the views already had --
 * `[data, setData, reload]`, data null until first loaded -- backed by the
 * client cache instead of component state.
 *
 * What that buys, without touching how a view uses its data:
 *   - coming back to a page paints what it showed last time at once, then
 *     revalidates, instead of starting from a skeleton;
 *   - two views of the same data (the board and the sidebar's count) share
 *     one copy and one request;
 *   - `setData` is the optimistic update a view already made after its own
 *     change, now visible everywhere that reads the key;
 *   - with `persist`, a reload or a reopened app starts from the last copy.
 */
export function useCachedState<T>(
  queryKey: QueryKey,
  fetcher: () => Promise<T>,
  options: { persist?: boolean; enabled?: boolean; refetchInterval?: number | false } = {},
): [
  T | null,
  (update: T | ((current: T | null) => T)) => void,
  () => Promise<void>,
  { error: Error | null; fetching: boolean },
] {
  const client = useQueryClient()
  const query = useQuery({
    queryKey,
    queryFn: fetcher,
    enabled: options.enabled ?? true,
    refetchInterval: options.refetchInterval,
    meta: options.persist ? { persist: true } : undefined,
  })
  const keyRef = React.useRef(queryKey)
  keyRef.current = queryKey

  const setData = React.useCallback(
    (update: T | ((current: T | null) => T)) => {
      client.setQueryData<T>(keyRef.current, (current) =>
        typeof update === "function" ? (update as (c: T | null) => T)(current ?? null) : update,
      )
    },
    [client],
  )
  const reload = React.useCallback(async () => {
    await client.invalidateQueries({ queryKey: keyRef.current, exact: true })
  }, [client])

  return [query.data ?? null, setData, reload, { error: query.error, fetching: query.isFetching }]
}
