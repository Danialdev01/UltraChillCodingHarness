"use client"

import * as React from "react"
import { createPortal } from "react-dom"

import { useFilesPanel } from "@/components/files-panel"

/**
 * One chat, two places it can be shown.
 *
 * The conversation holds the project's WebSocket subscription and everything
 * derived from it, so it is mounted once and never moved in React's tree --
 * remounting it would tear down the socket and replay the event log. What
 * moves is its DOM: the chat renders through a portal into a detached
 * element that the provider owns, and whichever `ChatDock` is on screen pulls
 * that element into itself. React never sees the move; the socket, the
 * draft, the scroll position and the composer's refs all survive it.
 *
 * Only one dock is rendered at a time, by construction in the workspace and
 * the sidebar: two would fight over the element.
 */
export function ChatPortal({ children }: { children: React.ReactNode }) {
  const { chatDock } = useFilesPanel()
  // Nothing on the server: the element is created in the browser, and the
  // chat has nothing to show before its socket is open anyway.
  return chatDock ? createPortal(children, chatDock) : null
}

/** Where the chat's element currently lives. */
export function ChatDock({ className }: { className?: string }) {
  const { chatDock } = useFilesPanel()
  const host = React.useRef<HTMLDivElement>(null)

  React.useEffect(() => {
    const parent = host.current
    if (!parent || !chatDock) return
    parent.appendChild(chatDock)
    return () => {
      // Detached rather than removed: the chat inside is still mounted and
      // the next dock to appear picks it up from here.
      if (chatDock.parentNode === parent) parent.removeChild(chatDock)
    }
  }, [chatDock])

  return <div ref={host} className={className} />
}
