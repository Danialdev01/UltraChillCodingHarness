import { composite, contrast, hexToOklch, luminance, oklchToHex, type Mode, type Tokens } from "./color-engine.js"
import { defaultSyntaxTheme, SYNTAX_ROLES, type SyntaxTheme } from "./syntax-theme.js"

/**
 * The code editor's selection colours, derived rather than picked.
 *
 * A selection is the accent washed into the editor's background, drawn
 * behind the text, so every token keeps its own colour. The wash is made
 * opaque here (composited onto the background) so its contrast against each
 * token can be measured exactly, and nudged until every token reads on it:
 * a light accent at full strength on a dark editor is what made selected
 * text unreadable, and a fixed alpha alone cannot promise anything once the
 * accent, the background and the syntax colours are all the person's own.
 *
 * Pure: the editor and the settings preview both call `selectionColors`.
 */

/** How much of the accent goes into the focused selection, per scheme. */
export const SELECTION_ALPHA: Record<Mode, number> = { dark: 0.3, light: 0.25 }
/** An unfocused selection is the same wash at this share of the strength. */
export const UNFOCUSED_SHARE = 0.6
/** Search matches: a fixed amber, so they never look like the selection. */
export const SEARCH_MATCH_HUE = "#eab308"
export const SEARCH_ALPHA: Record<Mode, number> = { dark: 0.35, light: 0.3 }

/**
 * How far a selection must stand off the background (as a contrast ratio)
 * to be seen at all. Without it, darkening a wash for the tokens' sake can
 * walk it back onto the background's own lightness.
 */
export const VISIBLE_MIN = 1.1

/** WCAG minimums: normal text, and comments (secondary by design). */
export const TEXT_MIN = 4.5
export const COMMENT_MIN = 3

/** A colour that must stay readable on the selection, and how readable. */
export interface SelectionToken {
  name: string
  color: string
  min: number
}

export interface SelectionTheme {
  /** The editor's effective background, opaque. */
  background: string
  /** The colour the person picked that selections are made from. */
  accent: string
  tokens: readonly SelectionToken[]
}

/** One selection background, and what was done to make it readable. */
export interface ReadableSelection {
  /** The background to paint, opaque. */
  background: string
  /** What the accent at the nominal strength would have been. */
  raw: string
  /** True when `background` had to move off `raw` for a token to read. */
  adjusted: boolean
  /** Last resort: a colour for selected text, when no background could serve every token. */
  text: string | null
  /** The weakest token on the final background, for the settings to show. */
  weakest: { name: string; ratio: number; min: number } | null
}

export interface SelectionColors {
  scheme: Mode
  focused: ReadableSelection
  unfocused: ReadableSelection
  searchMatch: ReadableSelection
}

/** Dark when the background's relative luminance is below one half. */
export function schemeOf(background: string): Mode {
  return luminance(background) < 0.5 ? "dark" : "light"
}

/**
 * What each token must reach on a selection: its minimum, but never more
 * than it already has on the bare background. A token the person made faint
 * on purpose is theirs to keep; a selection only must not make it worse.
 */
function targets(theme: SelectionTheme): Array<SelectionToken & { need: number }> {
  return theme.tokens.map((token) => ({
    ...token,
    need: Math.min(token.min, contrast(token.color, theme.background)),
  }))
}

function weakestOn(background: string, tokens: ReturnType<typeof targets>): ReadableSelection["weakest"] {
  let weakest: ReadableSelection["weakest"] = null
  for (const token of tokens) {
    const ratio = contrast(token.color, background)
    // Ranked by how close to its own floor each token is.
    if (!weakest || ratio / token.need < weakest.ratio / weakest.min) {
      weakest = { name: token.name, ratio, min: token.need }
    }
  }
  return weakest
}

const LIGHTNESS_STEP = 0.01

/**
 * Makes a selection background every token reads on.
 *
 * Starts from `raw`, the accent washed in at `alpha`. When a token fails, the
 * background's lightness moves a step at a time -- darker on a dark scheme,
 * lighter on a light one, keeping the accent's hue -- until all pass while
 * the selection still stands `visible` off the background. If that
 * direction runs out (a custom palette can have text on both sides of the
 * background), the other is tried. Only when no background serves every
 * token does it give up on the background and name a text colour to paint
 * selected text in instead.
 */
