import { indentUnit } from "@codemirror/language"
import type { EditorView } from "@codemirror/view"
import { Vim, type CodeMirrorV, type vimState } from "@replit/codemirror-vim"

import { LEADER, leaderBindings, type LeaderCommand } from "@/lib/leader-keymap"
import {
  planIndent,
  planLineMove,
  planTextShift,
  visualRanges,
  type Pos,
  type VisualMode,
} from "@/lib/line-moves"

/**
 * Shift-J/K move lines up and down; Shift-H/L move them left and right.
 *
 * Together they make the four arrows of "move this code somewhere else",
 * which is what these keys are asked to do here. It costs four built-ins:
 * `J` joins lines, `K` looks up a keyword, and `H`/`L` jump to the highest
 * and lowest visible lines. `:join`, `<`/`>` and `zt`/`zb` still reach the
 * standard behaviour, and any of them can be mapped back.
 *
 * Registered against the vim layer rather than as a CodeMirror keybinding
 * because vim owns every key in normal and visual mode; a keymap underneath
 * it would never see them.
 */

/** The lines a visual selection spans, or the cursor's line in normal mode. */
function selectedLines(cm: CodeMirrorV, vim: vimState): { from: number; to: number } {
  if (!vim.visualMode) {
    const line = cm.getCursor().line
    return { from: line, to: line }
  }
  const { anchor, head } = vim.sel
  return { from: Math.min(anchor.line, head.line), to: Math.max(anchor.line, head.line) }
}

function moveLines(cm: CodeMirrorV, vim: vimState, delta: number): void {
  const view = cm.cm6 as EditorView
  const doc = view.state.doc
  const lines = doc.toString().split("\n")

  const { from, to } = selectedLines(cm, vim)
  const plan = planLineMove(lines, from, to, delta)
  // No neighbour to swap with: leave the document and the selection alone
  // rather than dispatching an edit that changes nothing.
  if (!plan) return

  // `plan` is in 0-based lines; CodeMirror's document is 1-based.
  view.dispatch({
    changes: {
      from: doc.line(plan.from + 1).from,
      to: doc.line(plan.to + 1).to,
      insert: plan.text,
    },
  })

  if (!vim.visualMode) {
    // Normal mode: follow the line, holding the column.
    const column = cm.getCursor().ch
    cm.setCursor(clamp(cm, { line: plan.blockFrom, ch: column }))
    return
  }

  // Visual mode: the selection travels with the lines, so the same text stays
  // selected and a run of J's keeps moving the same block.
  vim.sel = {
    anchor: clamp(cm, { ...vim.sel.anchor, line: vim.sel.anchor.line + delta }),
    head: clamp(cm, { ...vim.sel.head, line: vim.sel.head.line + delta }),
  }

  const mode: VisualMode = vim.visualLine ? "line" : vim.visualBlock ? "block" : "char"
  const { ranges, primary } = visualRanges(vim.sel, mode, (line) => cm.getLine(line)?.length ?? 0)
  cm.setSelections(ranges, primary)
}

/** Keeps a position on a line that exists, at a column that exists on it. */
function clamp(cm: CodeMirrorV, pos: Pos): Pos {
  const line = Math.max(0, Math.min(pos.line, cm.lastLine()))
  return { line, ch: Math.max(0, Math.min(pos.ch, cm.getLine(line)?.length ?? 0)) }
}

/**
 * Shift-H / Shift-L over whole lines: indents them by one unit.
 *
 * What "move it left" means when the thing selected is lines rather than
 * text -- and when nothing is selected at all, the line the cursor is on.
 */
function indentSelection(cm: CodeMirrorV, vim: vimState, delta: number): void {
  const view = cm.cm6 as EditorView
  const doc = view.state.doc
  const lines = doc.toString().split("\n")

  const { from, to } = selectedLines(cm, vim)
  // The unit comes from the editor rather than a constant here, so it stays
  // whatever the buffer is configured to indent by.
  const plan = planIndent(lines, from, to, delta, view.state.facet(indentUnit))
  // Nothing to outdent: leave the document and the selection alone.
  if (!plan) return

  view.dispatch({
    changes: {
      from: doc.line(plan.from + 1).from,
      to: doc.line(plan.to + 1).to,
      insert: plan.text,
    },
  })

  // Columns move with the text they sit after, so each end shifts by whatever
  // its own line gained or lost.
  const shift = (pos: Pos): Pos => ({
    line: pos.line,
    ch: Math.max(0, pos.ch + (plan.shifts[pos.line - plan.from] ?? 0)),
  })

  if (!vim.visualMode) {
    // Normal mode has no selection to restore, and writing one would leave
    // vim thinking it had entered visual mode.
    cm.setCursor(clamp(cm, shift(cm.getCursor())))
    return
  }

  vim.sel = { anchor: clamp(cm, shift(vim.sel.anchor)), head: clamp(cm, shift(vim.sel.head)) }

  const mode: VisualMode = vim.visualLine ? "line" : vim.visualBlock ? "block" : "char"
  const { ranges, primary } = visualRanges(vim.sel, mode, (line) => cm.getLine(line)?.length ?? 0)
  cm.setSelections(ranges, primary)
}

/**
 * Shift-H / Shift-L over selected text: slides just that text sideways.
 *
 * Indenting the line would move characters the selection does not cover,
 * which is the distinction being drawn -- lines indent, text slides.
 */
