"use client"

import * as React from "react"

/**
 * How far the boot preload has got, for whichever screen is showing it: the
 * sign-in boot screen, or the gate over a signed-in first load. The preload
 * (`lib/preload.ts`) writes it; the screens read it.
 */
export interface BootProgress {
  /** 0 to 1, never going back. */
  progress: number
  /** What is being loaded, in a few words. */
  label: string
  /** The app may open: everything is loaded, or the wait is over. */
  done: boolean
}

const INITIAL: BootProgress = { progress: 0.04, label: "Opening your workspace", done: false }

let state = INITIAL
const listeners = new Set<() => void>()

export function publishBoot(patch: Partial<BootProgress>): void {
  const progress = Math.max(state.progress, Math.min(1, patch.progress ?? state.progress))
  state = { ...state, ...patch, progress }
  for (const listener of listeners) listener()
}

/** Back to the start, for a boot that begins after an earlier one finished. */
export function resetBoot(): void {
  state = INITIAL
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

export function useBootProgress(): BootProgress {
  return React.useSyncExternalStore(
    subscribe,
    () => state,
    () => INITIAL,
  )
}
