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
 * version older than the event. Returns the keys, and whether the
 * server-rendered page itself has to be rendered again (settings that only
 * the server reads).
 */
export interface CacheEffect {
  invalidate: QueryKey[]
  refreshPage: boolean
}

const RESOURCES: Record<LiveResource, CacheEffect> = {
  projects: { invalidate: [qk.bootstrap(), qk.projects.all], refreshPage: false },
  database_connections: { invalidate: [qk.bootstrap(), qk.connections.all, qk.database.all], refreshPage: false },
  database_data: { invalidate: [qk.database.all], refreshPage: false },
  workspace_members: { invalidate: [qk.members.all, qk.bootstrap()], refreshPage: false },
  keys: { invalidate: [qk.keys.all], refreshPage: false },
  git: { invalidate: [qk.git.all], refreshPage: false },
  account_settings: { invalidate: [qk.bootstrap()], refreshPage: true },
  project_settings: { invalidate: [qk.tasks.all, qk.bootstrap()], refreshPage: true },
}

const NONE: CacheEffect = { invalidate: [], refreshPage: false }

export function cacheEffect(event: DomainEvent): CacheEffect {
  switch (event.type) {
    case "resource.changed":
      return RESOURCES[event.resource] ?? NONE
    case "task.changed":
      return { invalidate: [qk.tasks.all], refreshPage: false }
    case "timeline.changed":
      return { invalidate: [qk.timeline.all], refreshPage: false }
    case "note.changed":
      return { invalidate: [qk.notes.all], refreshPage: false }
    case "file.changed":
      return { invalidate: [qk.files.all, qk.git.all], refreshPage: false }
    case "git.committed":
    case "git.pushed":
      return { invalidate: [qk.git.all], refreshPage: false }
    case "thread.created":
    case "thread.removed":
    case "thread.worktree_ready":
    case "thread.worktree_failed":
    case "agent.turn_completed":
    case "agent.turn_failed":
      return { invalidate: [qk.sessions.all, qk.bootstrap()], refreshPage: false }
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
