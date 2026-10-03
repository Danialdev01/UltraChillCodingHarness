"use client"

import * as React from "react"
import { Tldraw, getSnapshot, loadSnapshot, type Editor, type TLEditorSnapshot } from "tldraw"
import "tldraw/tldraw.css"

/**
 * The whiteboard itself, in its own module so the whole of tldraw is loaded
 * only when a page has one -- it is larger than the rest of the editor put
 * together.
 *
 * Without a licence key tldraw draws a small "made with tldraw" badge. The
 * key is a build-time public value (`NEXT_PUBLIC_TLDRAW_LICENSE_KEY`), unset
 * in development.
 */
export function TldrawFrame({
  snapshot,
  dark,
  onChange,
}: {
  snapshot: TLEditorSnapshot | null
  dark: boolean
  onChange(snapshot: TLEditorSnapshot): void
}) {
  const onChangeRef = React.useRef(onChange)
  onChangeRef.current = onChange

  const onMount = React.useCallback(
    (editor: Editor) => {
      if (snapshot) loadSnapshot(editor.store, snapshot)
      let handle: ReturnType<typeof setTimeout> | null = null
      // Only the document, and only the person's own edits: camera moves
      // and selection are not worth a save, and loading is not a change.
      const stop = editor.store.listen(
        () => {
          if (handle) clearTimeout(handle)
          handle = setTimeout(() => onChangeRef.current(getSnapshot(editor.store)), 600)
        },
        { scope: "document", source: "user" },
      )
      return () => {
        stop()
        if (handle) clearTimeout(handle)
      }
    },
    // The snapshot is loaded once, on mount; later ones come from this frame.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [],
  )

  return (
    <Tldraw
      onMount={onMount}
      colorScheme={dark ? "dark" : "light"}
      licenseKey={process.env.NEXT_PUBLIC_TLDRAW_LICENSE_KEY}
      autoFocus={false}
    />
  )
}