export function ensureReadableSelection(
  theme: SelectionTheme,
  alpha: number,
  visible = VISIBLE_MIN,
): ReadableSelection {
  const raw = composite(theme.accent, alpha, theme.background)
  const tokens = targets(theme)
  const passes = (background: string) =>
    contrast(background, theme.background) >= visible - 1e-9 &&
    tokens.every((t) => contrast(t.color, background) >= t.need - 1e-9)
  const done = (background: string, adjusted: boolean, text: string | null = null): ReadableSelection => ({
    background,
    raw,
    adjusted,
    text,
    weakest: text ? null : weakestOn(background, tokens),
  })

  if (passes(raw)) return done(raw, false)

  const scheme = schemeOf(theme.background)
  const first = scheme === "dark" ? -1 : 1
  const found = search(raw, first, passes)
  if (found) return done(found, true)

  // Nothing reads on any lightness of this hue: paint the selected text
  // itself near-white or near-black, whichever reads better on the wash, and
  // move the wash away from that ink until the two make normal-text contrast.
  const inks = ["#fafafa", "#111111"].sort((a, b) => contrast(b, raw) - contrast(a, raw))
  for (const ink of inks) {
    const away = ink === "#fafafa" ? -1 : 1
    const inkPasses = (background: string) =>
      contrast(ink, background) >= TEXT_MIN && contrast(background, theme.background) >= visible - 1e-9
    const background = inkPasses(raw) ? raw : search(raw, away, inkPasses, true)
    if (background) return done(background, true, ink)
  }
  return done(raw, true, inks[0])
}

/**
 * Steps `from`'s OKLCH lightness towards `first`, then the other way unless
 * `oneWay`, and returns the first colour that `passes`.
 */
function search(from: string, first: number, passes: (hex: string) => boolean, oneWay = false): string | null {
  const start = hexToOklch(from)
  for (const direction of oneWay ? [first] : [first, -first]) {
    for (let k = 1; k * LIGHTNESS_STEP <= 1; k++) {
      const l = start.l + direction * k * LIGHTNESS_STEP
      if (l < 0 || l > 1) break
      const candidate = oklchToHex({ ...start, l })
      if (passes(candidate)) return candidate
    }
  }
  return null
}

const cache = new Map<string, SelectionColors>()
const CACHE_LIMIT = 32

/**
 * Every selection colour the editor paints, for one theme. Memoised on the
 * theme's colours, so a re-render with the same palette is a lookup.
 */
export function selectionColors(theme: SelectionTheme): SelectionColors {
  const key = JSON.stringify([theme.background, theme.accent, theme.tokens.map((t) => [t.color, t.min])])
  const hit = cache.get(key)
  if (hit) return hit

  const scheme = schemeOf(theme.background)
  const focused = ensureReadableSelection(theme, SELECTION_ALPHA[scheme])
  // The unfocused selection is the focused one, readable as it is, washed in
  // at a share of the strength -- so it is always the weaker of the two, even
  // when the focused one had to move. Only half as far off the background.
  const unfocused = ensureReadableSelection(
    { ...theme, accent: focused.background },
    UNFOCUSED_SHARE,
    1 + (VISIBLE_MIN - 1) / 2,
  )
  const colors: SelectionColors = {
    scheme,
    focused,
    unfocused: focused.text && !unfocused.text ? { ...unfocused, text: focused.text } : unfocused,
    searchMatch: ensureReadableSelection({ ...theme, accent: SEARCH_MATCH_HUE }, SEARCH_ALPHA[scheme]),
  }
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value!)
  cache.set(key, colors)
  return colors
}

/**
 * The selection inputs for the code editor under the app's current theme:
 * its page colour as the background, the accent as the person's pick, and
 * the plain text plus every syntax colour (the custom set, or the defaults
 * for the scheme) as what must read on it.
 */
export function editorSelectionTheme(tokens: Tokens, syntax: SyntaxTheme | null, mode: Mode): SelectionTheme {
  const palette = syntax ?? defaultSyntaxTheme(mode === "dark")
  return {
    background: tokens.background!,
    accent: tokens["ucch-active"]!,
    tokens: [
      { name: "text", color: tokens.foreground!, min: TEXT_MIN },
      ...SYNTAX_ROLES.map((role) => ({
        name: role.key,
        color: palette[role.key],
        min: role.key === "comment" ? COMMENT_MIN : TEXT_MIN,
      })),
    ],
  }
}

/** The variables the editors read, name with `--`. */
export function selectionVars(colors: SelectionColors): Record<string, string> {
  return {
    "--editor-selection": colors.focused.background,
    "--editor-selection-blur": colors.unfocused.background,
    "--editor-search-match": colors.searchMatch.background,
    "--editor-selection-ink": colors.focused.text ?? "",
    "--editor-selection-blur-ink": colors.unfocused.text ?? "",
  }
}

/**
 * Paints the selection colours onto <html>. An ink is a variable plus an
 * attribute, because the rule that applies it must not exist when there is
 * none: an unset variable under `!important` would strip every token's colour.
 */
export function applySelectionColors(colors: SelectionColors, root?: HTMLElement): void {
  const element = root ?? globalThis.document?.documentElement
  if (!element) return
  for (const [name, value] of Object.entries(selectionVars(colors))) {
    if (value) element.style.setProperty(name, value)
    else element.style.removeProperty(name)
  }
  element.toggleAttribute("data-selection-ink", colors.focused.text !== null)
  element.toggleAttribute("data-selection-blur-ink", colors.unfocused.text !== null)
}
