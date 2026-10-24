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
    case "thread.created":
    case "thread.removed":
    case "thread.worktree_ready":
    case "thread.worktree_failed":
    case "agent.turn_completed":
    case "agent.turn_failed":
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
