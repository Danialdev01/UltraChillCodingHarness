"use client"

import * as React from "react"
import { HocuspocusProvider } from "@hocuspocus/provider"

import { websocketOrigin } from "@/lib/client"
import { personColor } from "@/lib/person-color"
import { useMe } from "@/lib/queries/bootstrap"
import { useRealtime } from "@/lib/realtime"

/**
 * A document shared live through the collab service (`/collab`), for as
 * long as the component asking for it is mounted.
 *
 * Each connection signs in with a fresh one-time ticket, the same kind the
 * realtime socket uses -- asked for again on every reconnect, since a ticket
 * is good once.
 */
export interface CollabDocument {
  provider: HocuspocusProvider
  /** Bumped each time a fresh copy replaces the one shown, so an editor binds to it anew. */
  generation: number
  /** Synced and connected: edits made now reach the others. */
  connected: boolean
  /** Edits made here the server has not yet confirmed. */
  unsynced: number
  /** Viewers, and tokens without write scope, see the edits but make none. */
  readOnly: boolean
}

export interface CollabState {
  /** The copy on screen: the last one synced, or null before the first. */
  shown: CollabDocument | null
  /** Refused -- not allowed, not a document -- or not reached in time: work without it. */
  failed: boolean
}

export interface CollabOptions {
  /**
   * A new document for every connection, rather than the provider's own
   * reconnect with the one it had. For documents the service does not keep
   * (files: the disk is the state): a document reopened from disk is made
   * of new items, and an old copy sent back to it would merge in beside
   * them, doubling the text. Editing pauses while disconnected instead.
   */
  fresh?: boolean
  /** Not synced by then: `failed`, so the caller can fall back to its own saving. */
  giveUpAfterMs?: number
}

async function collabTicket(): Promise<string> {
  const response = await fetch("/api/ws-ticket", { method: "POST", credentials: "include" })
  if (!response.ok) throw new Error(`ticket request failed: ${response.status}`)
  return ((await response.json()) as { ticket: string }).ticket
}

const NOTHING: CollabState = { shown: null, failed: false }

/** Opens `name` (null opens nothing). See `CollabDocument`. */
export function useCollabDocument(name: string | null, options: CollabOptions = {}): CollabState {
  const { fresh = false, giveUpAfterMs } = options
  const [state, setState] = React.useState<CollabState>(NOTHING)

  React.useEffect(() => {
    setState(NOTHING)
    if (!name) return
    let gone = false
    let generation = 0
    let shown: CollabDocument | null = null
    let failed = false
    const open = new Set<HocuspocusProvider>()
    const publish = () => {
      if (!gone) setState({ shown, failed })
    }

    const connect = () => {
      const provider = new HocuspocusProvider({ url: `${websocketOrigin()}/collab`, name, token: collabTicket })
      open.add(provider)
      const mine = ++generation
      let synced = false
      let status = "connecting"
      const describe = (): CollabDocument => ({
        provider,
        generation: mine,
        connected: synced && status === "connected",
        unsynced: provider.unsyncedChanges,
        readOnly: provider.authorizedScope === "readonly",
      })
      const update = () => {
        if (shown?.provider !== provider) return
        shown = describe()
        publish()
      }
      const drop = (old: HocuspocusProvider) => {
        old.destroy()
        open.delete(old)
      }

      provider.on("synced", ({ state: done }: { state: boolean }) => {
        if (!done) return
        if (!synced) {
          // `isSynced` drops back while reconnecting; once a copy has been
          // shown it stays shown, with `connected` saying it is out of touch.
          synced = true
          window.clearTimeout(giveUp)
          const old = shown?.provider
          shown = describe()
          if (old && old !== provider) drop(old)
          publish()
          return
        }
        update()
      })
      provider.on("status", ({ status: next }: { status: string }) => {
        status = next
        update()
        if (fresh && synced && next === "disconnected" && shown?.provider === provider) {
          // Stays on screen, read-only, until a fresh copy has synced.
          provider.destroy()
          open.delete(provider)
          connect()
        }
      })
      provider.on("unsyncedChanges", update)
      provider.on("authenticated", update)
      provider.on("authenticationFailed", () => {
        if (synced) return
        failed = true
        drop(provider)
        publish()
      })
    }

    const giveUp =
      giveUpAfterMs === undefined
        ? undefined
        : window.setTimeout(() => {
            if (shown) return
            failed = true
            for (const provider of open) provider.destroy()
            open.clear()
            publish()
          }, giveUpAfterMs)
    connect()
    return () => {
      gone = true
      window.clearTimeout(giveUp)
      for (const provider of open) provider.destroy()
    }
  }, [name, fresh, giveUpAfterMs])

  return state
}

/**
 * Who this tab is to the others in a shared document: the name and colour
 * their editors draw its caret with -- the same colour as this person's
 * ring in a presence stack.
 */
export function useCollabUser(): { name: string; color: string; colorLight: string } {
  const me = useMe()
  const userId = useRealtime().client?.userId ?? ""
  const name = me?.name ?? me?.login ?? "Someone"
  return React.useMemo(() => {
    const color = personColor(userId)
    return { name, color, colorLight: `color-mix(in oklch, ${color} 25%, transparent)` }
  }, [name, userId])
}

/** A file's document: `file:{projectId}:{worktreeId}:{path}`, the worktree "" for the checkout. */
export function fileDocumentName(projectId: string, worktreeId: string | null | undefined, path: string): string {
  return `file:${projectId}:${worktreeId ?? ""}:${path}`
}

/** The `Y.Text` a file's document keeps its text in. */
export const FILE_FIELD = "text"
