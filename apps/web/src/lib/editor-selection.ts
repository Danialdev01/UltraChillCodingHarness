import { Prec, RangeSetBuilder, type Extension } from "@codemirror/state"
import {
  Decoration,
  EditorView,
  layer,
  RectangleMarker,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view"

/**
 * How a CodeMirror editor in this app paints its selection, together with
 * `drawSelection()`.
 *
 * The colours are the `--editor-selection*` variables the theme provider
 * derives (see `selection-color.ts`); before it has run they fall back to the
 * accent wash the stylesheet already has.
 *
 * Selectors carry `.cm-editor` beside `&` on purpose: CodeMirror's base theme
 * paints a focused selection `#d7d4f0` with a four-class selector, and the
 * app never sets CodeMirror's dark flag, so that light-theme lavender used to
 * win over the app's own three-class rule -- light text on a light wash, on
 * a dark editor.
 */
const selectionTheme = EditorView.theme({
  "&.cm-editor > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--editor-selection-blur, var(--ucch-active-bg))",
  },
  "&.cm-editor.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
    background: "var(--editor-selection, var(--ucch-active-bg))",
  },
  // Below the selection layer, never over it: see `activeLineLayer`.
  "&.cm-editor > .cm-scroller > .cm-activeLineLayer .cm-activeLineBackground": {
    background: "color-mix(in oklch, var(--muted) 45%, transparent)",
  },
  // Search hits are marks on the text itself, so they are opaque and checked
  // for contrast like the selection; a fixed amber keeps them distinct from it.
  "&.cm-editor .cm-searchMatch": {
    backgroundColor: "var(--editor-search-match, var(--ucch-active-bg))",
  },
  "&.cm-editor .cm-searchMatch.cm-searchMatch-selected": {
    backgroundColor: "var(--editor-selection, var(--ucch-active-bg))",
    outline: "1px solid var(--ucch-active)",
  },
})

/**
 * The current line, drawn as a layer behind the selection layer rather than
 * as a background on the line element. A line background sits in the content
 * layer, above every layer marked `above: false`, so it tinted the selection
 * underneath it and the selection on the cursor's line read differently from
 * the rest. `Prec.lowest` puts this last in the layer order, which is the
 * lowest z-index: behind the selection, which is behind the text.
 */
const activeLineLayer = Prec.lowest(
  layer({
    above: false,
    class: "cm-activeLineLayer",
    update: (update) => update.selectionSet || update.docChanged || update.viewportChanged,
    markers(view) {
      const scroller = view.scrollDOM.getBoundingClientRect()
      const content = view.contentDOM.getBoundingClientRect()
      const baseLeft = scroller.left - view.scrollDOM.scrollLeft * view.scaleX
      const baseTop = scroller.top - view.scrollDOM.scrollTop * view.scaleY
      const markers: RectangleMarker[] = []
      const seen = new Set<number>()
      for (const range of view.state.selection.ranges) {
        const block = view.lineBlockAt(range.head)
        if (seen.has(block.from)) continue
        seen.add(block.from)
        markers.push(
          new RectangleMarker(
            "cm-activeLineBackground",
            (content.left - baseLeft) / view.scaleX,
            (view.documentTop + block.top * view.scaleY - baseTop) / view.scaleY,
            content.width / view.scaleX,
            block.height,
          ),
        )
      }
      return markers
    },
  }),
)

const selectedText = Decoration.mark({ class: "cm-selectedText" })

function selectedTextMarks(view: EditorView): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>()
  for (const range of view.state.selection.ranges) {
    if (!range.empty) builder.add(range.from, range.to, selectedText)
  }
  return builder.finish()
}

/**
 * Marks the selected text, so the last-resort ink -- when no selection
 * background could keep every token readable -- has something to colour. The
 * rule lives in globals.css, switched on from <html> only while an ink is in
 * force; otherwise the mark is inert and tokens keep their own colours.
 */
const selectedTextPlugin = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet
    constructor(view: EditorView) {
      this.decorations = selectedTextMarks(view)
    }
    update(update: ViewUpdate) {
      if (update.selectionSet || update.docChanged) this.decorations = selectedTextMarks(update.view)
    }
  },
  { decorations: (plugin) => plugin.decorations },
)

/**
 * The selection, active line and search-match styling, in place of
 * `highlightActiveLine()`. Install alongside `drawSelection()`, which hides
 * the native `::selection` so only the derived colour is ever painted.
 */
export function editorSelection(): Extension {
  return [selectionTheme, activeLineLayer, selectedTextPlugin]
}
