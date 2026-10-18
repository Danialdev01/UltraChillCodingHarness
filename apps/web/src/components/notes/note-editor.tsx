"use client"

import dynamic from "next/dynamic"

import type { NoteEditorProps } from "@/components/notes/note-editor-impl"
import { Skeleton } from "@/components/ui/skeleton"

/**
 * The page editor, loaded on the client only.
 *
 * Tiptap and its schema are a good share of the notes page's JavaScript and
 * have no server rendering to offer -- the document is fetched on the client
 * anyway -- so the same treatment as the code editor: a dynamic import with
 * a placeholder the shape of a page.
 */
export const NoteEditor = dynamic<NoteEditorProps>(
  () => import("@/components/notes/note-editor-impl").then((m) => m.NoteEditorImpl),
  {
    ssr: false,
    loading: () => (
      <div className="mx-auto w-full max-w-[var(--ucch-doc-width,48rem)] px-8 py-12">
        <Skeleton className="mb-6 h-9 w-2/5" />
        <Skeleton className="mb-3 h-4 w-full" />
        <Skeleton className="h-4 w-3/5" />
      </div>
    ),
  },
)
