import { coerceSettings, isValidHex, normalizeHex, type ThemeSettings } from "./theme.js"

/**
 * The colours of code in the file view, and the presets a whole look is kept
 * in.
 *
 * Syntax colour is not derived from the 60-30-10 palette the way the rest of
 * the app is: three colours cannot say how a keyword should differ from a
 * string, and the people who care about editor colours care about each one.
 * So it is its own set -- one hex per kind of token -- painted onto <html> as
 * `--syn-*` variables that the editor's highlight style reads. The defaults
 * live in `globals.css`, one set for light and one for dark, and a custom set
 * overrides them inline.
 *
 * A preset is the whole look: the palette and the syntax colours together,
 * under a name. Saving one captures what is on screen; applying one puts it
 * back. They are what makes trying a colour safe -- there is always the last
 * good look to return to.
 *
 * DOM-free apart from the storage and paint helpers at the end, like
 * `theme.ts`, so the shapes can be tested.
 */

export const SYNTAX_ROLES = [
  { key: "keyword", label: "Keywords", hint: "if, return, const, function, class" },
  { key: "string", label: "Strings", hint: "Quoted text and template literals." },
  { key: "number", label: "Numbers & constants", hint: "Numbers, true, false, null." },
  { key: "comment", label: "Comments", hint: "Comments and doc blocks." },
  { key: "function", label: "Functions", hint: "Names of functions and methods being called or defined." },
  { key: "variable", label: "Variables", hint: "Local and global variable names." },
  { key: "property", label: "Properties", hint: "Object keys, fields, JSON keys." },
  { key: "type", label: "Types & classes", hint: "Type, class and interface names." },
  { key: "operator", label: "Operators", hint: "+ - = => && ?." },
  { key: "punctuation", label: "Punctuation", hint: "Brackets, braces, commas, semicolons." },
  { key: "tag", label: "Tags", hint: "HTML and JSX element names." },
  { key: "attribute", label: "Attributes", hint: "HTML and JSX attribute names." },
  { key: "heading", label: "Headings", hint: "Markdown headings and emphasis." },
  { key: "link", label: "Links & regex", hint: "URLs, links, regular expressions." },
  { key: "invalid", label: "Invalid", hint: "Syntax the grammar could not parse." },
] as const satisfies ReadonlyArray<{ key: string; label: string; hint: string }>

export type SyntaxRole = (typeof SYNTAX_ROLES)[number]["key"]

/** One hex per role. */
export type SyntaxTheme = Record<SyntaxRole, string>

/**
 * The shipped colours, mirrored in `globals.css`. Fixed, never randomised:
 * each one reaches 4.5:1 against every surface the engine can generate for
 * its mode (checked in `color-engine.test.ts`). Light is CodeMirror's own
 * default style with a few tones pulled in; dark is in the family of One
 * Dark, since that is what most eyes expect a dark editor to look like.
 */
export const DEFAULT_SYNTAX_LIGHT: SyntaxTheme = {
  keyword: "#7c3aed",
  string: "#a31515",
  number: "#0f766e",
  comment: "#626977",
  function: "#1d4ed8",
  variable: "#1f2937",
  property: "#0e7490",
  type: "#ad4e00",
  operator: "#374151",
  punctuation: "#626977",
  tag: "#166534",
  attribute: "#92400e",
  heading: "#1d4ed8",
  link: "#0369a1",
  invalid: "#d1141b",
}

export const DEFAULT_SYNTAX_DARK: SyntaxTheme = {
  keyword: "#c678dd",
  string: "#98c379",
  number: "#d19a66",
  comment: "#868b96",
  function: "#61afef",
  variable: "#e5e7eb",
  property: "#e06c75",
  type: "#e5c07b",
  operator: "#56b6c2",
  punctuation: "#abb2bf",
  tag: "#e06c75",
  attribute: "#d19a66",
  heading: "#61afef",
  link: "#56b6c2",
  invalid: "#f87171",
}

export function defaultSyntaxTheme(dark: boolean): SyntaxTheme {
  return { ...(dark ? DEFAULT_SYNTAX_DARK : DEFAULT_SYNTAX_LIGHT) }
}

/** Whether a value off storage is a usable syntax theme: every role, every one hex. */
export function isSyntaxTheme(value: unknown): value is SyntaxTheme {
  if (typeof value !== "object" || value === null) return false
  const t = value as Record<string, unknown>
  return SYNTAX_ROLES.every((role) => typeof t[role.key] === "string" && isValidHex(t[role.key] as string))
}

/**
 * Every role normalised to `#rrggbb`, with anything missing or unparseable
 * filled from `fallback`. What every write goes through, so storage only
 * ever holds the clean shape.
 */
