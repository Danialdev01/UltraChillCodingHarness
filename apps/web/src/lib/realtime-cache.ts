import type { DomainEvent, LiveResource } from "@ucch/protocol"
import type { QueryKey } from "@tanstack/react-query"

import { qk } from "./query-keys"

/**
 * What a realtime event makes stale in the client cache: the one place an
 * event is mapped to the views it changes, so no component has to register
 * its own refetch for data another person changed.
 *
 * Invalidating marks every cached copy stale -- the open views refetch at
 * once, the rest when next shown -- so a page visited later never paints a
 * version older than the event. No event renders the page again: what a
 * page shows that an event can change is in the cache (the shell's
 * bootstrap, the project's own copy).
 */
export interface CacheEffect {
  invalidate: QueryKey[]
  /**
   * Keys stale too, but refetched only after `HERD_MS` and some jitter
   * (`cacheSink`): changes every tab of a workspace hears at once and
   * none needs that instant. The sidebar shows a turn's start and end from
   * the events themselves (`useAgentActivity`), not from the bootstrap.
   */
  deferred?: QueryKey[]
}

const RESOURCES: Record<LiveResource, CacheEffect> = {
  // A rename is one of these: the project's own copy is stale too.
  projects: { invalidate: [qk.bootstrap(), qk.projects.all, qk.project.all] },
  database_connections: { invalidate: [qk.bootstrap(), qk.connections.all, qk.database.all] },
  database_data: { invalidate: [qk.database.all] },
  workspace_members: { invalidate: [qk.members.all, qk.bootstrap()] },
  keys: { invalidate: [qk.keys.all] },
  git: { invalidate: [qk.git.all] },
  account_settings: { invalidate: [qk.bootstrap()] },
  project_settings: { invalidate: [qk.tasks.all, qk.bootstrap(), qk.project.all] },
  // The diagram view follows its job itself (diagram-editor.tsx).
  diagrams: { invalidate: [] },
}

const NONE: CacheEffect = { invalidate: [] }

export function cacheEffect(event: DomainEvent): CacheEffect {
  switch (event.type) {
    case "resource.changed":
      return RESOURCES[event.resource] ?? NONE
    case "task.changed":
      return { invalidate: [qk.tasks.all] }
    case "timeline.changed":
      return { invalidate: [qk.timeline.all] }
    case "note.changed":
      return { invalidate: [qk.notes.all] }
    case "file.changed":
      return { invalidate: [qk.files.all, qk.git.all] }
    case "git.committed":
    case "git.pushed":
      return { invalidate: [qk.git.all] }
    // Turn edges reach every member's tab at once: their bootstrap refetch,
    // for the project list's counts and dots, waits and spreads out.
    case "thread.created":
    case "agent.turn_completed":
    case "agent.turn_failed":
      return { invalidate: [qk.sessions.all], deferred: [qk.bootstrap()] }
    case "thread.removed":
    case "thread.worktree_ready":
    case "thread.worktree_failed":
      return { invalidate: [qk.sessions.all, qk.bootstrap()] }
    default:
      return NONE
  }
}

/**
 * The bootstrap key is `["bootstrap", ws]`; invalidating by its first part
 * reaches every workspace's copy. Each key is reduced to its family prefix.
 */
export function prefixOf(key: QueryKey): QueryKey {
  return key[0] === "bootstrap" ? ["bootstrap"] : key
}

/** Other invalidations wait this long for the rest of their burst. */
export const BURST_MS = 200

/**
 * Deferred invalidations wait this long, plus up to `HERD_JITTER_MS`, so
 * the tabs of a busy workspace neither refetch on every turn edge nor all
 * in the same moment.
 */
export const HERD_MS = 3000
export const HERD_JITTER_MS = 2000

/**
 * Collects events' cache effects and invalidates their keys, each family
 * once per burst.
 *
 * `invalidate` keys go after `BURST_MS` of quiet. `deferred` keys go once
 * per window: the first one opens a window of `HERD_MS` plus jitter, and
 * the keys arriving inside it go with it. The window does not restart, so
 * a steady stream of turn ends still refetches every few seconds, never
 * more often than every `HERD_MS`.
 */
export function cacheSink(invalidate: (key: QueryKey) => void, random: () => number = Math.random) {
  const soon = new Map<string, QueryKey>()
  const later = new Map<string, QueryKey>()
  let soonTimer: ReturnType<typeof setTimeout> | undefined
  let laterTimer: ReturnType<typeof setTimeout> | undefined

  const add = (into: Map<string, QueryKey>, keys: QueryKey[] | undefined) => {
    for (const key of (keys ?? []).map(prefixOf)) into.set(JSON.stringify(key), key)
  }
  const flushSoon = () => {
    for (const [id, key] of soon) {
      invalidate(key)
      // Refetched now: the window has nothing left to do for it.
      later.delete(id)
    }
    soon.clear()
  }
  const flushLater = () => {
    laterTimer = undefined
    for (const key of later.values()) invalidate(key)
    later.clear()
  }

  return {
    push(effect: CacheEffect): void {
      if (effect.invalidate.length) {
        add(soon, effect.invalidate)
        clearTimeout(soonTimer)
        soonTimer = setTimeout(flushSoon, BURST_MS)
      }
      if (effect.deferred?.length) {
        add(later, effect.deferred)
        laterTimer ??= setTimeout(flushLater, HERD_MS + random() * HERD_JITTER_MS)
      }
    },
    dispose(): void {
      clearTimeout(soonTimer)
      clearTimeout(laterTimer)
    },
  }
}
