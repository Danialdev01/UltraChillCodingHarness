"use client"

import * as React from "react"
import {
  AlertTriangleIcon,
  CheckIcon,
  ContrastIcon,
  LockIcon,
  LockOpenIcon,
  MonitorIcon,
  MoonIcon,
  PaletteIcon,
  RotateCcwIcon,
  ShuffleIcon,
  SunIcon,
} from "lucide-react"

import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { useTheme } from "@/components/theme-provider"
import { HUE_EXCLUSION, oklchToHex, SEMANTIC_HUES } from "@/lib/color-engine"
import {
  accentOf,
  customReport,
  DEFAULT_THEME,
  isValidHex,
  normalizeHex,
  type Theme,
  type ThemeMode,
} from "@/lib/theme"
import { cn } from "@/lib/utils"

const MODES = [
  { value: "light", label: "Light", icon: SunIcon },
  { value: "dark", label: "Dark", icon: MoonIcon },
  { value: "system", label: "System", icon: MonitorIcon },
] as const satisfies ReadonlyArray<{ value: ThemeMode; label: string; icon: unknown }>

const CUSTOM_ROLES = [
  { key: "dominant", label: "Page", hint: "The page background. Sets whether this palette is light or dark." },
  { key: "secondary", label: "Panel tint", hint: "Tints panels, hovers and borders." },
  { key: "accent", label: "Accent", hint: "Selection, links, focus rings, the primary button." },
] as const satisfies ReadonlyArray<{ key: keyof Theme; label: string; hint: string }>

/** The hue track: the accent at fixed lightness, all the way round. */
const HUE_TRACK = `linear-gradient(to right, ${Array.from({ length: 25 }, (_, i) =>
  oklchToHex({ l: 0.62, c: 0.14, h: i * 15 }),
).join(", ")})`

/** The hues kept for meaning, drawn over the track as blocked bands. */
const EXCLUDED_BANDS = [SEMANTIC_HUES.danger, SEMANTIC_HUES.success].map((centre) => ({
  left: ((centre - HUE_EXCLUSION) / 360) * 100,
  width: ((HUE_EXCLUSION * 2) / 360) * 100,
}))

/**
 * Where the harness's colour is chosen.
 *
 * Mode first (Light, Dark, System), then the palette: Shuffle for a random
 * seed, Lock to keep it, or a hue picked directly. Everything else -- text,
 * surfaces, borders, status colours, charts -- is generated from that one hue
 * with fixed lightness per role, then checked against WCAG AA, so no choice
 * here can produce unreadable text. Custom colours are under Advanced, with
 * their contrast shown live.
 *
 * Edits paint immediately rather than behind a Save -- the page around the
 * form is the preview.
 */
