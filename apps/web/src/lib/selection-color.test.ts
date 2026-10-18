import { describe, expect, it } from "vitest"

import { composite, contrast, defaultTokens, luminance } from "./color-engine"
import {
  COMMENT_MIN,
  editorSelectionTheme,
  ensureReadableSelection,
  schemeOf,
  selectionColors,
  selectionVars,
  TEXT_MIN,
  VISIBLE_MIN,
  type ReadableSelection,
  type SelectionTheme,
} from "./selection-color"
import { DEFAULT_SYNTAX_DARK, DEFAULT_SYNTAX_LIGHT } from "./syntax-theme"

describe("the colour maths it stands on", () => {
  it("knows the known pairs", () => {
    expect(contrast("#000000", "#ffffff")).toBeCloseTo(21, 5)
    expect(contrast("#777777", "#ffffff")).toBeCloseTo(4.48, 2)
    expect(luminance("#ffffff")).toBeCloseTo(1, 5)
    expect(luminance("#000000")).toBe(0)
    expect(composite("#ffffff", 0.5, "#000000")).toBe("#808080")
    expect(composite("#ff0000", 0, "#123456")).toBe("#123456")
  })

  it("reads the scheme off the background", () => {
    expect(schemeOf("#1e1e2e")).toBe("dark")
    expect(schemeOf("#808080")).toBe("dark")
    expect(schemeOf("#ffffff")).toBe("light")
  })
})

/** Every token reads on the selection, or selected text has an ink that does. */
function expectReadable(theme: SelectionTheme, selection: ReadableSelection) {
  if (selection.text) {
    expect(contrast(selection.text, selection.background)).toBeGreaterThanOrEqual(TEXT_MIN)
    return
  }
  for (const token of theme.tokens) {
    const need = Math.min(token.min, contrast(token.color, theme.background))
    expect(contrast(token.color, selection.background), `${token.name} on ${selection.background}`).toBeGreaterThanOrEqual(need - 1e-9)
  }
}

const dark = editorSelectionTheme(defaultTokens("dark"), null, "dark")
const light = editorSelectionTheme(defaultTokens("light"), null, "light")

const CASES: Array<[string, SelectionTheme]> = [
  ["default dark", dark],
  ["default light", light],
  // The reported bug: a light lavender accent on a dark editor.
  ["dark theme, light accent", { ...dark, accent: "#d7d4f0" }],
  ["light theme, dark accent", { ...light, accent: "#1e1b4b" }],
  ["mid-grey background", { ...dark, background: "#808080" }],
  ["dark theme, pure red accent", { ...dark, accent: "#ff0000" }],
  ["dark theme, pure yellow accent", { ...dark, accent: "#ffff00" }],
  ["light theme, pure red accent", { ...light, accent: "#ff0000" }],
  ["light theme, pure yellow accent", { ...light, accent: "#ffff00" }],
]

describe("selectionColors", () => {
  it.each(CASES)("%s: every token reads on focused, unfocused and search-match backgrounds", (_, theme) => {
    const colors = selectionColors(theme)
    expectReadable(theme, colors.focused)
    expectReadable(theme, colors.unfocused)
    expectReadable(theme, colors.searchMatch)
  })

  it.each(CASES)("%s: the selection is still visible against the background", (_, theme) => {
    const { focused, unfocused } = selectionColors(theme)
    expect(focused.background).not.toBe(theme.background)
    expect(unfocused.background).not.toBe(theme.background)
  })

  it("keeps the selection dark on a dark editor, even with a light accent", () => {
    const { focused } = selectionColors({ ...dark, accent: "#d7d4f0" })
    expect(schemeOf(focused.background)).toBe("dark")
    expect(luminance(focused.background)).toBeLessThan(0.15)
  })

  it.each(CASES)("%s: the unfocused selection is weaker than the focused one", (_, theme) => {
    const { focused, unfocused } = selectionColors(theme)
    expect(contrast(unfocused.background, theme.background)).toBeLessThan(contrast(focused.background, theme.background))
  })

  it.each(CASES)("%s: the focused selection stands off the background", (_, theme) => {
    expect(contrast(selectionColors(theme).focused.background, theme.background)).toBeGreaterThanOrEqual(VISIBLE_MIN - 1e-9)
  })

  it("holds comments to 3:1 and everything else to 4.5:1", () => {
    const comment = dark.tokens.find((t) => t.name === "comment")!
    expect(comment.min).toBe(COMMENT_MIN)
    expect(dark.tokens.filter((t) => t.name !== "comment").every((t) => t.min === TEXT_MIN)).toBe(true)
    expect(comment.color).toBe(DEFAULT_SYNTAX_DARK.comment)
    expect(light.tokens.find((t) => t.name === "keyword")!.color).toBe(DEFAULT_SYNTAX_LIGHT.keyword)
  })

  it("memoises per theme", () => {
    expect(selectionColors({ ...dark })).toBe(selectionColors({ ...dark }))
  })
})

describe("ensureReadableSelection", () => {
  it("leaves a wash that already reads alone", () => {
    const result = ensureReadableSelection({ background: "#000000", accent: "#666666", tokens: [{ name: "t", color: "#ffffff", min: 4.5 }] }, 0.3)
    expect(result.adjusted).toBe(false)
    expect(result.background).toBe(result.raw)
  })

  it("darkens a dark-scheme wash until light text reads", () => {
    const theme = { background: "#202020", accent: "#ffffff", tokens: [{ name: "t", color: "#c0c0c0", min: 4.5 }] }
    const result = ensureReadableSelection(theme, 0.6)
    expect(result.adjusted).toBe(true)
    expect(luminance(result.background)).toBeLessThan(luminance(result.raw))
    expect(contrast("#c0c0c0", result.background)).toBeGreaterThanOrEqual(4.5)
  })

  it("falls back to an ink for selected text when no background serves every token", () => {
    // Black and white text both at full contrast on the background: no
    // lightness of the wash can keep both at 4.5:1.
    const theme = {
      background: "#767676",
      accent: "#767676",
      tokens: [
        { name: "dark", color: "#000000", min: 4.5 },
        { name: "light", color: "#ffffff", min: 4.5 },
      ],
    }
    const result = ensureReadableSelection({ ...theme, background: "#777777" }, 0.3)
    expect(result.text).not.toBeNull()
    expect(contrast(result.text!, result.background)).toBeGreaterThanOrEqual(4.5)
  })
})

describe("selectionVars", () => {
  it("names every colour the editors read, and no ink when none is needed", () => {
    const colors = selectionColors(dark)
    expect(selectionVars(colors)).toEqual({
      "--editor-selection": colors.focused.background,
      "--editor-selection-blur": colors.unfocused.background,
      "--editor-search-match": colors.searchMatch.background,
      "--editor-selection-ink": "",
      "--editor-selection-blur-ink": "",
    })
  })
})
