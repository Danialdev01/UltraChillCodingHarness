/**
 * The colour engine: every colour in the harness comes out of here.
 *
 * The rules it implements live in `docs/color-and-theme.md`. In short: work in
 * OKLCH, where equal lightness looks equally bright on every hue; randomise
 * only the accent's hue and a narrow chroma band; fix lightness per role and
 * per mode; repair contrast by stepping lightness (never hue); validate every
 * pair the rules name; and fall back to the shipped palette if anything still
 * fails. A theme is therefore a seed (or a hue), not a list of hex values.
 *
 * The output is the CSS variable set `globals.css` consumes, keyed by name
 * without the leading `--`. The shadcn names are kept so the generated
 * components under `ui/` read them unchanged; the roles the rules add that
 * shadcn has no name for (`text-subtle`, `warning`, `chart-6`, ...) are added
 * beside them. See the mapping table in the doc.
 *
 * DOM-free, so the whole thing is tested directly -- including the 10,000-seed
 * sweep that is the actual guarantee.
 */

// -- sRGB and contrast -------------------------------------------------------

export interface Rgb {
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

const srgbToLinear = (channel: number) => {
  const v = channel / 255
  return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4
}

const linearToSrgb = (v: number) =>
  255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055)

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

/**
 * A translucent colour composited over an opaque one, as the browser paints
 * it (in gamma-encoded sRGB). What a `--ucch-active-bg` row actually looks
 * like, so text on it can be measured.
 */
export function composite(over: string, alpha: number, under: string): string {
  const a = parseHex(over)
  const b = parseHex(under)
  if (!a || !b) return under
  return toHex({
    r: b.r + (a.r - b.r) * alpha,
    g: b.g + (a.g - b.g) * alpha,
    b: b.b + (a.b - b.b) * alpha,
  })
}

// -- OKLCH -------------------------------------------------------------------

export interface Oklch {
  /** Perceptual lightness, 0-1. */
  l: number
  /** Chroma, 0 to roughly 0.37. */
  c: number
  /** Hue in degrees. */
  h: number
}

function oklchToLinear({ l, c, h }: Oklch): [number, number, number] {
  const rad = (h * Math.PI) / 180
  const a = c * Math.cos(rad)
  const b = c * Math.sin(rad)
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ]
}

const IN_GAMUT_EPSILON = 1e-4
const inGamut = (rgb: [number, number, number]) =>
  rgb.every((v) => v >= -IN_GAMUT_EPSILON && v <= 1 + IN_GAMUT_EPSILON)

/**
 * The nearest displayable colour, found by lowering chroma alone.
 *
 * Lightness and hue are what the rules fix, so they are what this keeps;
 * clipping RGB channels instead would shift both. A binary search on chroma,
 * which is monotone enough at fixed L and H for this to land within a hair.
 */
export function gamutMap(color: Oklch): Oklch {
  const l = Math.max(0, Math.min(1, color.l))
  if (inGamut(oklchToLinear({ ...color, l }))) return { ...color, l }
  let lo = 0
  let hi = color.c
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2
    if (inGamut(oklchToLinear({ l, c: mid, h: color.h }))) lo = mid
    else hi = mid
  }
  return { l, c: lo, h: color.h }
}

/** An OKLCH colour as sRGB hex, gamut-mapped first. */
export function oklchToHex(color: Oklch): string {
  const [r, g, b] = oklchToLinear(gamutMap(color))
  const clamp01 = (v: number) => Math.max(0, Math.min(1, v))
  return toHex({ r: linearToSrgb(clamp01(r)), g: linearToSrgb(clamp01(g)), b: linearToSrgb(clamp01(b)) })
}

/** A hex colour in OKLCH. Hue is 0 for greys. */
export function hexToOklch(hex: string): Oklch {
  const rgb = parseHex(hex) ?? { r: 0, g: 0, b: 0 }
  const r = srgbToLinear(rgb.r)
  const g = srgbToLinear(rgb.g)
  const b = srgbToLinear(rgb.b)
  const l_ = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b)
  const m_ = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b)
  const s_ = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b)
  const L = 0.2104542553 * l_ + 0.793617785 * m_ - 0.0040720468 * s_
  const A = 1.9779984951 * l_ - 2.428592205 * m_ + 0.4505937099 * s_
  const B = 0.0259040371 * l_ + 0.7827717662 * m_ - 0.808675766 * s_
  const c = Math.sqrt(A * A + B * B)
  const h = c < 1e-4 ? 0 : ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360
  return { l: L, c, h }
}

