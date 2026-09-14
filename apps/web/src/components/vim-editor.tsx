"use client"

import * as React from "react"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { css } from "@codemirror/lang-css"
import { html } from "@codemirror/lang-html"
import { javascript } from "@codemirror/lang-javascript"
import { json } from "@codemirror/lang-json"
import { markdown } from "@codemirror/lang-markdown"
import { php } from "@codemirror/lang-php"
import {
  bracketMatching,
  indentUnit,
  syntaxHighlighting,
  type LanguageSupport,
} from "@codemirror/language"
import { search, searchKeymap } from "@codemirror/search"
import { EditorState, Prec, type Extension } from "@codemirror/state"
import {
  drawSelection,
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view"
import { indentationMarkers } from "@replit/codemirror-indentation-markers"
import { Vim, vim } from "@replit/codemirror-vim"

import { replacement } from "@/lib/doc-sync"
import { syntaxHighlightStyle } from "@/lib/syntax-highlight"
import { registerVimKeymap } from "@/lib/vim-keymap"

/**
 * The language mode for a path, or nothing for a file we have no grammar for.
 *
 * Highlighting is a side benefit of moving to CodeMirror rather than the
 * point of it, so an unknown extension renders as plain text instead of being
 * forced through a guess.
 */
function languageFor(path: string): LanguageSupport | null {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase()
  switch (ext) {
    case "ts":
    case "tsx":
      return javascript({ typescript: true, jsx: ext === "tsx" })
    case "js":
    case "jsx":
    case "mjs":
    case "cjs":
      return javascript({ jsx: ext === "jsx" })
    case "json":
      return json()
    case "md":
    case "mdx":
      return markdown()
    case "php":
      return php()
    case "html":
      return html()
    case "css":
      return css()
    default:
      return null
  }
}

/**
 * Everything CodeMirror gets, in order.
 *
 * `vim()` must come first: it installs its own keymap at the highest
 * precedence, and anything registered ahead of it would win over the mode
 * that is supposed to be interpreting the keystroke.
 */
function extensions(
  path: string,
  onChange: (text: string) => void,
  onSave: () => void,
): Extension[] {
  const language = languageFor(path)
  // Mappings live on a keymap shared by every editor, so they are installed
  // once here rather than as an extension per instance.
  registerVimKeymap()

  return [
    // `status` is what renders the command line, so `:`, `/` and `?` have
    // somewhere to appear -- without it those modes have no visible prompt.
    vim({ status: true }),

    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    highlightSpecialChars(),
    // Vim's own selection is drawn rather than native, which is what makes
    // block-wise visual mode possible: it is several ranges at once.
    drawSelection(),
    rectangularSelection(),
    bracketMatching(),
    // `u` and Ctrl-r are CodeMirror's undo/redo underneath, so vim has no
    // history to walk without this.
    history(),
    search(),
    // Coloured by the `--syn-*` variables the theme settings own, so the
    // reader's own palette applies here without a second copy of it.
    syntaxHighlighting(syntaxHighlightStyle),
    indentUnit.of("  "),
    EditorState.tabSize.of(2),
    // A hairline down each level of indentation. The colour is the app's own
    // border token passed to both slots on purpose: the plugin picks between
    // them using CodeMirror's dark-theme flag, which this editor never sets --
    // it follows the app's `.dark` class instead, and one variable resolves
    // correctly under either.
    indentationMarkers({
      thickness: 1,
      markerType: "fullScope",
      highlightActiveBlock: false,
      colors: {
        light: "var(--border)",
        dark: "var(--border)",
        activeLight: "var(--border)",
        activeDark: "var(--border)",
      },
    }),
    EditorView.lineWrapping,
    ...(language ? [language] : []),

    // Above vim, and the only binding that is: ctrl-S means save everywhere
    // else in the world, and insert mode would otherwise swallow it before
    // anything below could see it.
    Prec.highest(
      keymap.of([
        {
          key: "Mod-s",
          run: () => {
            onSave()
            // Claimed, so the browser's own Save-page dialog never opens.
            return true
          },
        },
      ]),
    ),

    // Below vim in precedence: these only see keys vim did not claim.
    keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap, indentWithTab]),

    EditorView.updateListener.of((update) => {
      if (update.docChanged) onChange(update.state.doc.toString())
    }),
    theme,
  ]
}

