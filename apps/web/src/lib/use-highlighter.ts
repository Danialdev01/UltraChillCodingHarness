"use client"

import * as React from "react"

import type { Token } from "@/lib/highlight-lines"

type Highlight = (code: string, path: string) => Token[][]

let loaded: Highlight | null = null
let loading: Promise<Highlight> | null = null

/**
 * The highlighter brings every CodeMirror grammar -- a quarter of the
 * conversation page's JavaScript -- so it is loaded when code is first
 * shown rather than with the page. Also in the idle preload (`preload.ts`).
 */
export function loadHighlighter(): Promise<Highlight> {
  return (loading ??= import("@/lib/highlight-lines").then(
    (m) => (loaded = m.highlightLines),
    (error: unknown) => {
      // Fetched again the next time code is shown.
      loading = null
      throw error
    },
  ))
}

/** The same lines without colours: what shows until the highlighter is here. */
const plain: Highlight = (code) => code.split("\n").map((text) => (text ? [{ text, cls: "" }] : []))

/** Colours code; plain text until the grammars have loaded, then the caller renders again. */
export function useHighlighter(): Highlight {
  const [highlight, setHighlight] = React.useState<Highlight | null>(() => loaded)
  React.useEffect(() => {
    if (highlight) return
    let live = true
    loadHighlighter().then(
      (fn) => live && setHighlight(() => fn),
      () => {},
    )
    return () => {
      live = false
    }
  }, [highlight])
  return highlight ?? plain
}
