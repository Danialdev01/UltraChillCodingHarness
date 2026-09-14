/**
 * The whole harness's colour, derived from three choices.
 *
 * The palette is a 60-30-10 split rather than a list of tokens: a `dominant`
 * that carries the page (the 60), a `secondary` for the surfaces that sit on
 * it -- panels, hovers, borders (the 30), and an `accent` for the one thing
 * per screen that should pull the eye (the 10). Every shadcn variable in
 * `globals.css` is computed from those three, so a theme is three hex strings
 * and nothing else has to be kept in sync.
 *
 * Foregrounds are never chosen, only measured: `readableOn` picks near-white
 * or near-black by WCAG contrast against whatever surface the text or icon
 * actually sits on. That is what makes a light theme and a dark theme the
 * same code path -- pick a dark `dominant` and the text and icons flip to
 * white on their own, and the `dark` class follows so Tailwind's `dark:`
 * variants agree with what the eye sees.
 *
 * This module is deliberately free of DOM and React so the arithmetic can be
 * tested directly; `applyTheme` at the bottom is the only part that touches a
 * document.
 */

export interface Theme {
  /** 60% -- the page, and every large surface on it. */
  dominant: string
  /** 30% -- panels, rails, hovers, borders: the supporting surfaces. */
  secondary: string
  /** 10% -- selection, focus rings, primary buttons. Used sparingly. */
  accent: string
}

/** The palette the app ships with: neutral surfaces, one blue accent. */
export const DEFAULT_THEME: Theme = {
  dominant: "#ffffff",
  secondary: "#f1f1f3",
  accent: "#3b5bdb",
}

/** Where a chosen theme lives between visits. */
export const THEME_STORAGE_KEY = "ucch:theme"

/**
 * Where the chosen theme is *also* kept, so the server can paint it.
 *
 * A cookie as well as `localStorage` because only one of the two is readable
 * while the HTML is being generated. The root layout reads this and renders the
 * palette straight onto <html>, which is what makes the first paint already
 * themed -- with no blocking script, and nothing that depends on JavaScript
 * having run. `localStorage` stays the client's own copy, and the provider
 * mirrors one into the other.
 *
 * Three hex strings of JSON: small enough that putting it on every request is
 * not worth a second thought.
 */
export const THEME_COOKIE = "ucch_theme"

/** A year: a palette is not a session, and forgetting it would be a bug. */
const THEME_COOKIE_MAX_AGE = 60 * 60 * 24 * 365

/** The cookie value for a theme. */
export function serialiseThemeCookie(theme: Theme): string {
  return encodeURIComponent(JSON.stringify(theme))
}

/**
 * A theme out of a cookie value, or null when there is nothing usable in it.
 *
 * Null for every kind of wrong -- absent, truncated, not JSON, not hex -- and
 * the caller renders the shipped palette instead. A cookie is user-controlled
 * input, so `isTheme` is what stands between it and `deriveTheme`.
 */
export function parseThemeCookie(raw: string | undefined): Theme | null {
  if (!raw) return null
  try {
    const parsed: unknown = JSON.parse(decodeURIComponent(raw))
    return isTheme(parsed) ? parsed : null
  } catch {
    return null
  }
}

/**
 * Writes the cookie, or clears it when the theme is forgotten.
 *
 * Client-side: the palette is chosen in the browser, and this is how the next
 * server render gets to hear about it. `SameSite=Lax` because it is a
 * preference rather than a credential, and it has to survive arriving from an
 * external link.
 */
export function storeThemeCookie(theme: Theme | null): void {
  const document = globalThis.document
  if (!document) return
  document.cookie = theme
    ? `${THEME_COOKIE}=${serialiseThemeCookie(theme)}; path=/; max-age=${THEME_COOKIE_MAX_AGE}; samesite=lax`
    : `${THEME_COOKIE}=; path=/; max-age=0; samesite=lax`
}

/** The variables as a React `style` object, for rendering onto <html>. */
export function themeToStyle(theme: Theme): Record<string, string> {
  const style: Record<string, string> = {}
  for (const [name, value] of Object.entries(deriveTheme(theme).vars)) {
    style[`--${name}`] = value
  }
  return style
}

/**
 * The two inks. Not pure black and white: full-contrast text on a coloured
 * ground reads as a glare rather than as type, and every UI that looks
 * considered pulls both ends in a little.
 */