export function normalizeSyntaxTheme(value: Partial<SyntaxTheme>, fallback: SyntaxTheme): SyntaxTheme {
  const out = {} as SyntaxTheme
  for (const role of SYNTAX_ROLES) {
    out[role.key] = normalizeHex(value[role.key] ?? "", fallback[role.key])
  }
  return out
}

/** The CSS variables, name without `--`, for painting or an inline style. */
export function syntaxVars(theme: SyntaxTheme): Record<string, string> {
  const vars: Record<string, string> = {}
  for (const role of SYNTAX_ROLES) vars[`syn-${role.key}`] = theme[role.key]
  return vars
}

// -- Presets ----------------------------------------------------------------

export interface ThemePreset {
  id: string
  name: string
  /** The palette and mode, or null for the shipped default. */
  theme: ThemeSettings | null
  /** The code colours, or null to follow the defaults for light/dark. */
  syntax: SyntaxTheme | null
}

export function isPreset(value: unknown): value is ThemePreset {
  return coercePreset(value) !== null
}

/**
 * A preset out of storage, or null if it is unusable. Presets saved before
 * modes existed hold three bare hex colours; `coerceSettings` carries those
 * over as custom colours.
 */
export function coercePreset(value: unknown): ThemePreset | null {
  if (typeof value !== "object" || value === null) return null
  const p = value as Record<string, unknown>
  if (typeof p.id !== "string" || typeof p.name !== "string") return null
  if (!(p.syntax === null || isSyntaxTheme(p.syntax))) return null
  const theme = p.theme === null ? null : coerceSettings(p.theme)
  if (p.theme !== null && !theme) return null
  return { id: p.id, name: p.name, theme, syntax: p.syntax as SyntaxTheme | null }
}

/** A preset name as it is kept: trimmed, non-empty, not absurdly long. */
export function presetName(input: string): string | null {
  const name = input.trim().replace(/\s+/g, " ").slice(0, 40)
  return name || null
}

/**
 * Adds or replaces a preset by name. A second save under the same name
 * overwrites: "save as Nightfall" means "this is Nightfall now", not "a
 * second Nightfall".
 */
export function upsertPreset(
  presets: readonly ThemePreset[],
  preset: Omit<ThemePreset, "id"> & { id?: string },
): ThemePreset[] {
  const existing = presets.find((p) => p.name.toLowerCase() === preset.name.toLowerCase())
  const id = preset.id ?? existing?.id ?? newPresetId()
  const next: ThemePreset = { id, name: preset.name, theme: preset.theme, syntax: preset.syntax }
  if (existing) return presets.map((p) => (p.id === existing.id ? next : p))
  return [...presets, next]
}

function newPresetId(): string {
  return globalThis.crypto?.randomUUID?.() ?? `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`
}

// -- Storage and paint ------------------------------------------------------

export const SYNTAX_STORAGE_KEY = "ucch:syntax"
export const PRESETS_STORAGE_KEY = "ucch:theme-presets"

export function readStoredSyntax(): SyntaxTheme | null {
  try {
    const raw = globalThis.localStorage?.getItem(SYNTAX_STORAGE_KEY)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isSyntaxTheme(parsed) ? parsed : null
  } catch {
    return null
  }
}

export function storeSyntax(theme: SyntaxTheme | null): void {
  try {
    if (!theme) globalThis.localStorage?.removeItem(SYNTAX_STORAGE_KEY)
    else globalThis.localStorage?.setItem(SYNTAX_STORAGE_KEY, JSON.stringify(theme))
  } catch {
    /* nothing to do: the colours simply are not remembered */
  }
}

export function readStoredPresets(): ThemePreset[] {
  try {
    const raw = globalThis.localStorage?.getItem(PRESETS_STORAGE_KEY)
    if (!raw) return []
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed)
      ? parsed.map(coercePreset).filter((p): p is ThemePreset => p !== null)
      : []
  } catch {
    return []
  }
}

export function storePresets(presets: readonly ThemePreset[]): void {
  try {
    globalThis.localStorage?.setItem(PRESETS_STORAGE_KEY, JSON.stringify(presets))
  } catch {
    /* nothing to do */
  }
}

/**
 * Paints the code colours onto the document, or strips them so the
 * stylesheet's light/dark defaults show through again.
 */
export function applySyntaxTheme(theme: SyntaxTheme | null, root?: HTMLElement): void {
  const element = root ?? globalThis.document?.documentElement
  if (!element) return
  for (const role of SYNTAX_ROLES) {
    const name = `--syn-${role.key}`
    if (theme) element.style.setProperty(name, theme[role.key])
    else element.style.removeProperty(name)
  }
}