// -- Seeds and hues ----------------------------------------------------------

/** A small seeded PRNG: the same seed always gives the same theme. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** A fresh seed for Shuffle. */
export function randomSeed(): number {
  return Math.floor(Math.random() * 0xffffffff) >>> 0
}

/** The hues the rules keep for meaning, never for taste. */
export const SEMANTIC_HUES = { danger: 27, warning: 75, success: 150, info: 245 } as const

/**
 * Accent hues within this many degrees of danger or success are refused: an
 * accent that reads as "error" or "done" breaks what people have learned the
 * colours mean.
 */
export const HUE_EXCLUSION = 25
const EXCLUDED_CENTRES = [SEMANTIC_HUES.danger, SEMANTIC_HUES.success]

const hueDistance = (a: number, b: number) => {
  const d = Math.abs((((a - b) % 360) + 360) % 360)
  return Math.min(d, 360 - d)
}

export function isExcludedHue(hue: number): boolean {
  return EXCLUDED_CENTRES.some((centre) => hueDistance(hue, centre) < HUE_EXCLUSION)
}

/** A hue pushed to the nearest edge of any exclusion zone it falls in. */
export function clampHue(hue: number): number {
  const h = ((hue % 360) + 360) % 360
  for (const centre of EXCLUDED_CENTRES) {
    const d = hueDistance(h, centre)
    if (d < HUE_EXCLUSION) {
      const side = (((h - centre) % 360) + 360) % 360 < 180 ? 1 : -1
      return (((centre + side * HUE_EXCLUSION) % 360) + 360) % 360
    }
  }
  return h
}

export const CHROMA_RANGE = [0.11, 0.18] as const
const DARK_CHROMA_SCALE = 0.85

/** Seed → accent hue and chroma, per step 1 of the pipeline. */
export function seedToAccent(seed: number): { hue: number; chroma: number } {
  const rng = mulberry32(seed)
  let hue = rng() * 360
  // Rejection rather than clamping, so the zone edges are not overrepresented.
  for (let i = 0; i < 32 && isExcludedHue(hue); i++) hue = rng() * 360
  hue = clampHue(hue)
  const chroma = CHROMA_RANGE[0] + rng() * (CHROMA_RANGE[1] - CHROMA_RANGE[0])
  return { hue, chroma }
}

// -- Roles -------------------------------------------------------------------

export type Mode = "light" | "dark"

/** Starting lightness per role and mode (doc §3.3). Repair moves from here. */
export const ROLE_L = {
  light: {
    bg: 0.99,
    bgSubtle: 0.97,
    bgElevated: 1,
    bgHover: 0.945,
    border: 0.91,
    borderStrong: 0.72,
    text: 0.21,
    textMuted: 0.44,
    textSubtle: 0.52,
    accent: 0.55,
    semantic: 0.52,
    soft: 0.95,
    chart: 0.6,
  },
  dark: {
    bg: 0.16,
    bgSubtle: 0.19,
    bgElevated: 0.22,
    bgHover: 0.25,
    border: 0.29,
    borderStrong: 0.5,
    text: 0.94,
    textMuted: 0.75,
    textSubtle: 0.66,
    accent: 0.72,
    semantic: 0.74,
    soft: 0.26,
    chart: 0.72,
  },
} as const

const NEUTRAL_CHROMA = { light: 0.006, dark: 0.012 } as const
const SOFT_CHROMA = 0.04
const SEMANTIC_CHROMA = 0.15
const CHART_CHROMA = 0.14
const GOLDEN_ANGLE = 137.5
const WHITE = "#ffffff"

/** Named colours for text and callouts in notes, on fixed hues. */
export const NOTE_HUES = {
  gray: null,
  red: 25,
  orange: 55,
  yellow: 90,
  green: 150,
  blue: 260,
  purple: 300,
  pink: 350,
} as const

