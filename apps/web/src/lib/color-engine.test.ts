import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import {
  ansiPalette,
  buildTokens,
  clampHue,
  contrast,
  defaultTokens,
  gamutMap,
  generateTokens,
  hexToOklch,
  HUE_EXCLUSION,
  isExcludedHue,
  oklchToHex,
  seedToAccent,
  validate,
  type Mode,
} from "./color-engine.js"
import { DEFAULT_SYNTAX_DARK, DEFAULT_SYNTAX_LIGHT } from "./syntax-theme.js"
import { currentGenerated, generatedCss } from "./theme-css.js"

const MODES: Mode[] = ["light", "dark"]

/**
 * The guarantee the colour rules ask for (doc §3.5): at least 10,000 seeds in
 * both modes, zero contrast failures. Re-run whenever the role table, the
 * chroma range or the exclusion zones change -- which this does on its own,
 * since it runs with everything else.
 */
describe("every generated theme passes", () => {
  for (const highContrast of [false, true]) {
    it(`10,000 seeds × light and dark${highContrast ? ", high contrast" : ""}`, () => {
      const failing: string[] = []
      for (let seed = 0; seed < 10_000; seed++) {
        const { hue, chroma } = seedToAccent(seed)
        for (const mode of MODES) {
          const failures = validate(generateTokens({ mode, accentHue: hue, accentChroma: chroma, highContrast }), mode, highContrast)
          if (failures.length) failing.push(`seed ${seed} ${mode}: ${failures[0]!.fg} on ${failures[0]!.bg} = ${failures[0]!.ratio.toFixed(2)}`)
        }
      }
      expect(failing.slice(0, 5)).toEqual([])
    }, 60_000)
  }

  it("covers every hue on the slider, not only the ones seeds land on", () => {
    for (let hue = 0; hue < 360; hue++) {
      for (const mode of MODES) {
        for (const chroma of [0.11, 0.18]) {
          expect(validate(generateTokens({ mode, accentHue: clampHue(hue), accentChroma: chroma }), mode)).toEqual([])
        }
      }
    }
  })
})

describe("seeds and hues", () => {
  it("gives the same theme for the same seed", () => {
    expect(generateTokens({ mode: "light", ...accentSpec(1234) })).toEqual(generateTokens({ mode: "light", ...accentSpec(1234) }))
  })

  it("never lands an accent near danger red or success green", () => {
    for (let seed = 0; seed < 5000; seed++) {
      expect(isExcludedHue(seedToAccent(seed).hue)).toBe(false)
    }
  })

  it("pushes a slider hue out of an exclusion zone to its edge", () => {
    expect(isExcludedHue(clampHue(27))).toBe(false)
    expect(isExcludedHue(clampHue(150))).toBe(false)
    expect(clampHue(150 + HUE_EXCLUSION - 1)).toBeCloseTo(150 + HUE_EXCLUSION)
    expect(clampHue(200)).toBe(200)
  })

  it("keeps chroma inside the band", () => {
    for (let seed = 0; seed < 1000; seed++) {
      const { chroma } = seedToAccent(seed)
      expect(chroma).toBeGreaterThanOrEqual(0.11)
      expect(chroma).toBeLessThanOrEqual(0.18)
    }
  })
})

describe("OKLCH", () => {
  it("maps out-of-gamut colours by chroma alone, keeping lightness and hue", () => {
    const wild = { l: 0.7, c: 0.4, h: 150 }
    const mapped = gamutMap(wild)
    expect(mapped.l).toBe(0.7)
    expect(mapped.h).toBe(150)
    expect(mapped.c).toBeLessThan(0.4)
    const back = hexToOklch(oklchToHex(wild))
    expect(back.l).toBeCloseTo(0.7, 2)
    expect(Math.abs(back.h - 150)).toBeLessThan(2)
  })

  it("round-trips a hex colour", () => {
    for (const hex of ["#3b5bdb", "#ffffff", "#000000", "#d13438", "#22aa66"]) {
      expect(oklchToHex(hexToOklch(hex))).toBe(hex)
    }
  })
})

