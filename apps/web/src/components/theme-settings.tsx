"use client"

import * as React from "react"
import { PaletteIcon, RotateCcwIcon, ShuffleIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useTheme } from "@/components/theme-provider"
import {
  deriveTheme,
  isValidHex,
  normalizeHex,
  randomTheme,
  readableOn,
  type Theme,
} from "@/lib/theme"

/** The three roles, in the proportion the rule names them. */
const ROLES = [
  {
    key: "dominant",
    share: "60%",
    label: "Dominant",
    hint: "The page and every large surface on it.",
  },
  {
    key: "secondary",
    share: "30%",
    label: "Secondary",
    hint: "Panels, the sidebar, hovers and borders.",
  },
  {
    key: "accent",
    share: "10%",
    label: "Accent",
    hint: "Selection, focus rings, the primary button.",
  },
] as const satisfies ReadonlyArray<{
  key: keyof Theme
  share: string
  label: string
  hint: string
}>

/**
 * Where the harness's colour is chosen.
 *
 * Three colours, not a list of tokens: everything else in the app is derived
 * from them, including whether text and icons are white or near-black, so
 * this panel is the whole theming surface. Edits paint immediately rather
 * than behind a Save -- the page around the form *is* the preview, and a
 * colour you have to commit to before seeing is a colour you pick twice.
 */
export function ThemeSettings() {
  const { theme, customised, setTheme, resetTheme } = useTheme()

  // The text fields hold their own draft so a half-typed "#3b5" is not
  // normalised out from under the cursor; they resync whenever the theme
  // changes from anywhere else (the picker, Randomize, another tab).
  const [drafts, setDrafts] = React.useState<Record<keyof Theme, string>>({ ...theme })
  React.useEffect(() => setDrafts({ ...theme }), [theme])

  const derived = deriveTheme(theme)

  function update(key: keyof Theme, value: string) {
    setTheme({ ...theme, [key]: normalizeHex(value, theme[key]) })
  }

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <PaletteIcon className="text-muted-foreground size-4" />
        Theme
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Three colours on the 60-30-10 rule. Everything else — cards, borders, charts, and
        whether text and icons come out white or black — is derived from them, so the palette
        stays legible whichever way you take it. Saved in this browser.
      </p>

      {/* The rule, drawn to scale. The share each colour carries is the point
          of the split, and a legend of three equal swatches would say the
          opposite of what it means. */}
      <div className="border-border mt-5 flex h-16 max-w-xl overflow-hidden rounded-md border">
        {ROLES.map((role) => {
          const color = theme[role.key]
          return (
            <div
              key={role.key}
              className="flex flex-col justify-center px-3 text-[11px] leading-tight"
              style={{
                flexGrow: parseInt(role.share, 10),
                backgroundColor: color,
                color: readableOn(color),
              }}
            >
              <span className="font-medium">{role.share}</span>
              <span className="opacity-70">{role.label}</span>
            </div>
          )
        })}
      </div>

      <div className="mt-5 flex max-w-xl flex-col gap-4">
        {ROLES.map((role) => (
          <div key={role.key} className="flex flex-wrap items-center gap-3">
            {/* The native picker, wearing the colour it holds: the default
                control renders a swatch already, but its size and chrome vary
                per platform, so it is made transparent and stretched over a
                square this app controls. */}
            <label
              className="border-border relative size-10 shrink-0 overflow-hidden rounded-md border"
              style={{ backgroundColor: theme[role.key] }}
            >
              <span className="sr-only">{role.label} colour</span>
              <input
                type="color"
                value={theme[role.key]}
                onChange={(e) => update(role.key, e.target.value)}
                className="absolute inset-0 size-full cursor-pointer opacity-0"
              />
            </label>

            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {role.label} <span className="text-muted-foreground">· {role.share}</span>
              </p>
              <p className="text-muted-foreground truncate text-xs">{role.hint}</p>
            </div>

            <Input
              value={drafts[role.key]}
              onChange={(e) => {
                const next = e.target.value
                setDrafts((d) => ({ ...d, [role.key]: next }))
                if (isValidHex(next)) update(role.key, next)
              }}
              onBlur={() => setDrafts((d) => ({ ...d, [role.key]: theme[role.key] }))}
              spellCheck={false}
              autoComplete="off"
              aria-label={`${role.label} hex`}
              aria-invalid={!isValidHex(drafts[role.key])}
              className="w-32 font-mono text-sm"
            />
          </div>
        ))}
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button onClick={() => setTheme(randomTheme())}>
          <ShuffleIcon />
          Randomize
        </Button>
        <Button variant="outline" onClick={() => setTheme(randomTheme(Math.random, "light"))}>
          Random light
        </Button>
        <Button variant="outline" onClick={() => setTheme(randomTheme(Math.random, "dark"))}>
          Random dark
        </Button>
        <Button variant="ghost" onClick={resetTheme} disabled={!customised}>
          <RotateCcwIcon />
          Reset
        </Button>
      </div>

      <p className="text-muted-foreground mt-3 text-sm">
        {customised
          ? `Reading as a ${derived.dark ? "dark" : "light"} theme — text and icons are ${
              derived.dark ? "white" : "near-black"
            }.`
          : "Using the default palette."}
      </p>
    </section>
  )
}
