"use client"

import * as React from "react"
import { BookmarkIcon, CheckIcon, Trash2Icon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useTheme } from "@/components/theme-provider"
import { defaultSyntaxTheme, type ThemePreset } from "@/lib/syntax-theme"
import { DEFAULT_THEME, deriveTheme } from "@/lib/theme"

/**
 * Saved looks: the palette and the code colours together, under a name.
 *
 * Saving captures exactly what is on screen, defaults included -- a preset
 * saved while on the shipped palette records "the shipped palette", and
 * applying it later resets to that. Applying is one click and paints
 * immediately, the same as every other control on this tab; the preset
 * that matches what is on screen is marked so you can tell where you are.
 */
export function ThemePresets() {
  const { theme, customised, syntax, presets, savePreset, applyPreset, deletePreset } = useTheme()
  const [name, setName] = React.useState("")

  const current = presets.find((p) => matches(p, customised ? theme : null, syntax))

  function save() {
    if (savePreset(name)) setName("")
  }

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <BookmarkIcon className="text-muted-foreground size-4" />
        Presets
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Keep the palette and code colours that are on screen under a name, and switch between
        saved ones with a click. Saving under an existing name replaces it. Saved in this
        browser.
      </p>

      <form
        className="mt-5 flex max-w-xl flex-wrap items-center gap-2"
        onSubmit={(e) => {
          e.preventDefault()
          save()
        }}
      >
        <Input
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Preset name"
          aria-label="Preset name"
          maxLength={40}
          className="w-56"
        />
        <Button type="submit" disabled={!name.trim()}>
          Save current look
        </Button>
      </form>

      {presets.length === 0 ? (
        <p className="text-muted-foreground mt-4 text-sm">No presets yet.</p>
      ) : (
        <ul className="mt-4 flex max-w-xl flex-col gap-2">
          {presets.map((preset) => (
            <li
              key={preset.id}
              className="flex flex-wrap items-center gap-3 rounded-md border px-3 py-2"
              aria-current={preset.id === current?.id ? "true" : undefined}
            >
              <Swatches preset={preset} />
              <span className="min-w-0 flex-1 truncate text-sm font-medium">{preset.name}</span>
              {preset.id === current?.id && (
                <span className="text-ucch-active flex items-center gap-1 text-xs">
                  <CheckIcon className="size-3.5" />
                  in use
                </span>
              )}
              <Button
                variant="outline"
                size="sm"
                onClick={() => applyPreset(preset.id)}
                disabled={preset.id === current?.id}
              >
                Apply
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`Delete ${preset.name}`}
                title="Delete"
                onClick={() => deletePreset(preset.id)}
              >
                <Trash2Icon />
              </Button>
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}

/** Whether a preset is what is on screen: same palette, same code colours. */
function matches(preset: ThemePreset, theme: ThemePreset["theme"], syntax: ThemePreset["syntax"]) {
  return JSON.stringify(preset.theme) === JSON.stringify(theme) && JSON.stringify(preset.syntax) === JSON.stringify(syntax)
}

/** The preset at a glance: its three palette colours, then a few code colours. */
function Swatches({ preset }: { preset: ThemePreset }) {
  const palette = preset.theme ?? DEFAULT_THEME
  const code = preset.syntax ?? defaultSyntaxTheme(deriveTheme(palette).dark)
  const colors = [palette.dominant, palette.secondary, palette.accent, code.keyword, code.string, code.function]
  return (
    <span className="border-border flex h-6 shrink-0 overflow-hidden rounded border" aria-hidden>
      {colors.map((color, i) => (
        <span key={i} className="w-3" style={{ backgroundColor: color }} />
      ))}
    </span>
  )
}
