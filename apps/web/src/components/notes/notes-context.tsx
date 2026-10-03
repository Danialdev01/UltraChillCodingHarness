"use client"

import * as React from "react"

import type { NoteSummary } from "@/lib/notes-api"

/**
 * What every part of the notes workspace reads: the project, the tree, and
 * the few things a block inside the editor may need to do to it.
 *
 * A context rather than props because the page-link block is rendered by
 * Tiptap, deep inside the editor, and still has to show a live title and
 * create a page.
 */
export interface NotesContextValue {
  hash: string
  /** Every page, flat. Empty until the first list arrives. */
  notes: NoteSummary[]
  rootId: string | null
  /** The page open in the editor. */
  activeId: string | null
  /** Makes a page under `parentId` and returns it. The tree updates at once. */
  createPage(parentId: string, title?: string): Promise<NoteSummary>
  /** Opens a page. */
  open(noteId: string): void
}

const NotesContext = React.createContext<NotesContextValue | null>(null)

export const NotesProvider = NotesContext.Provider

/** Throws outside the workspace, which is a bug rather than a state. */
export function useNotes(): NotesContextValue {
  const value = React.useContext(NotesContext)
  if (!value) throw new Error("useNotes must be used inside the notes workspace")
  return value
}
