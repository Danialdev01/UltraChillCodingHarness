"use client"

import * as React from "react"
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands"
import { bracketMatching, indentUnit, syntaxHighlighting } from "@codemirror/language"
import { search, searchKeymap } from "@codemirror/search"
import { Compartment, EditorState, Prec, type Extension } from "@codemirror/state"
import {
  drawSelection,
  EditorView,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view"
import { indentationMarkers } from "@replit/codemirror-indentation-markers"
import { CodeMirror, getCM, Vim, vim } from "@replit/codemirror-vim"
import { yCollab, yUndoManagerKeymap } from "y-codemirror.next"
import * as Y from "yjs"
import type { Awareness } from "y-protocols/awareness"

import { replacement } from "@/lib/doc-sync"
import { languageFor } from "@/lib/languages"
import { editorSelection } from "@/lib/editor-selection"
import { readEditorFontSize, watchEditorFontSize } from "@/lib/editor-font-size"
import {
  readEditorKeybindings,
  watchEditorKeybindings,
  type EditorKeybindings,
} from "@/lib/editor-keybindings"
import { leaderChildren, type LeaderCommand } from "@/lib/leader-keymap"
import { syntaxHighlightStyle } from "@/lib/syntax-highlight"
import { cn } from "@/lib/utils"
import { activeLeader, registerVimKeymap } from "@/lib/vim-keymap"


/**
 * The modal layer for a keybinding choice: on, or nothing at all.
 *
 * On is the vim engine; the emacs chords that make it Doom-like are mappings
 * on top of it (see `registerVimKeymap`), not a second engine beside it.
 * Nothing is an empty extension rather than a missing one, so the compartment
 * it lives in always has something to reconfigure to and the rest of the
 * stack keeps its order whichever is chosen.
 */
function keybindingsFor(choice: EditorKeybindings): Extension {
  switch (choice) {
    case "vim-emacs":
      // `status` is what renders the command line, so `:`, `/` and `?` have
      // somewhere to appear -- without it those modes have no visible prompt.
      return vim({ status: true })
    case "none":
      return []
  }
}

/**
 * The slot the modal layer sits in, swapped when the setting changes so an
 * open file keeps its text, cursor and undo history across the switch.
 */
const keybindings = new Compartment()

/**
 * The font size, in a slot of its own for the same reason. It is a theme
 * rather than a style on the host element so CodeMirror remeasures its lines
 * when it changes -- the gutter and the fat cursor are sized from the font.
 */
const fontSize = new Compartment()

/** Whether the text can be changed, swapped while something else rewrites it. */
const editable = new Compartment()

function editableFor(readOnly: boolean): Extension {
  return [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly)]
}

function fontSizeFor(px: number): Extension {
  // The line height follows the font once the font outgrows it: 24px is the
  // shipped look at 12px, and a 20px face on a 24px line would be cramped.
  // The leading above and below the text is then trimmed by a tenth.
  const lineHeight = px + (Math.max(24, Math.round(px * 1.5)) - px) * 0.9
  return EditorView.theme({
    "&": { fontSize: `${px}px` },
    ".cm-scroller": { lineHeight: `${lineHeight}px` },
  })
}

/**
 * A file shared live: its text in the collab service's document, and the
 * others' cursors. The text is the document's, not the buffer's.
 */
export interface EditorCollab {
  ytext: Y.Text
  awareness: Awareness | null
}

/**
 * Undo and redo for each editor bound to a shared document: Yjs's, which
 * undoes only this tab's edits. CodeMirror's own history would record a
 * collaborator's typing as it arrived and undo that too.
 */
const sharedHistory = new WeakMap<EditorView, Y.UndoManager>()
let vimHistoryPatched = false

/**
 * Vim's `u` and Ctrl-r run CodeMirror's undo through the adapter's command
 * table, one for every editor; an editor with a shared document is sent to
 * its own undo manager instead.
 */
function patchVimHistory(): void {
  if (vimHistoryPatched) return
  vimHistoryPatched = true
  type Command = (cm: { cm6: EditorView }) => void
  const commands = CodeMirror.commands as unknown as Record<"undo" | "redo", Command>
  const { undo, redo } = commands
  commands.undo = (cm) => {
    const manager = sharedHistory.get(cm.cm6)
    if (manager) manager.undo()
    else undo(cm)
  }
  commands.redo = (cm) => {
    const manager = sharedHistory.get(cm.cm6)
    if (manager) manager.redo()
    else redo(cm)
  }
}

/**
 * Everything CodeMirror gets, in order.
 *
 * The modal layer must come first: vim installs its own keymap at the highest
 * precedence, and anything registered ahead of it would win over the mode
 * that is supposed to be interpreting the keystroke.
 */
