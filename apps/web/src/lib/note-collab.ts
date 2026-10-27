"use client"

import { useCollabDocument, type CollabDocument } from "@/lib/collab"

/**
 * A page's body, shared live with everyone who has it open.
 *
 * The collab service holds one Yjs document per open note (`note:{id}`) and
 * writes it back to the note row itself, so the editor no longer saves the
 * body: two people typing in one paragraph merge instead of one reverting
 * the other.
 *
 * Offline, Yjs keeps the edits in the document and sends them when the
 * socket is back -- the service keeps the note's document, so the copy here
 * merges back cleanly -- and `connected` says when that is not yet so.
 */
export type NoteCollab = CollabDocument

/** The field of the Yjs document Tiptap's Collaboration extension writes to. */
export const NOTE_FIELD = "default"

export function noteDocumentName(noteId: string): string {
  return `note:${noteId}`
}

/** Null until the server's copy has arrived: there is nothing true to show before. */
export function useNoteCollab(noteId: string): NoteCollab | null {
  return useCollabDocument(noteDocumentName(noteId)).shown
}