/**
 * Steps a colour's lightness away from its surfaces until it reaches `ratio`
 * against every one of them -- darker on a light theme, lighter on a dark one.
 * Hue and chroma are held; only L moves, 0.01 at a time.
 */
function repair(
  color: Oklch,
  surfaces: readonly string[] | ((candidate: string) => readonly string[]),
  ratio: number,
  mode: Mode,
): string {
  const step = mode === "light" ? -0.01 : 0.01
  const against = typeof surfaces === "function" ? surfaces : () => surfaces
  let l = color.l
  let hex = oklchToHex({ ...color, l })
  for (let i = 0; i < 100 && against(hex).some((s) => contrast(hex, s) < ratio); i++) {
    l = Math.max(0, Math.min(1, l + step))
    hex = oklchToHex({ ...color, l })
    if (l === 0 || l === 1) break
  }
  return hex
}

/** The lowest contrast `color` has against any of `surfaces`. */
const minContrast = (color: string, surfaces: readonly string[]) =>
  Math.min(...surfaces.map((s) => contrast(color, s)))

export interface TokenSpec {
  mode: Mode
  accentHue: number
  /** Light-mode chroma; dark mode scales it down itself. */
  accentChroma: number
  highContrast?: boolean
  /** Starting accent lightness, when it should not come from the table. */
  accentL?: number
  /** Hue and chroma for the neutrals; the accent's, at neutral chroma, if absent. */
  neutralHue?: number
  neutralChroma?: number
  /** An exact page colour (custom themes). The other surfaces are offset from it. */
  bgExact?: string
}

/** Every variable the stylesheet reads, name without `--`. */
export type Tokens = Record<string, string>

/** How strong the accent wash behind selected rows is, per mode. */
export const ACTIVE_BG_ALPHA = { light: 0.12, dark: 0.18 } as const

/**
 * Builds the full token set for one mode, following the pipeline in doc §3.4
 * step by step. Does not validate; `buildTokens` does that.
 */
