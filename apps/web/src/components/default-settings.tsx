"use client"

import * as React from "react"
import { CheckIcon, Loader2Icon, RotateCcwIcon, SparklesIcon } from "lucide-react"

import { ModelSelect, useModels } from "@/components/model-picker"
import { Button } from "@/components/ui/button"

interface DefaultSettings {
  /** The model in force: the choice below, or the server's when there is none. */
  defaultModel: string
  /** What this account chose, or null when it is following the server. */
  chosenModel: string | null
  serverDefaultModel: string
}

/**
 * The defaults a new conversation starts with.
 *
 * One setting so far, and it is the one that costs money: which model answers
 * when nothing has said otherwise. A project still remembers the last model it
 * was actually talked to with -- that is a fact about the project, not a
 * preference -- so this is what a *new* conversation opens on, and what a turn
 * arriving without a model named is billed to.
 *
 * Following the server's default is a real state rather than the absence of a
 * choice: an account that has never chosen tracks `DEFAULT_MODEL` and keeps
 * tracking it when the operator changes it. That is what Reset goes back to.
 */
export function DefaultSettings() {
  const { models } = useModels()
  const [settings, setSettings] = React.useState<DefaultSettings | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await fetch("/api/settings", { credentials: "include" })
      if (!response.ok || cancelled) return
      setSettings((await response.json()) as DefaultSettings)
    })().catch(() => setLoadError("Could not load settings."))
    return () => {
      cancelled = true
    }
  }, [])

  async function save(model: string | null) {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch("/api/settings/default-model", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model }),
      })
      const body = (await response.json()) as DefaultSettings & { error?: string }
      if (!response.ok) throw new Error(body.error ?? `save failed: ${response.status}`)
      setSettings(body)
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  if (loadError) {
    return (
      <section className="rounded-lg border p-6">
        <p className="text-destructive text-sm">{loadError}</p>
      </section>
    )
  }

  // The model in force, whether or not it was chosen here: the picker shows
  // what a new conversation would actually open on, never an empty field.
  const value = settings?.defaultModel ?? ""
  const following = settings !== null && settings.chosenModel === null
  const named = models.find((model) => model.id === value)

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <SparklesIcon className="text-muted-foreground size-4" />
        Default model
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Which model a new conversation starts on, and which one answers a turn that does not name
        one. You can still change the model per message in the composer, and each project keeps
        the last one you used there.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <ModelSelect
          models={models}
          value={value}
          onChange={(id) => void save(id)}
          disabled={busy || settings === null}
        />
        {busy && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
        {!following && settings && (
          <Button variant="outline" size="sm" onClick={() => void save(null)} disabled={busy}>
            <RotateCcwIcon />
            Use the server default
          </Button>
        )}
      </div>

      <div className="mt-3 text-sm">
        {error ? (
          <p className="text-destructive">{error}</p>
        ) : saved ? (
          <p className="text-ucch-active flex items-center gap-1.5">
            <CheckIcon className="size-4" />
            Saved.
          </p>
        ) : following && settings ? (
          <p className="text-muted-foreground">
            Following the server&apos;s default,{" "}
            <span className="font-mono text-xs">{settings.serverDefaultModel}</span>. Choosing one
            here pins it for your account instead.
          </p>
        ) : settings ? (
          <p className="text-muted-foreground">
            New conversations open on{" "}
            <span className="text-foreground font-medium">{named?.name ?? value}</span>
            {named?.reasoning && " — a reasoning model, so the effort select applies to it"}.
          </p>
        ) : (
          <p className="text-muted-foreground">Loading…</p>
        )}
      </div>
    </section>
  )
}
