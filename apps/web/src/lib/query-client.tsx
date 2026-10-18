"use client"

import * as React from "react"
import { QueryClient, type Query } from "@tanstack/react-query"
import { PersistQueryClientProvider } from "@tanstack/react-query-persist-client"
import { createAsyncStoragePersister } from "@tanstack/query-async-storage-persister"
import { del, get, keys, set } from "idb-keyval"

/**
 * The app's one client-side data cache.
 *
 * Every view that loads data reads it through a query (`lib/queries/*`), so a
 * page seen before paints from memory and only *revalidates* -- no skeleton,
 * no empty state flashing first. Realtime events update it in place
 * (`realtime-cache.ts`) instead of re-rendering the server layout.
 *
 * Queries marked `meta: { persist: true }` -- lists and trees, never file
 * contents -- are also kept in IndexedDB, per user, so a reload or an
 * installed app opens on yesterday's sidebar while today's is fetched. The
 * build id is the buster: a deploy that changes a response's shape starts
 * from empty rather than from a shape the new code cannot read.
 */

const PERSIST_MAX_AGE = 7 * 24 * 60 * 60 * 1000

function makeClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 24 * 60 * 60 * 1000,
        retry: 1,
        refetchOnWindowFocus: true,
      },
      mutations: { retry: 0 },
    },
  })
}

/** IndexedDB, guarded: a private window or blocked storage just means no persistence. */
const storage = {
  getItem: async (key: string) => {
    try {
      return (await get<string>(key)) ?? null
    } catch {
      return null
    }
  },
  setItem: async (key: string, value: string) => {
    try {
      await set(key, value)
    } catch {
      // Out of quota or blocked: the in-memory cache still works.
    }
  },
  removeItem: async (key: string) => {
    try {
      await del(key)
    } catch {
      // Nothing to remove, or nowhere to remove it from.
    }
  },
}

export const cacheKeyFor = (userId: string) => `ucch-cache:${userId}`

const shouldPersist = (query: Query) => query.meta?.persist === true && query.state.status === "success"

let browserClient: QueryClient | null = null

/** One client per tab, kept across the shell remounting. A fresh one per request on the server. */
export function getQueryClient(): QueryClient {
  if (typeof window === "undefined") return makeClient()
  browserClient ??= makeClient()
  return browserClient
}

export function QueryProvider({
  userId,
  buildId,
  children,
}: {
  userId: string
  buildId: string
  children: React.ReactNode
}) {
  const client = getQueryClient()
  const persister = React.useMemo(
    () => createAsyncStoragePersister({ storage, key: cacheKeyFor(userId), throttleTime: 1000 }),
    [userId],
  )
  return (
    <PersistQueryClientProvider
      client={client}
      persistOptions={{
        persister,
        maxAge: PERSIST_MAX_AGE,
        buster: buildId,
        dehydrateOptions: { shouldDehydrateQuery: shouldPersist },
      }}
    >
      {children}
    </PersistQueryClientProvider>
  )
}

/**
 * Forgets everything cached in this tab and every stored copy: on sign-out,
 * so the next person at this browser never sees the last one's projects.
 */
export async function clearUserCache(): Promise<void> {
  browserClient?.clear()
  try {
    for (const key of await keys()) {
      if (String(key).startsWith("ucch-cache:")) await del(key)
    }
  } catch {
    // Storage unavailable: there was nothing persisted to begin with.
  }
}
