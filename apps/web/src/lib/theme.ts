/**
 * The harness's theme: which palette, in which mode, and how it is kept.
 *
 * The colours themselves come from `color-engine.ts`; this module holds the
 * user's choice and turns it into CSS. A choice is small on purpose -- the
 * rules (`docs/color-and-theme.md`) say to store the seed, not the hex values:
 *
 * - `mode`: Light, Dark or System. System is the default and follows the OS.
 * - `source`: the shipped palette, a seed (plus an optional hue picked on the
 *   slider), or three custom hex colours for people who insist. Custom colours
 *   go through the same contrast repair and validation as everything else.
 * - `highContrast`: raises every text target from 4.5:1 to 7:1.
 *
 * Both modes are always generated from the same choice, and every variable is
 * written as `light-dark(<light>, <dark>)`. The browser picks the side from
 * `color-scheme`, which the root's `data-theme-mode` sets in the stylesheet --
 * so System follows the OS before first paint and on every change after, with
 * no script at all.
 *
 * DOM-free apart from the storage and paint helpers at the end, so the
 * arithmetic can be tested directly.
 */

import {
  buildTokens,
  CHROMA_RANGE,
  clampHue,
  contrast,
  DEFAULT_ACCENT,
  defaultTokens,
  hexToOklch,
  luminance,
  parseHex,
  seedToAccent,
  toHex,
  type BuiltTokens,
  type Mode,
  type Tokens,
} from "./color-engine.js"

export { contrast, luminance, parseHex, toHex, type Mode, type Tokens }

/** Three custom colours: the page, the tint for panels, and the accent. */
export interface Theme {
  /** The page, and every large surface on it. */
  dominant: string
  /** Tints panels, hovers and borders; their lightness is set for readability. */
  secondary: string
  /** Selection, focus rings, the primary button. */
  accent: string
}

export type ThemeMode = "light" | "dark" | "system"

export type ThemeSource =
  | { kind: "default" }
  /** `hue` is set when picked on the slider; otherwise the seed decides it. */
  | { kind: "seed"; seed: number; hue?: number }
  | ({ kind: "custom" } & Theme)

export interface ThemeSettings {
  mode: ThemeMode
  source: ThemeSource
  highContrast: boolean
  /** Shuffle is disabled while locked, so a palette you like stays put. */
  locked: boolean
}

export const DEFAULT_SETTINGS: ThemeSettings = {
  mode: "system",
  source: { kind: "default" },
  highContrast: false,
  locked: false,
}

/** The custom colours a fresh "Advanced" panel starts from. */
export const DEFAULT_THEME: Theme = {
  dominant: "#ffffff",
  secondary: "#f1f1f3",
  accent: "#3b5bdb",
}

/**
 * Whether the palette differs from the stylesheet's own -- i.e. whether there
 * are variables to paint at all. Mode alone needs only the attribute.
 */
export function needsInlineVars(settings: ThemeSettings): boolean {
  return settings.source.kind !== "default" || settings.highContrast
}

/** Whether the settings are the shipped ones -- nothing to paint over the stylesheet. */
export function isDefaultSettings(settings: ThemeSettings): boolean {
  return (
    settings.source.kind === "default" &&
    settings.mode === "system" &&
    !settings.highContrast
  )
}

// -- Hex helpers -------------------------------------------------------------

/** True when the string names a colour this module can work with. */
export function isValidHex(input: string): boolean {
  return parseHex(input) !== null
}

/** Normalises to lowercase `#rrggbb`, or returns the fallback if unparseable. */
export function normalizeHex(input: string, fallback: string): string {
  const rgb = parseHex(input)
  return rgb ? toHex(rgb) : fallback
}

/** Near-white or near-black, whichever reads better on a swatch. For previews only. */
export function readableOn(surface: string): string {
  return contrast(surface, "#fafafa") >= contrast(surface, "#0b0b0c") ? "#fafafa" : "#0b0b0c"
}