export function generateTokens(spec: TokenSpec): Tokens {
  const { mode } = spec
  const L = ROLE_L[mode]
  const hc = spec.highContrast ?? false
  const textTarget = hc ? 7 : 4.5
  const chroma = spec.accentChroma * (mode === "dark" ? DARK_CHROMA_SCALE : 1)
  const accentHue = spec.accentHue
  const nHue = spec.neutralHue ?? accentHue
  const nChroma = spec.neutralChroma ?? NEUTRAL_CHROMA[mode]

  // 2. Neutrals. A custom page colour sets the starting point and the rest
  //    keep their distance from it.
  const bgL = spec.bgExact ? hexToOklch(spec.bgExact).l : L.bg
  const offset = (role: number) => Math.max(0, Math.min(1, bgL + (role - L.bg)))
  const neutral = (l: number) => oklchToHex({ l, c: nChroma, h: nHue })
  const bg = spec.bgExact ?? neutral(L.bg)
  const bgSubtle = neutral(offset(L.bgSubtle))
  const bgElevated = neutral(offset(L.bgElevated))
  const bgHover = neutral(offset(L.bgHover))
  const surfaces = [bg, bgSubtle, bgElevated, bgHover]
  const accentSoft = oklchToHex({ l: offset(L.soft), c: SOFT_CHROMA, h: accentHue })

  const borderBase = { l: offset(L.border), c: nChroma, h: nHue }
  const border = hc ? repair(borderBase, [bg, bgSubtle, bgElevated], 3, mode) : oklchToHex(borderBase)
  const borderStrong = repair({ l: offset(L.borderStrong), c: nChroma, h: nHue }, [bg, bgSubtle, bgElevated], 3, mode)

  // 3. Text, against every surface it can sit on -- the hover row is usually
  //    the hardest, and the accent tints are included because selected rows
  //    use them behind ordinary text.
  // The accent as text comes first (its own step 6 below) because the
  // selected-row wash is made from it, and text has to read on that wash.
  // Selected rows put it on its own wash, which moves with it -- so each
  // candidate is measured against the wash it would make.
  const accentText = repair(
    { l: spec.accentL ?? L.accent, c: chroma, h: accentHue },
    (candidate) => [
      ...surfaces,
      accentSoft,
      composite(candidate, ACTIVE_BG_ALPHA[mode], bg),
      composite(candidate, ACTIVE_BG_ALPHA[mode], bgSubtle),
    ],
    textTarget,
    mode,
  )
  const activeBgOn = (under: string) => composite(accentText, ACTIVE_BG_ALPHA[mode], under)
  const textSurfaces = [...surfaces, accentSoft, activeBgOn(bg), activeBgOn(bgSubtle)]
  const text = repair({ l: L.text, c: nChroma, h: nHue }, textSurfaces, textTarget, mode)
  const textMuted = repair({ l: L.textMuted, c: nChroma, h: nHue }, textSurfaces, textTarget, mode)
  const textSubtle = repair({ l: L.textSubtle, c: nChroma, h: nHue }, textSurfaces, textTarget, mode)

  // 4-5. The solid accent: 3:1 against the page, and a foreground (white or
  //      the dark page colour, whichever is stronger) at the text target on
  //      it. Searched outward from the starting L so the accent moves as
  //      little as it has to.
  const darkInk = oklchToHex({ l: ROLE_L.dark.bg, c: NEUTRAL_CHROMA.dark, h: nHue })
  const startL = spec.accentL ?? L.accent
  const startHex = oklchToHex({ l: startL, c: chroma, h: accentHue })
  const inks = contrast(startHex, WHITE) >= contrast(startHex, darkInk) ? [WHITE, darkInk] : [darkInk, WHITE]
  let accent = startHex
  let accentFg = inks[0]!
  search: for (let k = 0; k <= 100; k++) {
    for (const l of k === 0 ? [startL] : [startL - k * 0.01, startL + k * 0.01]) {
      if (l < 0 || l > 1) continue
      const candidate = oklchToHex({ l, c: chroma, h: accentHue })
      if (minContrast(candidate, [bg, bgSubtle]) < 3) continue
      for (const ink of inks) {
        if (contrast(candidate, ink) >= textTarget) {
          accent = candidate
          accentFg = ink
          break search
        }
      }
    }
  }

  // 6. The accent as text -- links, the active nav item -- was built above,
  //    separately from the solid accent, at the text target on every surface
  //    including its own soft tint. Its wash marks selected rows.
  const activeBg = (() => {
    const rgb = parseHex(accentText)!
    return `rgb(${rgb.r} ${rgb.g} ${rgb.b} / ${Math.round(ACTIVE_BG_ALPHA[mode] * 100)}%)`
  })()

  // 7. Semantic colours, on fixed hues, readable on the page and on their own
  //    soft tint.
  const semantic: Tokens = {}
  for (const [name, hue] of Object.entries(SEMANTIC_HUES)) {
    const soft = oklchToHex({ l: offset(L.soft), c: SOFT_CHROMA, h: hue })
    semantic[`${name}-soft`] = soft
    semantic[name] = repair({ l: L.semantic, c: SEMANTIC_CHROMA, h: hue }, [...surfaces, soft], textTarget, mode)
  }

  // 8. Charts: golden-angle hues from the accent, 3:1 against the page.
  const charts: Tokens = {}
  for (let i = 0; i < 6; i++) {
    charts[`chart-${i + 1}`] = repair(
      { l: L.chart, c: CHART_CHROMA, h: (accentHue + i * GOLDEN_ANGLE) % 360 },
      [bg, bgElevated],
      3,
      mode,
    )
  }

  // Notes' named text colours: fixed hues, held to the text target.
  const notes: Tokens = {}
  for (const [name, hue] of Object.entries(NOTE_HUES)) {
    notes[`ucch-note-${name}`] = repair(
      { l: L.semantic, c: hue === null ? 0 : SEMANTIC_CHROMA, h: hue ?? 0 },
      [bg, bgSubtle, bgElevated],
      textTarget,
      mode,
    )
  }
  notes["ucch-note-highlight"] =
    mode === "light" ? oklchToHex({ l: 0.92, c: 0.12, h: 95 }) : oklchToHex({ l: 0.4, c: 0.09, h: 95 })

  return {
    // The guideline roles, named for the shadcn variables that carry them.
    background: bg,
    foreground: text,
    card: bgElevated,
    "card-foreground": text,
    popover: bgElevated,
    "popover-foreground": text,
    primary: accent,
    "primary-foreground": accentFg,
    secondary: bgHover,
    "secondary-foreground": text,
    // shadcn's `muted` is a hover and chip surface as often as a panel, so
    // it is the hover step: one step off the page, visibly.
    muted: bgHover,
    "muted-foreground": textMuted,
    accent: bgHover,
    "accent-foreground": text,
    destructive: semantic.danger!,
    border,
    input: borderStrong,
    ring: accentText,
    sidebar: bgSubtle,
    "sidebar-foreground": text,
    "sidebar-primary": accent,
    "sidebar-primary-foreground": accentFg,
    "sidebar-accent": bgHover,
    "sidebar-accent-foreground": text,
    "sidebar-border": border,
    "sidebar-ring": accentText,

    // Roles shadcn has no name for.
    "text-subtle": textSubtle,
    "border-strong": borderStrong,
    "focus-ring": accentText,
    "accent-soft": accentSoft,
    "ucch-active": accentText,
    "ucch-active-bg": activeBg,
    ...semantic,
    ...charts,
    ...notes,
  }
}