function extensions(
  path: string,
  onChange: (text: string) => void,
  onSave: () => void,
  readOnly: boolean,
  shared: { collab: EditorCollab; undoManager: Y.UndoManager } | null,
): Extension[] {
  const language = languageFor(path)
  // Mappings live on a keymap shared by every editor, so they are installed
  // once here rather than as an extension per instance. Harmless when vim is
  // not the layer in use: they only ever run through vim itself.
  registerVimKeymap()

  return [
    keybindings.of(keybindingsFor(readEditorKeybindings())),
    fontSize.of(fontSizeFor(readEditorFontSize())),
    editable.of(editableFor(readOnly)),

    lineNumbers(),
    highlightActiveLineGutter(),
    highlightSpecialChars(),
    // Vim's own selection is drawn rather than native, which is what makes
    // block-wise visual mode possible: it is several ranges at once.
    drawSelection(),
    // Its colours, and the current line drawn beneath it.
    editorSelection(),
    rectangularSelection(),
    bracketMatching(),
    // `u` and Ctrl-r are CodeMirror's undo/redo underneath, so vim has no
    // history to walk without this -- or, shared, Yjs's (`patchVimHistory`).
    shared
      ? yCollab(shared.collab.ytext, shared.collab.awareness, { undoManager: shared.undoManager })
      : history(),
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

    // Above the modal layer, and the only binding that is: ctrl-S means save
    // everywhere else in the world, and insert mode would otherwise swallow
    // it before anything below could see it.
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

    // Below the modal layer in precedence: these only see keys it did not
    // claim -- which, with none chosen, is all of them.
    keymap.of([...defaultKeymap, ...(shared ? yUndoManagerKeymap : historyKeymap), ...searchKeymap, indentWithTab]),

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
  // No font size here: that is the reader's choice, in its own compartment.
  "&": {
    height: "100%",
    color: "var(--foreground)",
    backgroundColor: "transparent",
  },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": {
    fontFamily: "var(--app-font-code, ui-monospace, SFMono-Regular, Menlo, monospace)",
  },
  ".cm-content": { padding: "1rem 0", caretColor: "var(--foreground)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--muted-foreground)",
    borderRight: "1px solid var(--border)",
    paddingRight: "0.25rem",
  },
  ".cm-activeLineGutter": { backgroundColor: "transparent", color: "var(--foreground)" },
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
    fontFamily: "var(--app-font-code, ui-monospace, monospace)",
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
 * Puts the cursor on a line and scrolls to it.
 *
 * The line is clamped to the document: a result from a file the agent has
 * since shortened would otherwise throw inside CodeMirror rather than simply
 * landing at the end. `center` rather than the default: a match at the bottom
 * edge of the viewport is technically visible and practically missed.
 */
function jumpToLine(view: EditorView, lineNumber: number): void {
  const clamped = Math.min(Math.max(1, lineNumber), view.state.doc.lines)
  const line = view.state.doc.line(clamped)
  view.dispatch({
    selection: { anchor: line.from },
    effects: EditorView.scrollIntoView(line.from, { y: "center" }),
  })
  view.focus()
}

/**
 * How long a leader prefix sits before its menu is shown, so a sequence typed
 * straight through never flashes one. Doom's `which-key-idle-delay`, near
 * enough.
 */
const WHICH_KEY_DELAY_MS = 300

/**
 * One file, edited with vim keybindings -- or plain CodeMirror's, as the
 * Default settings tab has it.
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
  onLeader,
  reveal,
  autoFocus = true,
  readOnly = false,
  collab,
  className,
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
  onChat?: (from: number, to: number, command: string) => void
  /**
   * A leader-key command -- `SPC s s`, `SPC .` -- for the file view to act
   * on, with the cursor's line (1-based) at the time.
   */
  onLeader?: (command: LeaderCommand, line: number) => void
  /**
   * A line to put the cursor on, from a search result.
   *
   * The token is what makes a second request for the same line work: this
   * component is mounted once per file, so "go here" has to be something it can
   * tell apart from the last one rather than a value that has not changed.
   */
  reveal?: { line: number; token: number } | null
  /** Takes the keyboard when it opens. Off where the editor is not the page's point. */
  autoFocus?: boolean
  /** Shows the text without letting it change: while the AI is rewriting it, say. */
  readOnly?: boolean
  /**
   * Bound to a shared document: the text is its, `initialText` and `text`
   * are not used, and `onChange` reports what it now holds.
   */
  collab?: EditorCollab
  className?: string
}) {
  const host = React.useRef<HTMLDivElement>(null)
  const editor = React.useRef<EditorView | null>(null)
  const latest = React.useRef(onChange)
  latest.current = onChange
  const latestSave = React.useRef(onSave)
  latestSave.current = onSave
  const latestChat = React.useRef(onChat)
  latestChat.current = onChat
  const latestLeader = React.useRef(onLeader)
  latestLeader.current = onLeader
  // The keys of a leader sequence typed so far, or nothing.
  const [pending, setPending] = React.useState("")

  React.useEffect(() => {
    const parent = host.current
    if (!parent) return

    registerExCommands()
    patchVimHistory()
    // `:w`, `:chat` and the leader keys are shared by every editor, so they
    // follow whichever one was opened or focused last.
    const claim = () => {
      activeSave.current = () => latestSave.current()
      activeChat.current = (from, to, command) => latestChat.current?.(from, to, command)
      activeLeader.current = (command, line) => latestLeader.current?.(command, line)
    }
    claim()
    parent.addEventListener("focusin", claim)

    const undoManager = collab ? new Y.UndoManager(collab.ytext) : null
    const view = new EditorView({
      doc: collab ? collab.ytext.toString() : initialText,
      parent,
      extensions: extensions(
        path,
        (text) => latest.current(text),
        () => latestSave.current(),
        readOnly,
        collab && undoManager ? { collab, undoManager } : null,
      ),
    })
    if (undoManager) sharedHistory.set(view, undoManager)
    editor.current = view
    if (autoFocus) view.focus()

    // The which-key popup follows the vim layer's own key buffer: after each
    // key it holds whatever sequence is still waiting for more, and it is
    // empty again once a command has run or Escape has thrown it away. Read
    // from there rather than tracked here, so the two can never disagree
    // about what has been typed. The wrapper exists only while the vim layer
    // is the one in use -- a new one each time it is switched on -- so the
    // listeners follow the setting.
    let detach = () => {}
    const attach = () => {
      detach()
      const cm = getCM(view)
      if (!cm) return
      const sync = () => setPending(cm.state.vim?.inputState.keyBuffer.join("") ?? "")
      cm.on("vim-keypress", sync)
      cm.on("vim-command-done", sync)
      detach = () => {
        cm.off("vim-keypress", sync)
        cm.off("vim-command-done", sync)
        setPending("")
      }
    }
    attach()
    // The setting is changed on another page, but the file stays open behind
    // it -- and a second browser tab reaches this one through `storage`.
    const unwatchKeys = watchEditorKeybindings((choice) => {
      view.dispatch({ effects: keybindings.reconfigure(keybindingsFor(choice)) })
      attach()
    })
    const unwatchSize = watchEditorFontSize((px) => {
      view.dispatch({ effects: fontSize.reconfigure(fontSizeFor(px)) })
    })
    return () => {
      parent.removeEventListener("focusin", claim)
      unwatchKeys()
      unwatchSize()
      detach()
      editor.current = null
      view.destroy()
      undoManager?.destroy()
    }
    // Mounted once per file -- and per shared copy of it: the component is
    // keyed by path, so a different file is a different instance rather
    // than a document swap.
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
    // Shared, the document brings such changes itself.
    if (!view || collab) return
    const change = replacement(view.state.doc.toString(), text)
    if (!change) return
    view.dispatch({ changes: change })
  }, [text])

  /**
   * Puts the cursor on the line a search result named.
   *
   * Keyed on the token rather than the line, so clicking the same result twice
   * scrolls back to it after you have moved away. It runs after the mount
   * effect above, so the view is there on the first reveal of a freshly
   * opened file.
   */
  React.useEffect(() => {
    const view = editor.current
    if (!view || !reveal) return
    jumpToLine(view, reveal.line)
  }, [reveal?.token, reveal?.line])

  React.useEffect(() => {
    editor.current?.dispatch({ effects: editable.reconfigure(editableFor(readOnly)) })
  }, [readOnly])

  return (
    <div className={cn("relative flex min-h-0 flex-1 flex-col", className)}>
      <div ref={host} className="min-h-0 flex-1 overflow-hidden [&_.cm-editor]:h-full" />
      <WhichKey pending={pending} />
    </div>
  )
}