/** Whether a colour reads as a dark surface. */
export function isDarkSurface(surface: string): boolean {
  return readableOn(surface) === "#fafafa"
}

// -- From a choice to tokens -------------------------------------------------

/** The mode actually on screen, given whether the OS prefers dark. */
export function resolveMode(mode: ThemeMode, prefersDark: boolean): Mode {
  return mode === "system" ? (prefersDark ? "dark" : "light") : mode
}

/** The accent a seed or slider choice resolves to. */
export function accentOf(source: ThemeSource): { hue: number; chroma: number } {
  if (source.kind === "seed") {
    const fromSeed = seedToAccent(source.seed)
    return source.hue === undefined ? fromSeed : { hue: clampHue(source.hue), chroma: fromSeed.chroma }
  }
  if (source.kind === "custom") {
    const { h, c } = hexToOklch(normalizeHex(source.accent, DEFAULT_THEME.accent))
    return { hue: h, chroma: c }
  }
  return DEFAULT_ACCENT
}

const tokenCache = new Map<string, BuiltTokens>()

/**
 * The validated tokens for one mode. Falls back to the shipped palette for a
 * choice that fails any contrast check -- see `buildTokens`.
 *
 * Custom colours paint their own mode exactly as picked (after repair); the
 * other mode is generated from the accent's hue, so switching modes keeps
 * the same brand colour rather than inverting.
 */
export function resolveTokens(settings: ThemeSettings, mode: Mode): BuiltTokens {
  const key = JSON.stringify([settings.source, settings.highContrast, mode])
  const cached = tokenCache.get(key)
  if (cached) return cached

  const { source, highContrast } = settings
  let built: BuiltTokens
  if (source.kind === "default") {
    built = { tokens: defaultTokens(mode, highContrast), fellBack: false, failures: [] }
  } else if (source.kind === "seed") {
    const { hue, chroma } = accentOf(source)
    built = buildTokens({ mode, accentHue: hue, accentChroma: chroma, highContrast }, `seed ${source.seed}`)
  } else {
    const dominant = normalizeHex(source.dominant, DEFAULT_THEME.dominant)
    const accent = hexToOklch(normalizeHex(source.accent, DEFAULT_THEME.accent))
    const secondary = hexToOklch(normalizeHex(source.secondary, DEFAULT_THEME.secondary))
    const ownMode: Mode = isDarkSurface(dominant) ? "dark" : "light"
    built =
      mode === ownMode
        ? buildTokens(
            {
              mode,
              highContrast,
              accentHue: accent.h,
              accentChroma: accent.c,
              accentL: accent.l,
              neutralHue: secondary.h,
              // Panels are a tint, never a colour: past this they compete with the accent.
              neutralChroma: Math.min(secondary.c, 0.04),
              bgExact: dominant,
            },
            "custom colours",
          )
        : buildTokens(
            {
              mode,
              highContrast,
              accentHue: clampHue(accent.h),
              accentChroma: Math.max(CHROMA_RANGE[0], Math.min(CHROMA_RANGE[1], accent.c)),
            },
            "custom colours (other mode)",
          )
  }
  tokenCache.set(key, built)
  if (tokenCache.size > 64) tokenCache.delete(tokenCache.keys().next().value!)
  return built
}

/** Every variable as `light-dark(<light>, <dark>)`, name without `--`. */
export function themeVars(settings: ThemeSettings): Record<string, string> {
  const light = resolveTokens(settings, "light").tokens
  const dark = resolveTokens(settings, "dark").tokens
  const vars: Record<string, string> = {}
  for (const name of Object.keys(light)) {
    vars[name] = light[name] === dark[name] ? light[name]! : `light-dark(${light[name]}, ${dark[name]})`
  }
  return vars
}

/** The variables as a React `style` object, for rendering onto <html>. */
export function themeToStyle(settings: ThemeSettings): Record<string, string> {
  const style: Record<string, string> = {}
  for (const [name, value] of Object.entries(themeVars(settings))) style[`--${name}`] = value
  return style
}

