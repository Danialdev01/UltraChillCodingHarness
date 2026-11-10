"use client"

/**
 * What a widget needs from the chat it sits in, handed down through context
 * because widgets are drawn deep inside Markdown, whose component map is
 * static: whether widgets run at all (the workspace's "Allow interactive
 * widgets"), and a way to put text in the composer or send it.
 *
 * Outside a chat (no provider) widgets still run; the composer actions are
 * simply absent and their buttons hidden.
 */

import * as React from "react"

export interface WidgetHost {
  /** False: widgets show as code. */
  enabled: boolean
  /** Puts text in the composer and focuses it. */
  insert?: (text: string) => void
  /** Sends text as the next message. */
  send?: (text: string) => void
}

const WidgetHostContext = React.createContext<WidgetHost>({ enabled: true })

export const WidgetHostProvider = WidgetHostContext.Provider

export function useWidgetHost(): WidgetHost {
  return React.useContext(WidgetHostContext)
}