describe("the rules' other requirements", () => {
  it("never uses pure black for a dark background, or pure white for dark-mode text", () => {
    const dark = defaultTokens("dark")
    expect(dark.background).not.toBe("#000000")
    expect(dark.foreground).not.toBe("#ffffff")
  })

  it("lightens surfaces with elevation in dark mode", () => {
    const dark = defaultTokens("dark")
    const l = (name: string) => hexToOklch(dark[name]!).l
    expect(l("background")).toBeLessThan(l("sidebar"))
    expect(l("sidebar")).toBeLessThan(l("card"))
  })

  it("keeps semantic colours on their hues whatever the accent", () => {
    const a = generateTokens({ mode: "light", accentHue: 90, accentChroma: 0.15 })
    const b = generateTokens({ mode: "light", accentHue: 300, accentChroma: 0.15 })
    for (const name of ["danger", "warning", "success", "info"]) expect(a[name]).toBe(b[name])
  })

  it("falls back to the default when a theme fails, and says which", () => {
    // A page colour so mid-grey that 7:1 text is impossible on it.
    const original = console.warn
    console.warn = () => {}
    const built = buildTokens({ mode: "light", accentHue: 260, accentChroma: 0.15, highContrast: true, bgExact: "#777777" })
    console.warn = original
    expect(built.fellBack).toBe(true)
    expect(built.failures.length).toBeGreaterThan(0)
    expect(built.tokens).toEqual(defaultTokens("light", true))
  })

  it("ships a default that passes", () => {
    for (const mode of MODES) {
      expect(validate(defaultTokens(mode), mode)).toEqual([])
      expect(validate(defaultTokens(mode, true), mode, true)).toEqual([])
    }
  })
})

describe("special surfaces", () => {
  it("gives every terminal colour 4.5:1 on its background, bright-black included", () => {
    for (let seed = 0; seed < 200; seed++) {
      for (const mode of MODES) {
        const bg = generateTokens({ mode, ...accentSpec(seed) }).background!
        const ansi = ansiPalette(mode, bg)
        // The ground-coloured slot in each mode is meant as a background.
        const skip = mode === "light" ? ["white", "brightWhite"] : ["black"]
        for (const [name, color] of Object.entries(ansi)) {
          if (skip.includes(name)) continue
          expect(contrast(color, bg), `${mode} ${name}`).toBeGreaterThanOrEqual(4.5)
        }
      }
    }
  })

  it("keeps the shipped syntax colours at 4.5:1 on every editor surface", () => {
    for (let seed = 0; seed < 500; seed++) {
      for (const mode of MODES) {
        const t = generateTokens({ mode, ...accentSpec(seed) })
        const syntax = mode === "light" ? DEFAULT_SYNTAX_LIGHT : DEFAULT_SYNTAX_DARK
        for (const [role, color] of Object.entries(syntax)) {
          for (const surface of ["background", "card", "muted"]) {
            expect(contrast(color, t[surface]!), `${mode} ${role} on ${surface}`).toBeGreaterThanOrEqual(4.5)
          }
        }
      }
    }
  })

  it("spaces chart hues by the golden angle", () => {
    const t = generateTokens({ mode: "light", accentHue: 200, accentChroma: 0.15 })
    const h1 = hexToOklch(t["chart-1"]!).h
    const h2 = hexToOklch(t["chart-2"]!).h
    const d = Math.abs(h2 - h1)
    expect(Math.min(d, 360 - d)).toBeGreaterThan(60)
  })
})

describe("the stylesheet", () => {
  it("holds the same default palette the engine generates", () => {
    const css = readFileSync(fileURLToPath(new URL("../app/globals.css", import.meta.url)), "utf8")
    // Out of step means someone hand-edited one side: run scripts/gen-theme-css.ts.
    expect(currentGenerated(css)).toBe(generatedCss().trim())
  })
})

function accentSpec(seed: number) {
  const { hue, chroma } = seedToAccent(seed)
  return { accentHue: hue, accentChroma: chroma }
}