export function ThemeSettings() {
  const {
    settings,
    customised,
    resolvedMode,
    tokens,
    fellBack,
    setMode,
    setHighContrast,
    setLocked,
    shuffle,
    setHue,
    setCustom,
    resetTheme,
  } = useTheme()
  const { source } = settings
  const hue = Math.round(accentOf(source).hue)

  return (
    <section className="rounded-lg border p-6" aria-labelledby="theme-heading">
      <h2 id="theme-heading" className="flex items-center gap-2 text-sm font-medium">
        <PaletteIcon className="text-muted-foreground size-4" aria-hidden />
        Theme
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Pick a mode and an accent hue. Text, surfaces, borders and charts are generated from the
        hue and checked for WCAG AA contrast, in light and dark. Status colours stay fixed: red
        always means a problem. Saved in this browser.
      </p>

      {/* Mode */}
      <div role="radiogroup" aria-label="Colour mode" className="mt-5 inline-flex rounded-lg border p-0.5">
        {MODES.map(({ value, label, icon: Icon }) => {
          const checked = settings.mode === value
          return (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => setMode(value)}
              className={cn(
                "flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm",
                checked ? "bg-accent-soft text-foreground font-medium" : "text-muted-foreground hover:bg-muted",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {label}
            </button>
          )
        })}
      </div>
      {settings.mode === "system" && (
        <p className="text-muted-foreground mt-2 text-xs">Following your system, which is {resolvedMode} right now.</p>
      )}

      <Preview tokens={tokens} />

      {/* Hue */}
      <div className="mt-5 max-w-xl">
        <div className="flex items-center justify-between gap-3">
          <label htmlFor="theme-hue" className="text-sm font-medium">
            Accent hue
          </label>
          <span className="text-muted-foreground font-mono text-xs" aria-hidden>
            {hue}°
          </span>
        </div>
        <div className="relative mt-2 h-6">
          <div className="absolute inset-x-0 top-1/2 h-3 -translate-y-1/2 rounded-full" style={{ background: HUE_TRACK }} aria-hidden />
          {EXCLUDED_BANDS.map((band) => (
            <div
              key={band.left}
              aria-hidden
              title="Reserved for status colours"
              className="bg-background/80 border-border-strong absolute top-1/2 h-3 -translate-y-1/2 border-x border-dashed"
              style={{ left: `${band.left}%`, width: `${band.width}%` }}
            />
          ))}
          <input
            id="theme-hue"
            type="range"
            min={0}
            max={359}
            step={1}
            value={hue}
            onChange={(e) => setHue(Number(e.target.value))}
            aria-valuetext={`${hue} degrees`}
            aria-describedby="theme-hue-hint"
            className="ucch-hue-range absolute inset-0 w-full"
          />
        </div>
        <p id="theme-hue-hint" className="text-muted-foreground mt-1 text-xs">
          The dashed bands are reserved for error red and success green; the slider skips them.
        </p>
      </div>

      <div className="mt-5 flex flex-wrap items-center gap-2">
        <Button onClick={shuffle} disabled={settings.locked} aria-disabled={settings.locked}>
          <ShuffleIcon aria-hidden />
          Shuffle
        </Button>
        <Button
          variant="outline"
          onClick={() => setLocked(!settings.locked)}
          aria-pressed={settings.locked}
        >
          {settings.locked ? <LockIcon aria-hidden /> : <LockOpenIcon aria-hidden />}
          {settings.locked ? "Locked" : "Lock"}
        </Button>
        <Button variant="ghost" onClick={resetTheme} disabled={!customised} aria-disabled={!customised}>
          <RotateCcwIcon aria-hidden />
          Reset
        </Button>
      </div>
      <p className="text-muted-foreground mt-2 text-xs">
        {source.kind === "seed"
          ? `Seed ${source.seed}${source.hue !== undefined ? `, hue ${Math.round(source.hue)}°` : ""}. ${
              settings.locked ? "Locked: Shuffle is off until you unlock." : "Lock it to keep this palette."
            }`
          : source.kind === "custom"
            ? "Using custom colours."
            : "Using the default palette."}
      </p>

      <label className="mt-5 flex max-w-xl cursor-pointer items-start gap-3">
        <input
          type="checkbox"
          checked={settings.highContrast}
          onChange={(e) => setHighContrast(e.target.checked)}
          className="accent-primary mt-0.5 size-4"
        />
        <span>
          <span className="flex items-center gap-1.5 text-sm font-medium">
            <ContrastIcon className="size-4" aria-hidden />
            High contrast
          </span>
          <span className="text-muted-foreground block text-xs">
            Raises all text to 7:1 (WCAG AAA) and makes dividers visible.
          </span>
        </span>
      </label>

      {fellBack && (
        <p role="status" className="bg-warning-soft text-warning mt-4 flex max-w-xl items-start gap-2 rounded-md px-3 py-2 text-sm">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          This palette could not reach readable contrast in {resolvedMode} mode, so the default is showing
          instead.
        </p>
      )}

      <CustomColours
        initial={source.kind === "custom" ? source : DEFAULT_THEME}
        active={source.kind === "custom"}
        highContrast={settings.highContrast}
        onChange={setCustom}
      />
    </section>
  )
}

/** The palette as it will look: page, panel, text, accent, status, charts. */
function Preview({ tokens }: { tokens: Record<string, string> }) {
  return (
    <div
      className="mt-5 grid max-w-xl grid-cols-[1fr_2fr] overflow-hidden rounded-md border"
      style={{ borderColor: tokens.border }}
      aria-hidden
    >
      <div className="flex flex-col gap-1 p-3 text-xs" style={{ background: tokens.sidebar, color: tokens["muted-foreground"] }}>
        <span>Files</span>
        <span className="rounded px-1.5 py-0.5" style={{ background: tokens["accent-soft"], color: tokens.foreground }}>
          Active
        </span>
        <span style={{ color: tokens["ucch-active"] }}>A link</span>
      </div>
      <div className="flex flex-col gap-2 p-3" style={{ background: tokens.background, color: tokens.foreground }}>
        <span className="text-sm font-medium">Heading text</span>
        <span className="text-xs" style={{ color: tokens["muted-foreground"] }}>
          Secondary text on the page
        </span>
        <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
          <span className="rounded px-2 py-1 font-medium" style={{ background: tokens.primary, color: tokens["primary-foreground"] }}>
            Primary
          </span>
          {(["danger", "warning", "success", "info"] as const).map((name) => (
            <span key={name} className="rounded px-1.5 py-0.5" style={{ background: tokens[`${name}-soft`], color: tokens[name] }}>
              {name}
            </span>
          ))}
        </div>
        <div className="flex h-2 gap-0.5">
          {[1, 2, 3, 4, 5, 6].map((i) => (
            <span key={i} className="flex-1 rounded-sm" style={{ background: tokens[`chart-${i}`] }} />
          ))}
        </div>
      </div>
    </div>
  )
}

/**
 * Three custom colours, for people who want exact values. They go through the
 * same repair and validation as a generated palette; the readout shows each
 * pair's contrast as picked and as shown, so an adjustment is never silent.
 */
function CustomColours({
  initial,
  active,
  highContrast,
  onChange,
}: {
  initial: Theme
  active: boolean
  highContrast: boolean
  onChange: (theme: Theme) => void
}) {
  const [colours, setColours] = React.useState<Theme>({
    dominant: initial.dominant,
    secondary: initial.secondary,
    accent: initial.accent,
  })
  // Drafts so a half-typed "#3b5" is not normalised out from under the cursor.
  const [drafts, setDrafts] = React.useState<Theme>(colours)
  React.useEffect(() => {
    const next = { dominant: initial.dominant, secondary: initial.secondary, accent: initial.accent }
    setColours(next)
    setDrafts(next)
  }, [initial.dominant, initial.secondary, initial.accent])

  const report = customReport(colours, highContrast)

  function update(key: keyof Theme, value: string) {
    const next = { ...colours, [key]: normalizeHex(value, colours[key]) }
    setColours(next)
    onChange(next)
  }

  return (
    <details className="mt-6 max-w-xl rounded-md border" open={active || undefined}>
      <summary className="cursor-pointer px-3 py-2 text-sm font-medium">Advanced: custom colours</summary>
      <div className="flex flex-col gap-4 border-t p-3">
        <p className="text-muted-foreground text-xs">
          Exact colours, adjusted where needed so text stays readable. The other mode is generated
          from your accent.
        </p>
        {CUSTOM_ROLES.map((role) => (
          <div key={role.key} className="flex flex-wrap items-center gap-3">
            <label
              className="border-border-strong relative size-9 shrink-0 overflow-hidden rounded-md border focus-within:outline-2 focus-within:outline-offset-2 focus-within:outline-focus-ring"
              style={{ backgroundColor: colours[role.key] }}
            >
              <span className="sr-only">{role.label} colour</span>
              <input
                type="color"
                value={colours[role.key]}
                onChange={(e) => update(role.key, e.target.value)}
                className="absolute inset-0 size-full cursor-pointer opacity-0"
              />
            </label>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">{role.label}</p>
              <p className="text-muted-foreground text-xs">{role.hint}</p>
            </div>
            <Input
              value={drafts[role.key]}
              onChange={(e) => {
                const next = e.target.value
                setDrafts((d) => ({ ...d, [role.key]: next }))
                if (isValidHex(next)) update(role.key, next)
              }}
              onBlur={() => setDrafts((d) => ({ ...d, [role.key]: colours[role.key] }))}
              spellCheck={false}
              autoComplete="off"
              aria-label={`${role.label} hex`}
              aria-invalid={!isValidHex(drafts[role.key])}
              className="w-28 font-mono text-sm"
            />
          </div>
        ))}

        <table className="w-full text-xs">
          <caption className="text-muted-foreground mb-1 text-left">Contrast (WCAG 2.2)</caption>
          <thead className="text-muted-foreground text-left">
            <tr>
              <th scope="col" className="py-1 font-medium">Pair</th>
              <th scope="col" className="py-1 font-medium">As picked</th>
              <th scope="col" className="py-1 font-medium">Shown</th>
              <th scope="col" className="py-1 font-medium">Needs</th>
            </tr>
          </thead>
          <tbody>
            {report.rows.map((row) => {
              const pickedOk = row.picked >= row.min
              const shownOk = row.shown >= row.min
              return (
                <tr key={row.label} className="border-t">
                  <th scope="row" className="py-1 text-left font-normal">{row.label}</th>
                  <td className={cn("py-1 font-mono", !pickedOk && "text-warning")}>
                    <span className="inline-flex items-center gap-1">
                      {pickedOk ? <CheckIcon className="size-3" aria-hidden /> : <AlertTriangleIcon className="size-3" aria-hidden />}
                      {row.picked.toFixed(2)}:1
                      <span className="sr-only">{pickedOk ? "passes" : "too low"}</span>
                    </span>
                  </td>
                  <td className={cn("py-1 font-mono", shownOk ? "text-success" : "text-danger")}>
                    {row.shown.toFixed(2)}:1 {pickedOk ? "" : shownOk ? "(adjusted)" : "(fails)"}
                  </td>
                  <td className="text-muted-foreground py-1 font-mono">{row.min}:1</td>
                </tr>
              )
            })}
          </tbody>
        </table>
        {report.fellBack && (
          <p role="status" className="bg-warning-soft text-warning flex items-start gap-2 rounded-md px-3 py-2 text-xs">
            <AlertTriangleIcon className="mt-0.5 size-3.5 shrink-0" aria-hidden />
            Text can&apos;t be made readable on this page colour, so the default palette is showing. Try a
            lighter or darker page.
          </p>
        )}
      </div>
    </details>
  )
}