export interface ContrastRow {
  label: string
  /** The ratio of the colour as picked. */
  picked: number
  /** The ratio after repair -- what is on screen. */
  shown: number
  min: number
}

/**
 * How custom colours measure, as picked and as shown, for the live readout
 * beside the pickers. The rules forbid arbitrary colours without validation;
 * this is the validation made visible.
 */
export function customReport(theme: Theme, highContrast = false): { rows: ContrastRow[]; fellBack: boolean } {
  const dominant = normalizeHex(theme.dominant, DEFAULT_THEME.dominant)
  const accent = normalizeHex(theme.accent, DEFAULT_THEME.accent)
  const mode: Mode = isDarkSurface(dominant) ? "dark" : "light"
  const built = resolveTokens(
    { ...DEFAULT_SETTINGS, highContrast, source: { kind: "custom", ...theme } },
    mode,
  )
  const t = built.tokens
  const text = highContrast ? 7 : 4.5
  return {
    fellBack: built.fellBack,
    rows: [
      {
        label: "Text on hover rows",
        picked: contrast(t.foreground!, t.accent!),
        shown: contrast(t.foreground!, t.accent!),
        min: text,
      },
      {
        label: "Accent button on page",
        picked: contrast(accent, dominant),
        shown: contrast(t.primary!, t.background!),
        min: 3,
      },
      {
        label: "Button label on accent",
        picked: Math.max(contrast(accent, "#ffffff"), contrast(accent, "#0b0d13")),
        shown: contrast(t["primary-foreground"]!, t.primary!),
        min: text,
      },
      {
        label: "Accent as link text",
        picked: contrast(accent, t.accent!),
        shown: contrast(t["ucch-active"]!, t.accent!),
        min: text,
      },
    ],
  }
}

// -- Reading a stored choice -------------------------------------------------

/** Whether a value is three usable custom colours. */
export function isTheme(value: unknown): value is Theme {
  if (typeof value !== "object" || value === null) return false
  const t = value as Record<string, unknown>
  return (
    typeof t.dominant === "string" &&
    typeof t.secondary === "string" &&
    typeof t.accent === "string" &&
    isValidHex(t.dominant) &&
    isValidHex(t.secondary) &&
    isValidHex(t.accent)
  )
}

const MODES: readonly ThemeMode[] = ["light", "dark", "system"]

function coerceSource(value: unknown): ThemeSource | null {
  if (typeof value !== "object" || value === null) return null
  const s = value as Record<string, unknown>
  if (s.kind === "default") return { kind: "default" }
  if (s.kind === "seed" && typeof s.seed === "number" && Number.isFinite(s.seed)) {
    const seed = Math.floor(Math.abs(s.seed)) >>> 0
    if (typeof s.hue === "number" && Number.isFinite(s.hue)) return { kind: "seed", seed, hue: clampHue(s.hue) }
    return { kind: "seed", seed }
  }
  if (s.kind === "custom" && isTheme(s)) {
    return {
      kind: "custom",
      dominant: normalizeHex(s.dominant, DEFAULT_THEME.dominant),
      secondary: normalizeHex(s.secondary, DEFAULT_THEME.secondary),
      accent: normalizeHex(s.accent, DEFAULT_THEME.accent),
    }
  }
  return null
}

/**
 * Settings out of anything stored, or null if nothing usable is in it.
 *
 * Accepts the old shape too -- three bare hex colours, from before modes
 * existed -- and carries it over as custom colours in a fixed mode, so
 * nobody's palette changes under them on upgrade.
 */
export function coerceSettings(value: unknown): ThemeSettings | null {
  if (isTheme(value)) {
    const source = coerceSource({ kind: "custom", ...value })!
    return {
      ...DEFAULT_SETTINGS,
      mode: isDarkSurface(value.dominant) ? "dark" : "light",
      source,
    }
  }
  if (typeof value !== "object" || value === null) return null
  const v = value as Record<string, unknown>
  const source = coerceSource(v.source)
  if (!source || !MODES.includes(v.mode as ThemeMode)) return null
  return {
    mode: v.mode as ThemeMode,
    source,
    highContrast: v.highContrast === true,
    locked: v.locked === true,
  }
}

