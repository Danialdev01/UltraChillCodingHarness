"use client"

import { useSyncExternalStore } from "react"

/**
 * Each open conversation's context reading, for the session card beside
 * the chat: the composer measures it, the card shows it as a bar on wide
 * screens (where the composer's ring is hidden). Same shape as the meter's
 * props, so both draw from one reading. Kept per thread (plan2 §1.6): two
 * chats on one page each show their own, and a card never shows the
 * reading of a thread it is not beside.
 */
export interface ContextReading {
  tokens: number | null
  limit: number | null
  threshold: number | null
  live: boolean
  /** The provider said it could not measure the context: shown as unknown, never 0. */
  unknown: boolean
  /** When the session's prompt cache runs out, ISO, or null when nobody knows. */
  cacheExpiresAt: string | null
  handingOver: boolean
  disabled: boolean
  disabledReason: string | null
}

const readings = new Map<string, ContextReading>()
const handovers = new Map<string, () => void>()
const listeners = new Set<() => void>()

function same(a: ContextReading | null | undefined, b: ContextReading | null | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (Object.keys(a) as (keyof ContextReading)[]).every((key) => a[key] === b[key])
}

/** Null when the conversation closes. `onHandover` is kept, not compared. */
export function publishContextReading(threadId: string, next: ContextReading | null, onHandover?: () => void) {
  if (onHandover) handovers.set(threadId, onHandover)
  if (!next) handovers.delete(threadId)
  if (same(readings.get(threadId), next)) return
  if (next) readings.set(threadId, next)
  else readings.delete(threadId)
  for (const listener of listeners) listener()
}

/** Starts a handover in the conversation that published the reading. */
export function requestHandover(threadId: string) {
  handovers.get(threadId)?.()
}

export function useContextReading(threadId: string | null | undefined): ContextReading | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => (threadId ? (readings.get(threadId) ?? null) : null),
    () => null,
  )
}
