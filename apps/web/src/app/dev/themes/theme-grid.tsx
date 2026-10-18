"use client"

import * as React from "react"
import { ShuffleIcon } from "lucide-react"

import { buildTokens, randomSeed, seedToAccent, validate, type Mode, type Tokens } from "@/lib/color-engine"

const COUNT = 50

export function ThemeGrid() {
  const [seeds, setSeeds] = React.useState<number[]>(() => Array.from({ length: COUNT }, (_, i) => i))
  const [highContrast, setHighContrast] = React.useState(false)

  return (
    <main className="mx-auto max-w-7xl p-6">
      <header className="mb-6 flex flex-wrap items-center gap-4">
        <h1 className="text-lg font-semibold">Generated themes</h1>
        <button
          type="button"
          onClick={() => setSeeds(Array.from({ length: COUNT }, randomSeed))}
          className="bg-primary text-primary-foreground inline-flex items-center gap-1.5 rounded-lg px-3 py-1.5 text-sm"
        >
          <ShuffleIcon className="size-4" aria-hidden />
          New seeds
        </button>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={highContrast} onChange={(e) => setHighContrast(e.target.checked)} />
          High contrast
        </label>
      </header>
      <ul className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
        {seeds.map((seed) => (
          <li key={seed} className="overflow-hidden rounded-lg border">
            <p className="text-muted-foreground border-b px-3 py-1.5 font-mono text-xs">
              seed {seed} · hue {Math.round(seedToAccent(seed).hue)}°
            </p>
            <div className="grid grid-cols-2">
              {(["light", "dark"] as Mode[]).map((mode) => (
                <Card key={mode} seed={seed} mode={mode} highContrast={highContrast} />
              ))}
            </div>
          </li>
        ))}
      </ul>
    </main>
  )
}

function Card({ seed, mode, highContrast }: { seed: number; mode: Mode; highContrast: boolean }) {
  const { hue, chroma } = seedToAccent(seed)
  const { tokens: t, fellBack } = buildTokens({ mode, accentHue: hue, accentChroma: chroma, highContrast })
  const failures = validate(t, mode, highContrast).length
  return (
    <div className="flex flex-col gap-2 p-3 text-xs" style={{ background: t.background, color: t.foreground }}>
      <div className="flex items-center justify-between">
        <span className="font-medium">{mode}</span>
        <span style={{ color: failures || fellBack ? t.danger : t.success }}>
          {failures || fellBack ? "✕ fell back" : "✓ AA"}
        </span>
      </div>
      <span style={{ color: t["muted-foreground"] }}>Muted text</span>
      <div className="rounded px-1.5 py-1" style={{ background: t.sidebar, borderColor: t.border }}>
        <span style={{ color: t["ucch-active"] }}>Link</span>
        <span className="ml-1 rounded px-1" style={{ background: t["accent-soft"] }}>
          Selected
        </span>
      </div>
      <span
        className="self-start rounded px-2 py-1 font-medium"
        style={{ background: t.primary, color: t["primary-foreground"] }}
      >
        Button
      </span>
      <div className="flex flex-wrap gap-1">
        {(["danger", "warning", "success", "info"] as const).map((name) => (
          <span key={name} className="rounded px-1" style={{ background: t[`${name}-soft`], color: t[name] }}>
            {name}
          </span>
        ))}
      </div>
      <Charts t={t} />
    </div>
  )
}

function Charts({ t }: { t: Tokens }) {
  return (
    <div className="flex h-2 gap-0.5">
      {[1, 2, 3, 4, 5, 6].map((i) => (
        <span key={i} className="flex-1 rounded-sm" style={{ background: t[`chart-${i}`] }} />
      ))}
    </div>
  )
}