const INK_DARK = "#0b0b0c"
const INK_LIGHT = "#fafafa"

interface Rgb {
  r: number
  g: number
  b: number
}

/**
 * Reads `#rgb`, `#rrggbb`, or either without the hash. Returns null for
 * anything else -- callers treat that as "the user is still typing".
 */
export function parseHex(input: string): Rgb | null {
  const hex = input.trim().replace(/^#/, "")
  if (!/^[0-9a-fA-F]+$/.test(hex)) return null
  if (hex.length === 3) {
    const [r, g, b] = [...hex].map((c) => parseInt(c + c, 16))
    return { r: r!, g: g!, b: b! }
  }
  if (hex.length === 6) {
    return {
      r: parseInt(hex.slice(0, 2), 16),
      g: parseInt(hex.slice(2, 4), 16),
      b: parseInt(hex.slice(4, 6), 16),
    }
  }
  return null
}

const clampByte = (n: number) => Math.max(0, Math.min(255, Math.round(n)))

export function toHex({ r, g, b }: Rgb): string {
  return "#" + [r, g, b].map((c) => clampByte(c).toString(16).padStart(2, "0")).join("")
}

/** True when the string names a colour this module can work with. */
export function isValidHex(input: string): boolean {
  return parseHex(input) !== null
}

/** Normalises to lowercase `#rrggbb`, or returns the fallback if unparseable. */
export function normalizeHex(input: string, fallback: string): string {
  const rgb = parseHex(input)
  return rgb ? toHex(rgb) : fallback
}

const srgbToLinear = (channel: number) => {
  const v = channel / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

/** WCAG relative luminance, 0 (black) to 1 (white). */
export function luminance(hex: string): number {
  const rgb = parseHex(hex)
  if (!rgb) return 0
  return (
    0.2126 * srgbToLinear(rgb.r) + 0.7152 * srgbToLinear(rgb.g) + 0.0722 * srgbToLinear(rgb.b)
  )
}

/** WCAG contrast ratio between two colours, 1 (identical) to 21 (black/white). */
export function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x)
  return (hi! + 0.05) / (lo! + 0.05)
}

/** Blends `from` toward `to`; `amount` 0 keeps `from`, 1 becomes `to`. */
export function mix(from: string, to: string, amount: number): string {
  const a = parseHex(from)
  const b = parseHex(to)
  if (!a || !b) return from
  const t = Math.max(0, Math.min(1, amount))
  return toHex({
    r: a.r + (b.r - a.r) * t,
    g: a.g + (b.g - a.g) * t,
    b: a.b + (b.b - a.b) * t,
  })
}

/**
 * The ink -- text, icons, glyphs -- that reads best on a given surface.
 *
 * Measured rather than declared, so a component never has to know which
 * "mode" it is in: it asks what sits on this colour and gets white or near
 * black back.
 */
export function readableOn(surface: string): string {
  return contrast(surface, INK_LIGHT) >= contrast(surface, INK_DARK) ? INK_LIGHT : INK_DARK
}

/** Whether a surface wants light ink -- i.e. whether this reads as dark. */
export function isDarkSurface(surface: string): boolean {
  return readableOn(surface) === INK_LIGHT
}

/**
 * Moves a surface one step "up" from the page: lighter over a dark ground,
 * darker over a light one. What separates a card or a sidebar from the page
 * behind it without introducing a fourth colour.
 */
function layer(surface: string, amount: number): string {
  return mix(surface, isDarkSurface(surface) ? INK_LIGHT : INK_DARK, amount)
}

/** `rgb(r g b / p%)` -- a translucent wash of a colour, for selected rows. */
function alpha(hex: string, percent: number): string {
  const rgb = parseHex(hex)
  if (!rgb) return hex
  return `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${percent}%)`
}

/**
 * Pulls a colour until it is legible on a surface, walking it toward that
 * surface's ink in small steps. Used for the accent, which the user may pick
 * as a near-match for their background; a selection colour that cannot be
 * seen against the sidebar is the one failure this system must not allow.
 */
function ensureContrast(color: string, surface: string, ratio: number): string {
  const ink = readableOn(surface)
  let candidate = color
  for (let step = 0; step < 20 && contrast(candidate, surface) < ratio; step++) {
    candidate = mix(candidate, ink, 0.06)
  }
  return candidate
}

