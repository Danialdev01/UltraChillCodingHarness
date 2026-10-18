"use client"

import * as React from "react"

import { randomSeed } from "@/lib/color-engine"
import {
  applyTheme,
  DEFAULT_SETTINGS,
  isDefaultSettings,
  readStoredTheme,
  resolveMode,
  resolveTokens,
  storeTheme,
  storeThemeCookie,
  THEME_STORAGE_KEY,
  type Mode,
  type Theme,
  type ThemeMode,
  type ThemeSettings,
  type Tokens,
} from "@/lib/theme"
import {
  applySyntaxTheme,
  presetName,
  readStoredPresets,
  readStoredSyntax,
  storePresets,
  storeSyntax,
  upsertPreset,
  type SyntaxTheme,
  type ThemePreset,
} from "@/lib/syntax-theme"
import {
  applySelectionColors,
  editorSelectionTheme,
  selectionColors,
  type SelectionColors,
} from "@/lib/selection-color"

interface ThemeContextValue {
  /** The choice in force. Always complete -- the default if none is saved. */
  settings: ThemeSettings
  /** Whether the user has changed anything, as opposed to running on the default. */
  customised: boolean
  /** Light or dark as actually on screen, with System resolved against the OS. */
  resolvedMode: Mode
  /** Concrete colours for the mode on screen, for code that cannot read `var()`. */
  tokens: Tokens
  /** True when the chosen palette failed validation and the default is showing. */
  fellBack: boolean

  /** Paints and saves a whole choice. */
  setSettings: (settings: ThemeSettings) => void
  setMode: (mode: ThemeMode) => void
  setHighContrast: (on: boolean) => void
  setLocked: (on: boolean) => void
  /** A new random seed -- ignored while locked. */
  shuffle: () => void
  /** Picks the accent hue directly; everything else derives from it. */
  setHue: (hue: number) => void
  /** Three custom colours, repaired and validated like any other palette. */
  setCustom: (theme: Theme) => void
  /** Forgets the saved choice and returns to the shipped one. */
  resetTheme: () => void

  /** The code colours in force, or null when following the light/dark defaults. */
  syntax: SyntaxTheme | null
  /** Paints and saves a set of code colours; null returns to the defaults. */
  setSyntax: (syntax: SyntaxTheme | null) => void
  /** The code editors' selection colours, derived from the accent for this palette. */
  selection: SelectionColors

