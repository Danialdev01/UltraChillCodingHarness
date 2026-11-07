"use client"

import * as React from "react"

/**
 * The project keys this tab has unlocked, in memory only.
 *
 * Never in storage, a cookie or the query cache: a reload, closing the tab
 * or `lock` forgets them, and so does `IDLE_MS` without a use. Module state
 * rather than React state so leaving the documentation for another page and
 * coming back does not ask again.
 */

/** An unlocked key is forgotten after this long without being used. */
export const IDLE_MS = 15 * 60_000

interface Entry {
  key: string
  timer: ReturnType<typeof setTimeout>
}

const entries = new Map<string, Entry>()
const listeners = new Set<() => void>()

function emit() {
  for (const listener of listeners) listener()
}

function arm(hash: string, key: string) {
  const current = entries.get(hash)
  if (current) clearTimeout(current.timer)
  entries.set(hash, { key, timer: setTimeout(() => lockProject(hash), IDLE_MS) })
}

export function unlockProject(hash: string, key: string): void {
  arm(hash, key)
  emit()
}

export function lockProject(hash: string): void {
  const current = entries.get(hash)
  if (!current) return
  clearTimeout(current.timer)
  entries.delete(hash)
  emit()
}

/** The unlocked key, which counts as a use: the idle timer starts over. */
export function takeKey(hash: string): string | null {
  const current = entries.get(hash)
  if (!current) return null
  arm(hash, current.key)
  return current.key
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Whether `hash` is unlocked in this tab, re-rendering when that changes. */
export function useProjectUnlocked(hash: string): boolean {
  return React.useSyncExternalStore(
    subscribe,
    () => entries.has(hash),
    () => false,
  )
}