export interface DerivedTheme {
  /** Whether the palette reads as dark -- drives the `dark` class. */
  dark: boolean
  /** Every CSS custom property `globals.css` consumes, name without `--`. */
  vars: Record<string, string>
}

/**
 * Expands three colours into the full variable set.
 *
 * The mapping is the 60-30-10 split made literal: `dominant` becomes the
 * page and the cards, `secondary` the muted and hover surfaces and the
 * borders derived from them, `accent` the primary, the ring and the
 * selection. Foregrounds are computed per surface rather than once, because
 * a sidebar tinted toward `secondary` can land on the other side of the
 * contrast line from the page it sits beside.
 */
export function deriveTheme(theme: Theme): DerivedTheme {
  const dominant = normalizeHex(theme.dominant, DEFAULT_THEME.dominant)
  const secondary = normalizeHex(theme.secondary, DEFAULT_THEME.secondary)
  const accent = normalizeHex(theme.accent, DEFAULT_THEME.accent)

  const dark = isDarkSurface(dominant)
  const ink = readableOn(dominant)

  const card = layer(dominant, 0.04)
  const sidebar = mix(layer(dominant, 0.02), secondary, 0.35)
  const muted = mix(dominant, secondary, 0.75)
  const hover = mix(dominant, secondary, 0.9)
  const border = mix(dominant, secondary, 0.95)

  // The accent has to clear two different grounds: the page and the sidebar,
  // which is tinted away from it. 4.5:1 is the readable-text threshold, and
  // the accent is used as text (active nav items, links) as well as fill.
  const active = ensureContrast(ensureContrast(accent, sidebar, 4.5), dominant, 4.5)
  const solid = ensureContrast(accent, dominant, 3)

  const vars: Record<string, string> = {
    background: dominant,
    foreground: ink,

    card,
    "card-foreground": readableOn(card),
    popover: card,
    "popover-foreground": readableOn(card),

    // The 10%: filled buttons and anything else that claims to be the one
    // action on the screen.
    primary: solid,
    "primary-foreground": readableOn(solid),

    // The 30%: everything that supports without competing.
    secondary,
    "secondary-foreground": readableOn(secondary),
    muted,
    // Dimmed by pulling the ink back toward its own ground rather than by
    // opacity, so it stays correct over an opaque parent.
    "muted-foreground": mix(readableOn(muted), muted, 0.42),
    accent: hover,
    "accent-foreground": readableOn(hover),

    // Red stays red -- a destructive action is not a matter of taste -- but
    // shifts brightness so it is legible on either kind of ground.
    destructive: dark ? "#f2555a" : "#d13438",

    border,
    input: mix(border, ink, 0.08),
    ring: active,

    // A ramp from the accent to the supporting colour: distinguishable in
    // series, and still recognisably this theme.
    "chart-1": active,
    "chart-2": mix(active, secondary, 0.25),
    "chart-3": mix(active, secondary, 0.5),
    "chart-4": mix(active, secondary, 0.7),
    "chart-5": mix(active, ink, 0.35),

    sidebar,
    "sidebar-foreground": readableOn(sidebar),
    "sidebar-primary": active,
    "sidebar-primary-foreground": readableOn(active),
    "sidebar-accent": mix(sidebar, secondary, 0.55),
    "sidebar-accent-foreground": readableOn(mix(sidebar, secondary, 0.55)),
    "sidebar-border": mix(sidebar, secondary, 0.95),
    "sidebar-ring": active,

    "ucch-active": active,
    "ucch-active-bg": alpha(active, dark ? 18 : 12),
  }

  return { dark, vars }
}

/** The variable block as inline-style text, for the pre-paint script. */
export function themeToCss(vars: Record<string, string>): string {
  return Object.entries(vars)
    .map(([name, value]) => `--${name}:${value}`)
    .join(";")
}

const HUE = 360

/**
 * A colour from hue (0-360), saturation and lightness (both 0-100).
 *
 * Randomising in HSL rather than in RGB is the whole trick: hue picks the
 * family, and holding lightness inside a band is what keeps a random palette
 * from producing an unreadable one.
 */