// -- The cookie --------------------------------------------------------------

/**
 * Where the choice is kept so the server can paint it.
 *
 * A cookie because only it is readable while the HTML is being generated. The
 * root layout reads it and renders the variables straight onto <html>, which
 * is what makes the first paint already themed -- with no blocking script, and
 * nothing that depends on JavaScript having run. `localStorage` holds a copy
 * so other tabs hear about a change.
 */
export const THEME_COOKIE = "ucch_theme"

/** A year: a palette is not a session, and forgetting it would be a bug. */
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

export function serialiseThemeCookie(settings: ThemeSettings): string {
  return encodeURIComponent(JSON.stringify(settings))
}

/**
 * Settings out of a cookie value, or null for every kind of wrong -- absent,
 * truncated, not JSON, not a theme. A cookie is user-controlled input, and
 * `coerceSettings` is what stands between it and the engine.
 */
export function parseThemeCookie(raw: string | undefined): ThemeSettings | null {
  if (!raw) return null
  try {
    return coerceSettings(JSON.parse(decodeURIComponent(raw)))
  } catch {
    return null
  }
}

/** Writes the cookie, or clears it when the choice is back to the default. */
export function storeThemeCookie(settings: ThemeSettings | null): void {
  const document = globalThis.document
  if (!document) return
  document.cookie =
    settings && !isDefaultSettings(settings)
      ? `${THEME_COOKIE}=${serialiseThemeCookie(settings)}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`
      : `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`
}

// -- Storage -----------------------------------------------------------------

/** Where the choice lives between visits, alongside the cookie. */
export const THEME_STORAGE_KEY = "ucch:theme"

/**
 * The saved choice, or null if there is none. Guarded like every other
 * preference here: `localStorage` throws in a private window with site data
 * blocked. The old `{ theme, css, dark }` payload is read too.
 */
export function readStoredTheme(): ThemeSettings | null {
  try {
    const raw = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Record<string, unknown> | null
    return coerceSettings(parsed && "theme" in parsed ? parsed.theme : parsed)
  } catch {
    return null
  }
}

/** Saves a choice, or forgets it when given null or the default. */
export function storeTheme(settings: ThemeSettings | null): void {
  try {
    if (!settings || isDefaultSettings(settings)) {
      globalThis.localStorage?.removeItem(THEME_STORAGE_KEY)
      return
    }
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, JSON.stringify(settings))
  } catch {
    /* nothing to do: the theme simply is not remembered */
  }
}

// -- Painting ----------------------------------------------------------------

/** Every variable name the engine writes, for stripping them again. */
const ALL_VARS = Object.keys(defaultTokens("light"))

/**
 * Paints a choice onto a live document, or strips it back to the stylesheet's
 * own values when given null or the default.
 *
 * `data-theme-mode` drives `color-scheme` in the stylesheet, which is what
 * makes each `light-dark()` pick its side. The `dark` class is set only for
 * a forced Dark; on System the `dark:` variant follows the OS through a media
 * query instead (see `@custom-variant dark` in globals.css).
 */
export function applyTheme(settings: ThemeSettings | null, root?: HTMLElement): void {
  const element = root ?? globalThis.document?.documentElement
  if (!element) return
  const s = settings ?? DEFAULT_SETTINGS

  element.setAttribute?.("data-theme-mode", s.mode)
  element.classList.toggle("dark", s.mode === "dark")

  if (!needsInlineVars(s)) {
    for (const name of ALL_VARS) element.style.removeProperty(`--${name}`)
    return
  }
  for (const [name, value] of Object.entries(themeVars(s))) {
    element.style.setProperty(`--${name}`, value)
  }
}