/**
 * Painted entirely from the app's tokens, so the editor follows the theme
 * without a second palette to keep in sync -- and without needing to know
 * whether the app is currently light or dark, since the variables resolve
 * against the cascade at render time.
 */
const theme = EditorView.theme({
  "&": {
    height: "100%",
    fontSize: "12px",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--app-font, ui-monospace, SFMono-Regular, Menlo, monospace)",
    lineHeight: "1.5rem",
  },
  ".cm-content": { padding: "1rem 0", caretColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
    paddingRight: "0.25rem",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklch, var(--muted) 45%, transparent)" },
  ".cm-selectionBackground, &.cm-focused .cm-selectionBackground, .cm-content ::selection": {
    backgroundColor: "var(--ucch-active-bg)",
  },
  ".cm-matchingBracket, &.cm-focused .cm-matchingBracket": {
    backgroundColor: "var(--ucch-active-bg)",
    color: "inherit",
    outline: "none",
  },

  // Two cursors, one per mode. Normal, visual and replace draw a block over
  // the character -- the vim layer sizes it to the character cell and puts
  // the letter inside it, so the colour here has to invert to stay readable.
  // Selectors carry an extra class on purpose: the plugin ships its own
  // `.cm-fat-cursor` rule at the highest precedence, and only greater
  // specificity beats it deterministically, whatever order the styles mount.
  ".cm-vimCursorLayer .cm-fat-cursor": {
    background: "var(--ucch-active)",
    color: "var(--background)",
    border: "none",
    borderRadius: "1px",
  },
  // Unfocused, it hollows out rather than disappearing, so it is still clear
  // where you left off.
  "&:not(.cm-focused) .cm-vimCursorLayer .cm-fat-cursor": {
    background: "none",
    outline: "1px solid var(--ucch-active)",
    color: "inherit",
  },

  // Insert mode: an ordinary thin caret. It is drawn by `drawSelection()`
  // rather than by the browser -- the native one is transparent while vim is
  // in charge -- so it needs a colour of its own or it renders invisible on
  // a dark background. `.cm-cursor` is safe to target alone: the block pieces
  // are `.cm-fat-cursor` and never carry this class.
  ".cm-cursor": {
    borderLeft: "2px solid var(--foreground)",
    borderRight: "none",
  },

  // The command line and mode indicator, at the foot of the editor.
  ".cm-panels, .cm-vim-panel": {
    backgroundColor: "transparent",
    borderTop: "1px solid var(--border)",
    color: "var(--muted-foreground)",
    fontFamily: "var(--app-font, ui-monospace, monospace)",
    fontSize: "11px",
    padding: "0.25rem 1rem",
  },
  ".cm-vim-panel input": {
    fontFamily: "inherit",
    color: "var(--foreground)",
    backgroundColor: "transparent",
    border: "none",
    outline: "none",
    width: "100%",
  },
})

/**
 * One file, edited with vim keybindings.
 *
 * The vim layer is `@replit/codemirror-vim` rather than something hand-rolled:
 * modes, the count/operator/motion grammar, text objects, registers, marks,
 * jumps, macros and the Ex command line are all subtleties that a partial
 * implementation gets quietly wrong, and this one is the emulation vim users
 * already know.
 *
 * The document is seeded from the buffer and thereafter flows the other way:
 * the buffer above is updated from here. The one exception is a change that
 * did not come from here -- the agent rewriting the file while it is open --
 * which the effect below applies as an edit rather than a reseed, so the
 * cursor and the scroll stay where they were.
 */
/**
 * `:w` and `:wq`, wired to whichever editor is on screen.
 *
 * The vim layer's ex commands are global -- one registry for every instance
 * -- so the handler is registered once and dispatches through a ref that the
 * mounted editor keeps current. Registering per instance would leave the last
 * unmounted editor's handler in place, writing to a file that is no longer
 * open.
 */
const activeSave = { current: (): void => {} }
/**
 * `:chat`, dispatched the same way.
 *
 * Typed over a visual selection, the ex line already carries `'<,'>`, and the
 * vim layer resolves that to the selection's first and last lines. With no
 * selection it is the cursor's line. Both arrive 0-based and go out 1-based,
 * which is the number in the gutter and the number the agent is told.
 */