export function hslToHex(h: number, s: number, l: number): string {
  const hue = ((h % HUE) + HUE) % HUE
  const sat = Math.max(0, Math.min(100, s)) / 100
  const light = Math.max(0, Math.min(100, l)) / 100
  const c = (1 - Math.abs(2 * light - 1)) * sat
  const x = c * (1 - Math.abs(((hue / 60) % 2) - 1))
  const m = light - c / 2
  const [r, g, b] = (
    [
      [c, x, 0],
      [x, c, 0],
      [0, c, x],
      [0, x, c],
      [x, 0, c],
      [c, 0, x],
    ] as const
  )[Math.floor(hue / 60) % 6]!
  return toHex({ r: (r + m) * 255, g: (g + m) * 255, b: (b + m) * 255 })
}

/**
 * A random 60-30-10 palette that is actually usable.
 *
 * Not three independent random colours: one hue is drawn, the 60 and the 30
 * are near-neutral tints of it inside a lightness band, and the 10 is thrown
 * across the wheel at full saturation. That is the rule the split describes
 * -- a quiet ground and one loud note -- and constraining lightness per mode
 * means every roll comes back legible instead of most of them.
 *
 * `rng` is injectable so the shape of the output can be tested; `mode` forces
 * a light or dark result, and is left out to let the roll decide.
 */
export function randomTheme(
  rng: () => number = Math.random,
  mode?: "light" | "dark",
): Theme {
  const between = (min: number, max: number) => min + rng() * (max - min)
  const dark = mode ? mode === "dark" : rng() < 0.5
  const hue = between(0, HUE)
  // Far enough around the wheel to read as a different colour, short of the
  // exact complement, which tends to vibrate against the ground.
  const accentHue = hue + between(140, 220)

  return dark
    ? {
        dominant: hslToHex(hue, between(6, 18), between(8, 14)),
        secondary: hslToHex(hue, between(10, 24), between(22, 30)),
        accent: hslToHex(accentHue, between(60, 90), between(58, 70)),
      }
    : {
        dominant: hslToHex(hue, between(8, 22), between(96, 99)),
        secondary: hslToHex(hue, between(10, 26), between(88, 93)),
        accent: hslToHex(accentHue, between(55, 85), between(40, 52)),
      }
}

/** Whether a value off `localStorage` or an API is a usable theme. */
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

/** What is written to storage: the choice, plus what the pre-paint script needs. */
interface StoredTheme {
  theme: Theme
  css: string
  dark: boolean
}

/**
 * The saved theme, or null if there is none.
 *
 * Guarded like every other preference here: `localStorage` throws outright in
 * a private window with site data blocked, and the app has a perfectly good
 * default to fall back to.
 */
export function readStoredTheme(): Theme | null {
  try {
    const raw = globalThis.localStorage?.getItem(THEME_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StoredTheme>
    return isTheme(parsed?.theme) ? parsed.theme : null
  } catch {
    return null
  }
}

/** Saves a theme, or forgets it (and returns to the default) when given null. */
export function storeTheme(theme: Theme | null): void {
  try {
    if (!theme) {
      globalThis.localStorage?.removeItem(THEME_STORAGE_KEY)
      return
    }
    const { dark, vars } = deriveTheme(theme)
    // The derived CSS is stored beside the choice so the blocking script in
    // <head> can paint the theme without shipping this module's arithmetic
    // twice -- once here and once as a string in the document.
    const payload: StoredTheme = { theme, css: themeToCss(vars), dark }
    globalThis.localStorage?.setItem(THEME_STORAGE_KEY, JSON.stringify(payload))
  } catch {
    /* nothing to do: the theme simply is not remembered */
  }
}

/**
 * Paints a theme onto a live document, or strips it back to the stylesheet's
 * own values when given null.
 *
 * The `dark` class goes on the same element as the variables so Tailwind's
 * `dark:` variants -- which a handful of components still use directly --
 * agree with the ink the variables resolved to.
 */
export function applyTheme(theme: Theme | null, root?: HTMLElement): void {
  const element = root ?? globalThis.document?.documentElement
  if (!element) return

  if (!theme) {
    for (const name of Object.keys(deriveTheme(DEFAULT_THEME).vars)) {
      element.style.removeProperty(`--${name}`)
    }
    element.classList.remove("dark")
    return
  }

  const { dark, vars } = deriveTheme(theme)
  for (const [name, value] of Object.entries(vars)) {
    element.style.setProperty(`--${name}`, value)
  }
  element.classList.toggle("dark", dark)
}
