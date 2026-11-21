"use client"

import { useSyncExternalStore } from "react"

/**
 * The open conversation's context reading, for the session card beside the
 * chat: the composer measures it, the card shows it as a bar on wide
 * screens (where the composer's ring is hidden). Same shape as the meter's
 * props, so both draw from one reading.
 */
export interface ContextReading {
  tokens: number | null
  limit: number | null
  threshold: number | null
  live: boolean
  handingOver: boolean
  disabled: boolean
  disabledReason: string | null
}

let reading: ContextReading | null = null
let handover: () => void = () => {}
const listeners = new Set<() => void>()

function same(a: ContextReading | null, b: ContextReading | null): boolean {
  if (a === b) return true
  if (!a || !b) return false
  return (Object.keys(a) as (keyof ContextReading)[]).every((key) => a[key] === b[key])
}

/** Null when no conversation is open. `onHandover` is kept, not compared. */
export function publishContextReading(next: ContextReading | null, onHandover?: () => void) {
  if (onHandover) handover = onHandover
  if (same(reading, next)) return
  reading = next
  for (const listener of listeners) listener()
}

/** Starts a handover in the conversation that published the reading. */
export function requestHandover() {
  handover()
}

export function useContextReading(): ContextReading | null {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => reading,
    () => null,
  )
}
