/**
 * The shipped palette as stylesheet text, for `scripts/gen-theme-css.ts` and
 * for the test that keeps `globals.css` in step with the engine.
 */
import { DEFAULT_SYNTAX_DARK, DEFAULT_SYNTAX_LIGHT, SYNTAX_ROLES } from "./syntax-theme.js"
import { DEFAULT_SETTINGS, themeVars } from "./theme.js"

export const GENERATED_START = "/* @generated theme-tokens: start -- scripts/gen-theme-css.ts */"
export const GENERATED_END = "/* @generated theme-tokens: end */"

export function generatedCss(): string {
  const lines = Object.entries(themeVars(DEFAULT_SETTINGS)).map(([name, value]) => `    --${name}: ${value};`)
  for (const role of SYNTAX_ROLES) {
    lines.push(`    --syn-${role.key}: light-dark(${DEFAULT_SYNTAX_LIGHT[role.key]}, ${DEFAULT_SYNTAX_DARK[role.key]});`)
  }
  return lines.join("\n")
}

/** The stylesheet with the block between the markers replaced. */
export function replaceGenerated(css: string, block: string): string {
  const start = css.indexOf(GENERATED_START)
  const end = css.indexOf(GENERATED_END)
  if (start < 0 || end < start) throw new Error("globals.css is missing the @generated theme-tokens markers")
  return css.slice(0, start + GENERATED_START.length) + "\n" + block + "\n    " + css.slice(end)
}

/** The block currently between the markers. */
export function currentGenerated(css: string): string {
  const start = css.indexOf(GENERATED_START) + GENERATED_START.length
  const end = css.indexOf(GENERATED_END)
  return css.slice(start, end).trim()
}
