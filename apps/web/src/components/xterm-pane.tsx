"use client"

import * as React from "react"
import { FitAddon } from "@xterm/addon-fit"
import { WebLinksAddon } from "@xterm/addon-web-links"
import { Terminal } from "@xterm/xterm"

import "@xterm/xterm/css/xterm.css"

import { useTheme } from "@/components/theme-provider"
import { ansiPalette } from "@/lib/color-engine"
import type { TerminalOutput } from "@/lib/terminal-output"
import type { Mode, Tokens } from "@/lib/theme"

/**
 * One xterm.js screen, wired to a session on the server.
 *
 * The terminal here does no interpreting of its own. Keystrokes go out as
 * bytes and output comes back as bytes; escape sequences, line editing, the
 * alternate screen and the cursor are all handled by the shell on one end and
 * the emulator on the other, which is what makes vim and top work rather than
 * a list of features that had to be implemented.
 *
 * The instance is created once and kept in a ref. React never re-renders it:
 * a terminal holds tens of thousands of lines of scrollback and a cursor
 * position, and rebuilding that on a parent's render would lose both.
 */
export function XtermPane({
  hidden,
  data,
  onInput,
  onResize,
}: {
  hidden: boolean
  /** Output as it arrives. Each chunk is written once, in order. */
  data: TerminalOutput
  onInput: (data: string) => void
  onResize: (cols: number, rows: number) => void
}) {
  const host = React.useRef<HTMLDivElement>(null)
  const terminal = React.useRef<Terminal | null>(null)
  const fit = React.useRef<FitAddon | null>(null)
  /** How many chunks of `data.total` have been written, so nothing is written twice. */
  const written = React.useRef(0)

  // The callbacks are read through refs so the terminal can be created once
  // and never torn down when a parent re-renders with new closures.
  const handlers = React.useRef({ onInput, onResize })
  handlers.current = { onInput, onResize }

  const { tokens, resolvedMode } = useTheme()
  const theme = React.useMemo(() => xtermTheme(tokens, resolvedMode), [tokens, resolvedMode])
  // Read at creation through a ref, so the terminal is still created once.
  const themeRef = React.useRef(theme)
  themeRef.current = theme

  React.useEffect(() => {
    const element = host.current
    if (!element) return

    const term = new Terminal({
      // From the app's own tokens, so a terminal follows the theme rather
      // than being the one black rectangle in a light interface.
      theme: themeRef.current,
      fontFamily: "var(--app-font-mono), ui-monospace, monospace",
      fontSize: 13,
      lineHeight: 1.2,
      cursorBlink: true,
      // Enough to hold a build log without holding a session's whole life.
      scrollback: 10_000,
      // The shell draws its own selection and the OS draws ours; letting
      // xterm scroll on every keystroke fights both.
      convertEol: false,
      allowProposedApi: true,
    })

    const fitAddon = new FitAddon()
    term.loadAddon(fitAddon)
    term.loadAddon(new WebLinksAddon())
    term.open(element)

    term.onData((input) => handlers.current.onInput(input))
    // The pty has to be told, or `tput cols` is wrong and anything that draws
    // a full screen wraps against the wrong width.
    term.onResize(({ cols, rows }) => handlers.current.onResize(cols, rows))

    terminal.current = term
    fit.current = fitAddon

    return () => {
      term.dispose()
      terminal.current = null
      fit.current = null
      written.current = 0
    }
  }, [])

  // A theme or mode change repaints the open screen in place.
  React.useEffect(() => {
    if (terminal.current) terminal.current.options.theme = theme
  }, [theme])

  // New output only, counted by `total` rather than by the array: the array
  // is capped, so once full its length stops moving and a cursor into it
  // would never see another chunk. Anything that fell off the front before
  // it was drawn is gone; xterm's own scrollback is what keeps history.
  React.useEffect(() => {
    const term = terminal.current
    if (!term) return
    const fresh = Math.min(data.total - written.current, data.chunks.length)
    if (fresh > 0) term.write(data.chunks.slice(-fresh).join(""))
    written.current = data.total
  }, [data])

  /**
   * Refits on anything that changes the box: the window, the file panel
   * opening beside it, and becoming visible again after another tab was
   * shown -- a terminal measured while hidden has no size at all.
   *
   * Focus is taken on the same occasions, and again once the element has a
   * size. `focus()` on something still `display: none` -- an ancestor's, not
   * only ours -- is silently ignored by the browser, and the effect runs
   * before an ancestor's class change has necessarily painted, so a pane that
   * only focused here would sometimes come back with the cursor in nothing:
   * visible, but deaf to every key until clicked.
   */
  React.useEffect(() => {
    const element = host.current
    if (!element || hidden) return

    const refit = () => {
      try {
        fit.current?.fit()
      } catch {
        // Fitting a detached or zero-sized element throws; the next
        // observation will have real numbers.
      }
    }

    const focus = () => {
      // Never steal focus from a field the user is typing in elsewhere. A
      // button -- the toggle that just brought this view up -- does not
      // count; that click is precisely the reason to take it.
      const current = document.activeElement
      if (current instanceof HTMLElement && !element.contains(current) && isEditable(current))
        return
      terminal.current?.focus()
    }

    refit()
    focus()

    const observer = new ResizeObserver((entries) => {
      refit()
      // The first observation with real dimensions is the moment the pane
      // actually became visible; focus that was ignored above lands now.
      if (entries.some((entry) => entry.contentRect.width > 0)) focus()
    })
    observer.observe(element)
    return () => observer.disconnect()
  }, [hidden])

  return (
    <div
      ref={host}
      // `hidden` rather than unmounted: a terminal switched away from and
      // back keeps its scrollback and whatever was half-typed.
      className={hidden ? "hidden" : "min-h-0 flex-1 overflow-hidden p-2"}
      // xterm only fills as many rows as fit; a click in the padding or the
      // strip left under the last row lands on this div, not on xterm, and
      // would otherwise leave the terminal looking active but not listening.
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) {
          event.preventDefault()
          terminal.current?.focus()
        }
      }}
    />
  )
}

/** Something keystrokes already belong to: a text field, or an editor's contenteditable. */
function isEditable(node: HTMLElement): boolean {
  return (
    node instanceof HTMLInputElement ||
    node instanceof HTMLTextAreaElement ||
    node instanceof HTMLSelectElement ||
    node.isContentEditable
  )
}

/**
 * The terminal's palette: the page's own background, text and accent, plus a
 * 16-colour ANSI set for the mode with every foreground at 4.5:1 on that
 * background. xterm's defaults are tuned for black, so its blue vanishes on
 * dark and its yellow on light; bright-black ("gray") is the usual casualty.
 */
function xtermTheme(tokens: Tokens, mode: Mode) {
  const background = tokens.background!
  return {
    background,
    foreground: tokens.foreground!,
    cursor: tokens["ucch-active"]!,
    cursorAccent: background,
    selectionBackground: tokens["ucch-active-bg"]!,
    ...ansiPalette(mode, background),
  }
}
