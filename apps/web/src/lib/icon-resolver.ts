"use client"

import type { IconKind } from "./file-icons"

/**
 * Batches "which icon is this name?" for every row rendered in the same
 * frame into one `/file-icons/resolve` request, and remembers the answers
 * for the life of the tab. See `app/file-icons/resolve/route.ts`.
 */
const answers = new Map<string, string>()
const waiting = new Map<string, Array<(id: string | null) => void>>()
let scheduled = false

export const ICON_VERSION = "5.38.1"

export function iconUrl(id: string): string {
  return `/file-icons/svg/${id}.svg?v=${ICON_VERSION}`
}

export function cachedIcon(kind: IconKind, name: string): string | undefined {
  return answers.get(keyOf(kind, name))
}

export function resolveIcon(kind: IconKind, name: string): Promise<string | null> {
  const key = keyOf(kind, name)
  const known = answers.get(key)
  if (known) return Promise.resolve(known)
  return new Promise((resolve) => {
    const list = waiting.get(key)
    if (list) list.push(resolve)
    else waiting.set(key, [resolve])
    if (!scheduled) {
      scheduled = true
      requestAnimationFrame(() => void flush())
    }
  })
}

function keyOf(kind: IconKind, name: string): string {
  return `${kind}:${encodeURIComponent(name)}`
}

async function flush(): Promise<void> {
  scheduled = false
  const batch = [...waiting.entries()]
  waiting.clear()
  for (let i = 0; i < batch.length; i += 200) {
    const chunk = batch.slice(i, i + 200)
    let resolved: Record<string, string> = {}
    try {
      const response = await fetch(`/file-icons/resolve?q=${chunk.map(([key]) => key).join(",")}`)
      if (response.ok) resolved = (await response.json()) as Record<string, string>
    } catch {
      // Unanswered rows fall back to asking by name.
    }
    for (const [key, callbacks] of chunk) {
      const id = resolved[key] ?? null
      if (id) answers.set(key, id)
      for (const callback of callbacks) callback(id)
    }
  }
}