  /** Saved looks -- palette and code colours under a name. */
  presets: ThemePreset[]
  /** Keeps what is on screen under a name; a repeated name overwrites. */
  savePreset: (name: string) => boolean
  /** Puts a saved look on screen. */
  applyPreset: (id: string) => void
  deletePreset: (id: string) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

const DARK_QUERY = "(prefers-color-scheme: dark)"

/**
 * Colour transitions for one switch only: on for a moment, then off, so the
 * page eases into a new palette without every later hover easing too.
 */
function markSwitching() {
  const root = globalThis.document?.documentElement
  if (!root) return
  root.classList.add("theme-switching")
  globalThis.setTimeout(() => root.classList.remove("theme-switching"), 200)
}

/**
 * Holds the theme for the app.
 *
 * The first paint is already themed, and not by this: the root layout reads the
 * theme cookie and renders the variables onto <html> itself, server-side, as
 * `light-dark()` pairs that follow `color-scheme`. So there is no blocking
 * script, no flash, and System tracks the OS with nothing here running.
 *
 * `initial` is that same server-read choice, handed down so this starts in
 * agreement with the HTML it is hydrating. What the provider adds on top is
 * live editing -- every setter paints onto <html> immediately -- and the mode
 * as a value for the few consumers that need it in JavaScript (the terminal,
 * the diagram embeds).
 */
export function ThemeProvider({
  initial = null,
  children,
}: {
  /** The choice the server painted, from the cookie. */
  initial?: ThemeSettings | null
  children: React.ReactNode
}) {
  const [settings, setSettingsState] = React.useState<ThemeSettings>(initial ?? DEFAULT_SETTINGS)
  const [prefersDark, setPrefersDark] = React.useState(false)
  // Client-only state: the editor that reads the code colours is never
  // server-rendered, so nothing is lost by picking these up after mount, and
  // nothing has to travel in a cookie.
  const [syntax, setSyntaxState] = React.useState<SyntaxTheme | null>(null)
  const [presets, setPresets] = React.useState<ThemePreset[]>([])

  React.useEffect(() => {
    const storedSyntax = readStoredSyntax()
    setSyntaxState(storedSyntax)
    applySyntaxTheme(storedSyntax)
    setPresets(readStoredPresets())

    const stored = readStoredTheme()
    if (stored) {
      setSettingsState(stored)
      applyTheme(stored)
      // Repairs a cookie that was cleared, and carries an old three-colour
      // theme over to the new cookie shape.
      storeThemeCookie(stored)
    } else if (initial) {
      // The cookie says there is a theme and storage does not -- a second
      // browser, or cleared site data. Storage follows the cookie.
      storeTheme(initial)
    }

    // The OS preference, for the JavaScript side of System. The CSS side
    // needs none of this: `light-dark()` follows `color-scheme` on its own.
    const media = globalThis.matchMedia?.(DARK_QUERY)
    setPrefersDark(media?.matches ?? false)
    const onMedia = (event: MediaQueryListEvent) => setPrefersDark(event.matches)
    media?.addEventListener("change", onMedia)

    // Settings open in a second tab is a real way to use this app; `storage`
    // fires only in the other tabs, which is exactly the ones that need it.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return
      const next = readStoredTheme() ?? DEFAULT_SETTINGS
      setSettingsState(next)
      applyTheme(next)
    }
    globalThis.addEventListener?.("storage", onStorage)
    return () => {
      media?.removeEventListener("change", onMedia)
      globalThis.removeEventListener?.("storage", onStorage)
    }
    // Mount only: `initial` is the server's snapshot, and re-running this
    // against a later render of it would undo an edit made since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const resolvedMode = resolveMode(settings.mode, prefersDark)
  const built = resolveTokens(settings, resolvedMode)
  // Derived from everything on screen -- palette, mode (System included, via
  // the OS preference above) and code colours -- and memoised per palette
  // inside `selectionColors`, so a re-render with nothing changed is a lookup.
  const selection = selectionColors(editorSelectionTheme(built.tokens, syntax, resolvedMode))
  React.useEffect(() => applySelectionColors(selection), [selection])

  const value = React.useMemo<ThemeContextValue>(() => {
    const commit = (next: ThemeSettings) => {
      markSwitching()
      setSettingsState(next)
      applyTheme(next)
      storeTheme(next)
      // The cookie is what the *next* server render paints from, so it is
      // written with the choice rather than after it.
      storeThemeCookie(next)
    }

    return {
      settings,
      customised: !isDefaultSettings(settings),
      resolvedMode,
      tokens: built.tokens,
      fellBack: built.fellBack,

      setSettings: commit,
      setMode: (mode) => commit({ ...settings, mode }),
      setHighContrast: (highContrast) => commit({ ...settings, highContrast }),
      setLocked: (locked) => commit({ ...settings, locked }),
      shuffle: () => {
        if (settings.locked) return
        commit({ ...settings, source: { kind: "seed", seed: randomSeed() } })
      },
      setHue: (hue) => {
        const seed = settings.source.kind === "seed" ? settings.source.seed : randomSeed()
        commit({ ...settings, source: { kind: "seed", seed, hue } })
      },
      setCustom: (theme) => commit({ ...settings, source: { kind: "custom", ...theme } }),
      resetTheme: () => commit(DEFAULT_SETTINGS),

      syntax,
      setSyntax: (next) => {
        setSyntaxState(next)
        applySyntaxTheme(next)
        storeSyntax(next)
      },
      selection,

      presets,
      savePreset: (input) => {
        const name = presetName(input)
        if (!name) return false
        const next = upsertPreset(presets, {
          name,
          theme: isDefaultSettings(settings) ? null : settings,
          syntax,
        })
        setPresets(next)
        storePresets(next)
        return true
      },
      applyPreset: (id) => {
        const preset = presets.find((p) => p.id === id)
        if (!preset) return
        commit(preset.theme ?? DEFAULT_SETTINGS)
        setSyntaxState(preset.syntax)
        applySyntaxTheme(preset.syntax)
        storeSyntax(preset.syntax)
      },
      deletePreset: (id) => {
        const next = presets.filter((p) => p.id !== id)
        setPresets(next)
        storePresets(next)
      },
    }
  }, [settings, resolvedMode, built, syntax, selection, presets])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** Reads the current theme. Throws outside the provider, which is a bug. */
export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>")
  return context
}
