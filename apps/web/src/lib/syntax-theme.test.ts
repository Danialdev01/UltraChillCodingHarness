import { describe, expect, it } from "vitest"
import {
  DEFAULT_SYNTAX_DARK,
  DEFAULT_SYNTAX_LIGHT,
  coercePreset,
  isPreset,
  isSyntaxTheme,
  normalizeSyntaxTheme,
  presetName,
  SYNTAX_ROLES,
  syntaxVars,
  upsertPreset,
} from "./syntax-theme.js"
import type { ThemeSettings } from "./theme.js"

describe("syntax theme shape", () => {
  it("ships a valid colour for every role, light and dark", () => {
    expect(isSyntaxTheme(DEFAULT_SYNTAX_LIGHT)).toBe(true)
    expect(isSyntaxTheme(DEFAULT_SYNTAX_DARK)).toBe(true)
  })

  it("rejects a set with a role missing or a colour that is not one", () => {
    const { keyword: _gone, ...missing } = DEFAULT_SYNTAX_LIGHT
    expect(isSyntaxTheme(missing)).toBe(false)
    expect(isSyntaxTheme({ ...DEFAULT_SYNTAX_LIGHT, string: "red" })).toBe(false)
    expect(isSyntaxTheme(null)).toBe(false)
  })

  it("normalises what it can and falls back per role for the rest", () => {
    const out = normalizeSyntaxTheme({ keyword: "ABC", string: "nope" }, DEFAULT_SYNTAX_LIGHT)
    expect(out.keyword).toBe("#aabbcc")
    expect(out.string).toBe(DEFAULT_SYNTAX_LIGHT.string)
    expect(out.comment).toBe(DEFAULT_SYNTAX_LIGHT.comment)
  })

  it("names one variable per role", () => {
    const vars = syntaxVars(DEFAULT_SYNTAX_LIGHT)
    expect(Object.keys(vars)).toHaveLength(SYNTAX_ROLES.length)
    expect(vars["syn-keyword"]).toBe(DEFAULT_SYNTAX_LIGHT.keyword)
  })
})

describe("presets", () => {
  const theme: ThemeSettings = { mode: "dark", source: { kind: "seed", seed: 7 }, highContrast: false, locked: false }
  const legacy = { dominant: "#111111", secondary: "#222222", accent: "#3b5bdb" }

  it("trims and bounds a name, and refuses an empty one", () => {
    expect(presetName("  Night   fall  ")).toBe("Night fall")
    expect(presetName("   ")).toBeNull()
    expect(presetName("x".repeat(60))).toHaveLength(40)
  })

  it("adds a new preset and replaces one saved under the same name", () => {
    let presets = upsertPreset([], { name: "Nightfall", theme, syntax: null })
    expect(presets).toHaveLength(1)
    const id = presets[0]!.id
    presets = upsertPreset(presets, { name: "nightfall", theme: null, syntax: DEFAULT_SYNTAX_DARK })
    expect(presets).toHaveLength(1)
    expect(presets[0]).toMatchObject({ id, name: "nightfall", theme: null, syntax: DEFAULT_SYNTAX_DARK })
    presets = upsertPreset(presets, { name: "Day", theme, syntax: null })
    expect(presets.map((p) => p.name)).toEqual(["nightfall", "Day"])
  })

  it("validates what comes out of storage", () => {
    expect(isPreset({ id: "a", name: "n", theme: null, syntax: null })).toBe(true)
    expect(isPreset({ id: "a", name: "n", theme, syntax: DEFAULT_SYNTAX_LIGHT })).toBe(true)
    expect(isPreset({ id: "a", name: "n", theme: { dominant: "x" }, syntax: null })).toBe(false)
    // Saved before modes existed: carried over as custom colours.
    expect(coercePreset({ id: "a", name: "n", theme: legacy, syntax: null })?.theme?.source).toEqual({ kind: "custom", ...legacy })
    expect(isPreset({ name: "n", theme: null, syntax: null })).toBe(false)
  })
})