// -- Validation --------------------------------------------------------------

export interface ContrastCheck {
  fg: string
  bg: string
  min: number
}

/** The pairs doc §2 requires, as variable names. */
export function contrastChecks(highContrast = false): ContrastCheck[] {
  const text = highContrast ? 7 : 4.5
  // page, subtle panel (sidebar), elevated (card), hover (accent = muted)
  const surfaces = ["background", "sidebar", "card", "accent"]
  const checks: ContrastCheck[] = []
  for (const fg of ["foreground", "muted-foreground", "text-subtle"]) {
    for (const bg of [...surfaces, "accent-soft", "@active-bg:background", "@active-bg:sidebar"]) {
      checks.push({ fg, bg, min: text })
    }
  }
  for (const bg of [...surfaces, "accent-soft", "@active-bg:background", "@active-bg:sidebar"]) {
    checks.push({ fg: "ucch-active", bg, min: text })
  }
  checks.push({ fg: "primary-foreground", bg: "primary", min: text })
  checks.push({ fg: "primary", bg: "background", min: 3 })
  checks.push({ fg: "primary", bg: "sidebar", min: 3 })
  for (const name of Object.keys(SEMANTIC_HUES)) {
    for (const bg of [...surfaces, `${name}-soft`]) checks.push({ fg: name, bg, min: text })
  }
  for (const fg of ["input", "focus-ring"]) {
    for (const bg of ["background", "sidebar", "card"]) checks.push({ fg, bg, min: 3 })
  }
  if (highContrast) checks.push({ fg: "border", bg: "background", min: 3 })
  for (let i = 1; i <= 6; i++) checks.push({ fg: `chart-${i}`, bg: "background", min: 3 })
  for (const name of Object.keys(NOTE_HUES)) {
    checks.push({ fg: `ucch-note-${name}`, bg: "background", min: text })
  }
  checks.push({ fg: "foreground", bg: "ucch-note-highlight", min: text })
  return checks
}

export interface ContrastFailure extends ContrastCheck {
  ratio: number
}

/** Resolves a check's surface, compositing the translucent selection wash. */
function surfaceOf(tokens: Tokens, name: string, mode: Mode): string {
  if (name.startsWith("@active-bg:")) {
    return composite(tokens["ucch-active"]!, ACTIVE_BG_ALPHA[mode], tokens[name.slice(11)]!)
  }
  return tokens[name]!
}

/** Every pair below its minimum. Empty means the theme ships. */
export function validate(tokens: Tokens, mode: Mode, highContrast = false): ContrastFailure[] {
  const failures: ContrastFailure[] = []
  for (const check of contrastChecks(highContrast)) {
    const fg = tokens[check.fg]
    const bg = surfaceOf(tokens, check.bg, mode)
    if (!fg || !bg || !parseHex(fg) || !parseHex(bg)) {
      failures.push({ ...check, ratio: 0 })
      continue
    }
    const ratio = contrast(fg, bg)
    if (ratio < check.min) failures.push({ ...check, ratio })
  }
  return failures
}

