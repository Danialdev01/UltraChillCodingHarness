"use client"

import * as React from "react"
import { EditorContent, useEditor, type JSONContent } from "@tiptap/react"

import { buildExtensions } from "@/components/notes/extensions"
import type { Note } from "@/lib/notes-api"
import { titleOrUntitled } from "@/lib/note-tree"

export interface NoteReaderProps {
  note: Note
}

/**
 * One page, open for reading.
 *
 * The same Tiptap schema as the editor, with the document locked: that is
 * what keeps a callout, a table, a diagram or a linked page looking exactly
 * as its author saw it, since the very same node views draw them. Nothing
 * that writes is wired -- no slash menu, no block handles, no autosave --
 * and the extensions that own those are given handlers that do nothing.
 */
export function NoteReaderImpl({ note }: NoteReaderProps) {
  const extensions = React.useMemo(
    () =>
      buildExtensions(
        { context: { pickImage: () => {}, createPage: async () => "" }, onState: () => {}, onKeyDown: () => false },
        { onHover: () => {} },
      ),
    [],
  )
  const editor = useEditor(
    {
      immediatelyRender: false,
      editable: false,
      extensions,
      content: note.content as JSONContent,
      editorProps: { attributes: { class: "ucch-note-editor ucch-note-reader" } },
    },
    [note.id],
  )

  return (
    <div className="relative">
      {note.cover && (
        <div className="h-40 w-full md:h-56">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={note.cover} alt="" className="size-full object-cover" />
        </div>
      )}
      <div className="mx-auto w-full max-w-3xl px-8 pt-10 pb-32 md:px-12">
        {note.icon && <div className="mb-2 text-5xl leading-none">{note.icon}</div>}
        <h1 className="mb-6 text-3xl font-semibold tracking-tight">{titleOrUntitled(note.title)}</h1>
        <EditorContent editor={editor} />
      </div>
    </div>
  )
}
