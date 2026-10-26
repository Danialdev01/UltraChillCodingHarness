"use client"

import * as React from "react"
import { HocuspocusProvider } from "@hocuspocus/provider"

import { websocketOrigin } from "@/lib/client"

/**
 * A page's body, shared live with everyone who has it open.
 *
 * The collab service holds one Yjs document per open note (`note:{id}`) and
 * writes it back to the note row itself, so the editor no longer saves the
 * body: two people typing in one paragraph merge instead of one reverting
 * the other. Each connection is signed in with a fresh one-time ticket, the
 * same kind the realtime socket uses -- asked for again on every reconnect,
 * since a ticket is good once.
 *
 * Offline, Yjs keeps the edits in the document and sends them when the
 * socket is back; `connected` says when that is not yet so.
 */
export interface NoteCollab {
  provider: HocuspocusProvider
  /** The server's copy has arrived at least once: safe to show the page. */
  synced: boolean
  connected: boolean
  /** Edits made here the server has not yet confirmed. */
  unsynced: number
  /** Viewers, and tokens without write scope, get the page but cannot change it. */
  readOnly: boolean
}

/** The field of the Yjs document Tiptap's Collaboration extension writes to. */
export const NOTE_FIELD = "default"

export function noteDocumentName(noteId: string): string {
  return `note:${noteId}`
}

async function collabTicket(): Promise<string> {
  const response = await fetch("/api/ws-ticket", { method: "POST", credentials: "include" })
  if (!response.ok) throw new Error(`ticket request failed: ${response.status}`)
  return ((await response.json()) as { ticket: string }).ticket
}

/**
 * Opens the page's shared document for as long as the component is mounted.
 * Null until the provider exists (the first effect), so React's double
 * mount in development opens and closes one rather than leaking it.
 */
export function useNoteCollab(noteId: string): NoteCollab | null {
  const [state, setState] = React.useState<NoteCollab | null>(null)

  React.useEffect(() => {
    let gone = false
    const provider = new HocuspocusProvider({
      url: `${websocketOrigin()}/collab`,
      name: noteDocumentName(noteId),
      token: collabTicket,
    })
    // `isSynced` drops back to false while reconnecting; once the page has
    // been shown it stays shown, with the banner saying it is offline.
    const seen = { synced: false, connected: false }
    const read = (): NoteCollab => ({
      provider,
      synced: provider.isSynced || seen.synced,
      connected: seen.connected,
      unsynced: provider.unsyncedChanges,
      readOnly: provider.authorizedScope === "readonly",
    })
    const update = () => {
      if (!gone) setState(read())
    }
    provider.on("synced", ({ state }: { state: boolean }) => {
      if (state) seen.synced = true
      update()
    })
    provider.on("status", ({ status }: { status: string }) => {
      seen.connected = status === "connected"
      update()
    })
    provider.on("unsyncedChanges", update)
    provider.on("authenticated", update)
    update()
    return () => {
      gone = true
      provider.destroy()
    }
  }, [noteId])

  return state
}