// -- The default, and the gate -----------------------------------------------

/** The shipped accent: the blue the app has always had. */
export const DEFAULT_ACCENT = { hue: 266, chroma: 0.17 } as const

const defaultCache = new Map<string, Tokens>()

/** The shipped palette for a mode -- what every failing theme falls back to. */
export function defaultTokens(mode: Mode, highContrast = false): Tokens {
  const key = `${mode}:${highContrast}`
  let tokens = defaultCache.get(key)
  if (!tokens) {
    tokens = generateTokens({
      mode,
      accentHue: DEFAULT_ACCENT.hue,
      accentChroma: DEFAULT_ACCENT.chroma,
      highContrast,
    })
    defaultCache.set(key, tokens)
  }
  return tokens
}

export interface BuiltTokens {
  tokens: Tokens
  /** True when the requested theme failed validation and the default is shown. */
  fellBack: boolean
  failures: ContrastFailure[]
}

/**
 * Generates, validates, and falls back (steps 9-10). The only way a token set
 * reaches the screen: a theme that fails any check is never shown.
 */
export function buildTokens(spec: TokenSpec, label = "theme"): BuiltTokens {
  const tokens = generateTokens(spec)
  const failures = validate(tokens, spec.mode, spec.highContrast)
  if (failures.length === 0) return { tokens, fellBack: false, failures }
  if (typeof console !== "undefined") {
    console.warn(`[color-engine] ${label} failed ${failures.length} contrast checks; using the default`, failures[0])
  }
  return { tokens: defaultTokens(spec.mode, spec.highContrast), fellBack: true, failures }
}

// -- Terminal ----------------------------------------------------------------

const ANSI_HUES = { red: 27, green: 145, yellow: 85, blue: 255, magenta: 330, cyan: 200 } as const
const ANSI_ORDER = ["red", "green", "yellow", "blue", "magenta", "cyan"] as const

export type AnsiPalette = Record<
  | "black" | "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "white"
  | "brightBlack" | "brightRed" | "brightGreen" | "brightYellow" | "brightBlue"
  | "brightMagenta" | "brightCyan" | "brightWhite",
  string
>

/**
 * A 16-colour ANSI palette for a terminal background: fixed hues, every
 * foreground at 4.5:1 against the background -- bright-black included, which
 * is the one the defaults always lose. "black" on a dark terminal and "white"
 * on a light one are the colours meant for backgrounds, and are left as the
 * near-ground shades programs expect.
 */
export function ansiPalette(mode: Mode, background: string): AnsiPalette {
  const surfaces = [background]
  const base = mode === "light" ? 0.5 : 0.72
  const bright = mode === "light" ? 0.44 : 0.8
  const out = {} as AnsiPalette
  for (const name of ANSI_ORDER) {
    const h = ANSI_HUES[name]
    out[name] = repair({ l: base, c: 0.15, h }, surfaces, 4.5, mode)
    const brightName = `bright${name[0]!.toUpperCase()}${name.slice(1)}` as keyof AnsiPalette
    out[brightName] = repair({ l: bright, c: 0.17, h }, surfaces, 4.5, mode)
  }
  if (mode === "light") {
    out.black = repair({ l: 0.25, c: 0, h: 0 }, surfaces, 4.5, mode)
    out.brightBlack = repair({ l: 0.5, c: 0, h: 0 }, surfaces, 4.5, mode)
    out.white = oklchToHex({ l: 0.88, c: 0, h: 0 })
    out.brightWhite = oklchToHex({ l: 0.96, c: 0, h: 0 })
  } else {
    out.black = oklchToHex({ l: 0.3, c: 0, h: 0 })
    out.brightBlack = repair({ l: 0.62, c: 0, h: 0 }, surfaces, 4.5, mode)
    out.white = repair({ l: 0.86, c: 0, h: 0 }, surfaces, 4.5, mode)
    out.brightWhite = repair({ l: 0.97, c: 0, h: 0 }, surfaces, 4.5, mode)
  }
  return out
}
