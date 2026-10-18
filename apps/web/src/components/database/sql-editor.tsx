"use client"

import * as React from "react"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { MySQL, PostgreSQL, sql } from "@codemirror/lang-sql"
import { bracketMatching, syntaxHighlighting } from "@codemirror/language"
import { EditorState, Prec } from "@codemirror/state"
import { drawSelection, EditorView, keymap, lineNumbers, placeholder } from "@codemirror/view"
import type { DatabaseEngine } from "@ucch/protocol"

import { editorSelection } from "@/lib/editor-selection"
import { syntaxHighlightStyle } from "@/lib/syntax-highlight"

/** The look shared with the file editor, minus what only vim mode needs. */
const theme = EditorView.theme({
  "&": { color: "var(--foreground)", backgroundColor: "transparent", fontSize: "13px" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--app-font-code, ui-monospace, SFMono-Regular, Menlo, monospace)",
    lineHeight: "22px",
  },
  ".cm-content": { padding: "0.5rem 0", caretColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
    paddingRight: "0.25rem",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": { backgroundColor: "var(--ucch-active-bg)", outline: "none" },
  ".cm-placeholder": { color: "var(--muted-foreground)" },
})

/**
 * A SQL box: CodeMirror with the engine's dialect and the app's colours.
 * `onRun` is Ctrl/Cmd+Enter, which is what every SQL console does.
 *
 * Uncontrolled: the parent reads the text through `onChange` rather than
 * setting it, since resetting a document on every keystroke is what makes
 * an editor lose its cursor. `initial` is applied when it changes.
 */
export function SqlEditor({
  initial,
  engine,
  onChange,
  onRun,
  className,
}: {
  initial: string
  engine: DatabaseEngine
  onChange: (text: string) => void
  onRun: () => void
  className?: string
}) {
  const host = React.useRef<HTMLDivElement>(null)
  const view = React.useRef<EditorView | null>(null)
  const latest = React.useRef({ onChange, onRun })
  latest.current = { onChange, onRun }

  React.useEffect(() => {
    if (!host.current) return
    const state = EditorState.create({
      doc: initial,
      extensions: [
        Prec.highest(
          keymap.of([
            {
              key: "Mod-Enter",
              run: () => {
                latest.current.onRun()
                return true
              },
            },
          ]),
        ),
        lineNumbers(),
        history(),
        drawSelection(),
        editorSelection(),
        bracketMatching(),
        sql({ dialect: engine === "mysql" ? MySQL : PostgreSQL, upperCaseKeywords: true }),
        syntaxHighlighting(syntaxHighlightStyle),
        placeholder("SELECT * FROM ..."),
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        theme,
        EditorView.lineWrapping,
        EditorView.updateListener.of((update) => {
          if (update.docChanged) latest.current.onChange(update.state.doc.toString())
        }),
      ],
    })
    const instance = new EditorView({ state, parent: host.current })
    view.current = instance
    latest.current.onChange(initial)
    return () => {
      instance.destroy()
      view.current = null
    }
    // The dialect and the starting text are what the editor is made from; a
    // change to either is a new editor.
  }, [engine, initial])

  return <div ref={host} className={className} />
}
