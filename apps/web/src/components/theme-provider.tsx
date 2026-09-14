"use client"

import * as React from "react"

import {
  applyTheme,
  DEFAULT_THEME,
  readStoredTheme,
  storeTheme,
  storeThemeCookie,
  THEME_STORAGE_KEY,
  type Theme,
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

interface ThemeContextValue {
  /** The palette in force. Always a full theme -- the default if none is saved. */
  theme: Theme
  /** Whether the user has chosen one, as opposed to running on the default. */
  customised: boolean
  /** Paints and saves a palette. */
  setTheme: (theme: Theme) => void
  /** Forgets the saved palette and returns to the shipped one. */
  resetTheme: () => void

  /** The code colours in force, or null when following the light/dark defaults. */
  syntax: SyntaxTheme | null
  /** Paints and saves a set of code colours; null returns to the defaults. */
  setSyntax: (syntax: SyntaxTheme | null) => void

  /** Saved looks -- palette and code colours under a name. */
  presets: ThemePreset[]
  /** Keeps what is on screen under a name; a repeated name overwrites. */
  savePreset: (name: string) => boolean
  /** Puts a saved look on screen. */
  applyPreset: (id: string) => void
  deletePreset: (id: string) => void
}

const ThemeContext = React.createContext<ThemeContextValue | null>(null)

/**
 * Holds the palette for the app.
 *
 * The first paint is already themed, and not by this: the root layout reads the
 * theme cookie and renders the variables onto <html> itself, server-side. So
 * there is no blocking script, no flash, and nothing here that has to run
 * before the browser draws.
 *
 * `initial` is that same server-read theme, handed down so this starts in
 * agreement with the HTML it is hydrating rather than starting empty and
 * correcting itself. What the provider adds on top is live editing: `setTheme`
 * paints the variables onto <html> immediately, so an edit in Settings shows up
 * everywhere at once without anything subscribing to anything.
 */
export function ThemeProvider({
  initial = null,
  children,
}: {
  /** The theme the server painted, from the cookie. */
  initial?: Theme | null
  children: React.ReactNode
}) {
  const [theme, setThemeState] = React.useState<Theme | null>(initial)
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
      setThemeState(stored)
      applyTheme(stored)
      // Migrates an account that chose a theme before the cookie existed, and
      // repairs one whose cookie was cleared: without this the server would go
      // on painting the default while the client painted the real palette.
      storeThemeCookie(stored)
    } else if (initial) {
      // The cookie says there is a theme and storage does not -- a second
      // browser, or cleared site data. Storage follows the cookie.
      storeTheme(initial)
    }

    // Settings open in a second tab is a real way to use this app; `storage`
    // fires only in the other tabs, which is exactly the ones that need it.
    const onStorage = (event: StorageEvent) => {
      if (event.key !== null && event.key !== THEME_STORAGE_KEY) return
      const next = readStoredTheme()
      setThemeState(next)
      applyTheme(next)
    }
    globalThis.addEventListener?.("storage", onStorage)
    return () => globalThis.removeEventListener?.("storage", onStorage)
    // Mount only: `initial` is the server's snapshot, and re-running this
    // against a later render of it would undo an edit made since.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const value = React.useMemo<ThemeContextValue>(
    () => ({
      theme: theme ?? DEFAULT_THEME,
      customised: theme !== null,
      setTheme: (next: Theme) => {
        setThemeState(next)
        applyTheme(next)
        storeTheme(next)
        // The cookie is what the *next* server render paints from, so it is
        // written with the choice rather than after it.
        storeThemeCookie(next)
      },
      resetTheme: () => {
        setThemeState(null)
        applyTheme(null)
        storeTheme(null)
        storeThemeCookie(null)
      },

      syntax,
      setSyntax: (next) => {
        setSyntaxState(next)
        applySyntaxTheme(next)
        storeSyntax(next)
      },

      presets,
      savePreset: (input) => {
        const name = presetName(input)
        if (!name) return false
        const next = upsertPreset(presets, { name, theme, syntax })
        setPresets(next)
        storePresets(next)
        return true
      },
      applyPreset: (id) => {
        const preset = presets.find((p) => p.id === id)
        if (!preset) return
        setThemeState(preset.theme)
        applyTheme(preset.theme)
        storeTheme(preset.theme)
        storeThemeCookie(preset.theme)
        setSyntaxState(preset.syntax)
        applySyntaxTheme(preset.syntax)
        storeSyntax(preset.syntax)
      },
      deletePreset: (id) => {
        const next = presets.filter((p) => p.id !== id)
        setPresets(next)
        storePresets(next)
      },
    }),
    [theme, syntax, presets],
  )

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

/** Reads the current palette. Throws outside the provider, which is a bug. */
export function useTheme(): ThemeContextValue {
  const context = React.useContext(ThemeContext)
  if (!context) throw new Error("useTheme must be used inside <ThemeProvider>")
  return context
}
