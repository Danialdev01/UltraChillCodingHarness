"use client"

import * as React from "react"
import { AlertTriangleIcon, CheckIcon, KeyRoundIcon, Loader2Icon, SendIcon, TrashIcon } from "lucide-react"

import { GithubMark } from "@/components/github-mark"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"

interface KeyState {
  configured: boolean
  hint: string | null
  /**
   * True when something else already supplies this capability -- signing in
   * with GitHub leaves a token behind that the repository list can use. Only
   * the GitHub entry ever carries it.
   */
  inheritedFromLogin?: boolean
}

interface Settings {
  openrouter: KeyState
  resend: KeyState
  github: KeyState
  encryptionAvailable: boolean
}

/** Everything that differs between one provider's form and another's. */
interface Provider {
  id: "openrouter" | "resend" | "github"
  name: string
  /** Lucide-shaped: a `className` and nothing else. */
  icon: React.ComponentType<{ className?: string }>
  placeholder: string
  /** What the key is for, and what happens without it. */
  blurb: React.ReactNode
  /** Where to get one. */
  href: string
  hrefLabel: string
  /** Shown when no key is set. Some are required to work; some are not yet. */
  absent: string
  /**
   * Shown instead of `absent` when the capability is already covered without
   * a key of its own: the advice is then "you can, but narrowly" rather than
   * "nothing works".
   */
  inherited?: string
}

const PROVIDERS: Provider[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: KeyRoundIcon,
    placeholder: "sk-or-v1-…",
    blurb:
      "The key every agent turn in your projects is billed to. Stored encrypted, decrypted only for the moment a turn calls the API, and never sent back to this page.",
    href: "https://openrouter.ai/keys",
    hrefLabel: "openrouter.ai/keys",
    absent: "No key yet, so the agent cannot answer.",
  },
  {
    id: "resend",
    name: "Resend",
    icon: SendIcon,
    placeholder: "re_…",
    blurb:
      "For email the harness sends on your behalf — address verification first, and whatever needs to leave by mail after that. Stored the same way as the key above: encrypted, write-only, never returned to this page.",
    href: "https://resend.com/api-keys",
    hrefLabel: "resend.com/api-keys",
    absent: "No key yet. Nothing sends email until there is one.",
  },
  {
    id: "github",
    name: "GitHub",
    icon: GithubMark,
    placeholder: "ghp_…",
    blurb:
      "Used when you create a project: it lists the repositories you can see, reads their branches, and authenticates the clone of a private one. A classic token needs the repo scope; a fine-grained one needs read access to contents and metadata. Stored encrypted and never returned to this page.",
    href: "https://github.com/settings/tokens",
    hrefLabel: "github.com/settings/tokens",
    absent: "No token yet, so the GitHub tab in New project has nothing to list.",
    inherited:
      "No token of its own. The one from signing in with GitHub is used instead, which covers the repositories that grant lets it see — add a token here to widen that.",
  },
]

/**
 * Where the account's third-party keys are set.
 *
 * Every key here is write-only from the browser: the server answers with
 * whether one is stored and its last four characters, never the value, so
 * this page has nothing secret to leak into the DOM, a screenshot, or the
 * browser's history. One fetch fills in both forms, and saving either
 * refreshes only its own.
 */
export function ApiKeySettings() {
  const [settings, setSettings] = React.useState<Settings | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    void (async () => {
      const response = await fetch("/api/settings", { credentials: "include" })
      if (!response.ok || cancelled) return
      setSettings((await response.json()) as Settings)
    })().catch(() => setLoadError("Could not load settings."))
    return () => {
      cancelled = true
    }
  }, [])

  if (loadError) {
    return (
      <section className="rounded-lg border p-6">
        <p className="text-destructive text-sm">{loadError}</p>
      </section>
    )
  }

  return (
    <>
      {!settings?.encryptionAvailable && settings && (
        // Said once, above both forms, rather than repeated in each: it is
        // one server-side condition and it disables all of them.
        <p className="border-warning/40 bg-warning-soft text-warning flex gap-2 rounded-lg border px-4 py-3 text-sm">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            <code className="font-mono">SECRET_KEY</code> is not configured on the server, so no key
            can be stored safely and saving is refused. Generate one with{" "}
            <code className="font-mono">openssl rand -hex 32</code>.
          </span>
        </p>
      )}

      {PROVIDERS.map((provider) => (
        <ApiKeyForm
          key={provider.id}
          provider={provider}
          state={settings?.[provider.id] ?? null}
          loading={settings === null}
          encryptionAvailable={settings?.encryptionAvailable ?? true}
          onSaved={(next) =>
            // Merged rather than replaced: the save reply carries the hint and
            // nothing else, and `inheritedFromLogin` is not something saving a
            // key can have changed.
            setSettings((current) =>
              current
                ? { ...current, [provider.id]: { ...current[provider.id], ...next } }
                : current,
            )
          }
        />
      ))}
    </>
  )
}

function ApiKeyForm({
  provider,
  state,
  loading,
  encryptionAvailable,
  onSaved,
}: {
  provider: Provider
  /** Null until the fetch lands. */
  state: KeyState | null
  /** The settings have not arrived yet, so `state` says nothing either way. */
  loading: boolean
  encryptionAvailable: boolean
  onSaved: (next: KeyState) => void
}) {
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  async function save(apiKey: string | null) {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      const response = await fetch(`/api/settings/${provider.id}`, {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ apiKey }),
      })
      const body = (await response.json()) as Record<string, KeyState | string | undefined>
      if (!response.ok) throw new Error((body.error as string) ?? `save failed: ${response.status}`)
      onSaved((body[provider.id] as KeyState) ?? { configured: false, hint: null })
      setDraft("")
      setSaved(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <provider.icon className="text-muted-foreground size-4" />
        {provider.name}
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">{provider.blurb}</p>

      <div className="mt-4 flex max-w-xl flex-wrap items-center gap-2">
        <Input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={state?.configured ? `Stored key ending ${state.hint}` : provider.placeholder}
          autoComplete="off"
          spellCheck={false}
          aria-label={`${provider.name} API key`}
          className="min-w-64 flex-1 font-mono text-sm"
          disabled={busy || loading || !encryptionAvailable}
        />
        <Button
          onClick={() => void save(draft.trim())}
          disabled={busy || !draft.trim() || !encryptionAvailable}
        >
          {busy && <Loader2Icon className="animate-spin" />}
          {state?.configured ? "Replace" : "Save"}
        </Button>
        {state?.configured && (
          <Button variant="outline" onClick={() => void save(null)} disabled={busy}>
            <TrashIcon />
            Remove
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
        ) : loading ? (
          <Skeleton className="my-0.5 h-3.5 w-3/4 max-w-prose" />
        ) : state?.configured ? (
          <p className="text-muted-foreground">
            A key ending <span className="font-mono">{state.hint}</span> is in use.
          </p>
        ) : (
          <p className="text-muted-foreground">
            {state?.inheritedFromLogin && provider.inherited ? provider.inherited : provider.absent}{" "}
            Create one at{" "}
            <a
              href={provider.href}
              target="_blank"
              rel="noreferrer"
              className="text-ucch-active underline underline-offset-2"
            >
              {provider.hrefLabel}
            </a>
            .
          </p>
        )}
      </div>
    </section>
  )
}