/**
 * Doom's which-key popup: the keys that can follow the leader prefix typed
 * so far, each with what it does.
 *
 * Shown after a short delay so a sequence typed straight through never
 * flashes it. Sits over the foot of the editor, above the vim status line
 * that is already echoing the pending keys, and takes no focus: it is a
 * caption for what the keyboard is doing, not a menu to click.
 */
function WhichKey({ pending }: { pending: string }) {
  const rows = leaderChildren(pending)
  const [shown, setShown] = React.useState(false)

  React.useEffect(() => {
    if (!rows) {
      setShown(false)
      return
    }
    const timer = window.setTimeout(() => setShown(true), WHICH_KEY_DELAY_MS)
    return () => window.clearTimeout(timer)
    // Only whether there is a prefix and which: the rows are derived from it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pending])

  if (!rows || !shown) return null

  // The vim layer spells space `<Space>`; people spell it SPC.
  const typed = pending.replace("<Space>", "SPC ").trimEnd()

  return (
    <div
      role="status"
      aria-live="polite"
      className="bg-popover text-popover-foreground absolute inset-x-4 bottom-8 z-10 rounded-lg border p-3 font-mono text-xs shadow-md"
    >
      <div className="text-muted-foreground mb-2">{typed}-</div>
      <div className="grid grid-cols-[repeat(auto-fill,minmax(11rem,1fr))] gap-x-4 gap-y-1">
        {rows.map((row) => (
          <div key={row.key} className="flex items-baseline gap-2 truncate">
            <kbd className="text-ucch-active w-4 text-right">{row.key}</kbd>
            <span className="text-muted-foreground">→</span>
            <span className={row.prefix ? "text-foreground" : ""}>
              {row.prefix ? `+${row.desc}` : row.desc}
            </span>
          </div>
        ))}
      </div>
    </div>
  )
}