function shiftSelectedText(cm: CodeMirrorV, vim: vimState, delta: number): void {
  const view = cm.cm6 as EditorView
  const doc = view.state.doc
  const offset = (pos: Pos) => doc.line(pos.line + 1).from + pos.ch

  // Vim's charwise selection includes the character under the head, so the
  // exclusive end is one past the later of the two.
  const ends = [offset(vim.sel.anchor), offset(vim.sel.head)]
  const from = Math.min(...ends)
  const to = Math.max(...ends) + 1

  const plan = planTextShift(doc.toString(), from, to, delta)
  // Already against a line edge: leave the document and the selection alone.
  if (!plan) return

  view.dispatch({ changes: { from: plan.from, to: plan.to, insert: plan.text } })

  const posAt = (at: number): Pos => {
    const line = view.state.doc.lineAt(at)
    return { line: line.number - 1, ch: at - line.from }
  }
  // Keep which end is the head, so extending the selection afterwards still
  // grows from the side the cursor is on.
  const headWasLast = ends[1]! >= ends[0]!
  const start = posAt(plan.selFrom)
  const end = posAt(plan.selTo - 1)
  vim.sel = headWasLast ? { anchor: start, head: end } : { anchor: end, head: start }

  const { ranges, primary } = visualRanges(vim.sel, "char", (line) => cm.getLine(line)?.length ?? 0)
  cm.setSelections(ranges, primary)
}

/**
 * Shift-H / Shift-L: moves whatever is selected sideways.
 *
 * Selected text slides by a character; selected lines, and a bare cursor with
 * nothing selected, indent by one unit. Blockwise stays with the lines: a
 * rectangular selection is several spans at once, and sliding each of them
 * independently is a different feature from this one.
 */
function moveHorizontally(cm: CodeMirrorV, vim: vimState, delta: number): void {
  const charwise = vim.visualMode && !vim.visualLine && !vim.visualBlock
  if (charwise) shiftSelectedText(cm, vim, delta)
  else indentSelection(cm, vim, delta)
}

/**
 * Where a leader command goes: the editor that is on screen.
 *
 * The vim layer's keymap is one registry shared by every instance, so the
 * action is registered once and dispatches through a ref the mounted editor
 * keeps current -- the same arrangement as `:w` and `:chat` in `vim-editor`.
 * `line` is the cursor's line, 1-based, for a command that wants to start
 * from where you are.
 */
export const activeLeader = { current: (_command: LeaderCommand, _line: number): void => {} }

let registered = false

/**
 * Installs the mappings. Idempotent, because `mapCommand` pushes onto a
 * keymap shared by every editor on the page and a second call would leave a
 * duplicate behind it.
 */
export function registerVimKeymap(): void {
  if (registered) return
  registered = true

  Vim.defineAction("ucchMoveLinesDown", (cm, _args, vim) => moveLines(cm, vim, 1))
  Vim.defineAction("ucchMoveLinesUp", (cm, _args, vim) => moveLines(cm, vim, -1))

  for (const context of ["normal", "visual"] as const) {
    Vim.mapCommand("J", "action", "ucchMoveLinesDown", {}, { context })
    Vim.mapCommand("K", "action", "ucchMoveLinesUp", {}, { context })
  }

  Vim.defineAction("ucchMoveRight", (cm, _args, vim) => moveHorizontally(cm, vim, 1))
  Vim.defineAction("ucchMoveLeft", (cm, _args, vim) => moveHorizontally(cm, vim, -1))
  for (const context of ["normal", "visual"] as const) {
    Vim.mapCommand("L", "action", "ucchMoveRight", {}, { context })
    Vim.mapCommand("H", "action", "ucchMoveLeft", {}, { context })
  }

  registerLeader()
}

/**
 * `SPC` as Doom's leader: `SPC s s` searches the buffer, `SPC .` finds a
 * file, and so on (see `LEADER_TREE`).
 *
 * The vim layer already buffers a multi-key sequence and waits for the rest,
 * so each leaf is one mapping and the prefixes need none. What it does not
 * do is prefer the longer sequence: its own `<Space>` (a synonym for `l`) is
 * a complete match the moment space is pressed, and a complete match beats a
 * pending one. So that synonym is removed first. `l` itself is untouched;
 * the one casualty is `d<Space>`, which was `dl` -- and still is, spelled
 * that way.
 *
 * `SPC :` is a plain key-to-key mapping onto `:` rather than an action: it
 * is the ex line, which only the vim layer can open, and opening it from
 * inside a running action would be the layer re-entering itself.
 */
function registerLeader(): void {
  // The built-in synonym is registered without a mode, and `unmap` only
  // removes a mapping whose mode is the one given -- so the mode here has to
  // be no mode at all, which the signature does not admit.
  ;(Vim.unmap as (lhs: string, ctx?: string) => unknown)(LEADER)

  Vim.defineAction("ucchLeader", (cm, args) => {
    // Our own argument, carried through `mapCommand` beside the built-in ones.
    const command = (args as unknown as { command: LeaderCommand }).command
    activeLeader.current(command, cm.getCursor().line + 1)
  })

  for (const { keys, command } of leaderBindings()) {
    for (const context of ["normal", "visual"] as const) {
      if (command === "ex") Vim.map(keys, ":", context)
      else Vim.mapCommand(keys, "action", "ucchLeader", { command }, { context })
    }
  }
}