const activeChat = { current: (_from: number, _to: number, _command: string): void => {} }
let exCommandsRegistered = false

function registerExCommands(): void {
  if (exCommandsRegistered) return
  exCommandsRegistered = true
  Vim.defineEx("write", "w", () => activeSave.current())
  Vim.defineEx("wq", "wq", () => activeSave.current())
  Vim.defineEx("xit", "x", () => activeSave.current())
  Vim.defineEx("chat", "chat", (_cm, params) => {
    const from = params.selectionLine + 1
    const to = (params.selectionLineEnd ?? params.selectionLine) + 1
    activeChat.current(from, to, params.argString?.trim() ?? "")
  })
}

export function VimEditor({
  path,
  initialText,
  text,
  onChange,
  onSave,
  onChat,
  reveal,
}: {
  path: string
  initialText: string
  /**
   * The buffer as the panel holds it now. Usually what this editor last
   * reported, in which case nothing happens; when it is not -- the file was
   * reread after the agent wrote it -- the difference is applied here.
   */
  text: string
  onChange: (text: string) => void
  /** Writes the buffer to the workspace. Bound to ctrl-S, `:w` and `:wq`. */
  onSave: () => void
  /**
   * Asks the agent about lines `from`-`to` (1-based, inclusive). Bound to
   * `:chat`; `command` is whatever followed it on the ex line, often nothing.
   */
  onChat: (from: number, to: number, command: string) => void
  /**
   * A line to put the cursor on, from a search result.
   *
   * The token is what makes a second request for the same line work: this
   * component is mounted once per file, so "go here" has to be something it can
   * tell apart from the last one rather than a value that has not changed.
   */
  reveal?: { line: number; token: number } | null
}) {
  const host = React.useRef<HTMLDivElement>(null)
  const editor = React.useRef<EditorView | null>(null)
  const latest = React.useRef(onChange)
  latest.current = onChange
  const latestSave = React.useRef(onSave)
  latestSave.current = onSave
  const latestChat = React.useRef(onChat)
  latestChat.current = onChat

  React.useEffect(() => {
    const parent = host.current
    if (!parent) return

    registerExCommands()
    activeSave.current = () => latestSave.current()
    activeChat.current = (from, to, command) => latestChat.current(from, to, command)

    const view = new EditorView({
      doc: initialText,
      parent,
      extensions: extensions(
        path,
        (text) => latest.current(text),
        () => latestSave.current(),
      ),
    })
    editor.current = view
    view.focus()
    return () => {
      editor.current = null
      view.destroy()
    }
    // Mounted once per file: the component is keyed by path, so a different
    // file is a different instance rather than a document swap.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * Applies a change that arrived from outside: the agent rewrote this file.
   *
   * Only the span that differs is replaced, so an edit further down the file
   * leaves the cursor and the viewport alone, and CodeMirror maps the
   * selection through the change the way it would for any other edit. A
   * change of our own never gets here as an edit: the buffer already matches
   * the document, and `replacement` says there is nothing to do.
   */
  React.useEffect(() => {
    const view = editor.current
    if (!view) return
    const change = replacement(view.state.doc.toString(), text)
    if (!change) return
    view.dispatch({ changes: change })
  }, [text])

  /**
   * Puts the cursor on the line a search result named, and scrolls to it.
   *
   * Keyed on the token rather than the line, so clicking the same result twice
   * scrolls back to it after you have moved away. The line is clamped to the
   * document: a result from a file the agent has since shortened would otherwise
   * throw inside CodeMirror rather than simply landing at the end.
   *
   * It runs after the mount effect above, so the view is there on the first
   * reveal of a freshly opened file.
   */
  React.useEffect(() => {
    const view = editor.current
    if (!view || !reveal) return

    const lineNumber = Math.min(Math.max(1, reveal.line), view.state.doc.lines)
    const line = view.state.doc.line(lineNumber)
    view.dispatch({
      selection: { anchor: line.from },
      // `center` rather than the default: a match at the bottom edge of the
      // viewport is technically visible and practically missed.
      effects: EditorView.scrollIntoView(line.from, { y: "center" }),
    })
    view.focus()
  }, [reveal?.token, reveal?.line])

  return <div ref={host} className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full" />
}
