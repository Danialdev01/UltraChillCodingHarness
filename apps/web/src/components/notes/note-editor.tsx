"use client"

import dynamic from "next/dynamic"

import type { NoteEditorProps } from "@/components/notes/note-editor-impl"
import { NotePageSkeleton } from "@/components/page-skeletons"

/**
 * The page editor, loaded on the client only.
 *
 * Tiptap and its schema are a good share of the notes page's JavaScript and
 * have no server rendering to offer -- the document is fetched on the client
 * anyway -- so the same treatment as the code editor: a dynamic import with
 * a placeholder the shape of a page -- the same one that stands in while the
 * page's shared document connects.
 */
export const NoteEditor = dynamic<NoteEditorProps>(
  () => import("@/components/notes/note-editor-impl").then((m) => m.NoteEditorImpl),
  {
    ssr: false,
    loading: () => <NotePageSkeleton />,
  },
)
