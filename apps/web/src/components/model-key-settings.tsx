"use client"

import * as React from "react"
import { CheckIcon, Loader2Icon, PencilIcon, PlusIcon, StarIcon, TrashIcon, XIcon } from "lucide-react"

import { OpenRouterMark } from "@/components/brand-marks"
import { InlineError } from "@/components/layout/inline-error"
import { Button } from "@/components/ui/button"
import { NativeSelect } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { fullDate, MASK, relativeWhen } from "@/lib/api-keys"
import {
  createModelKey,
  fetchModelKeys,
  KIND_NAMES,
  MAX_NAME_LENGTH,
  MODEL_KEY_KINDS,
  makeDefaultModelKey,
  removeModelKey,
  renameModelKey,
  type ModelKeyKind,
  type ModelKeyMeta,
} from "@/lib/model-keys"
import { cn } from "@/lib/utils"

const linkClass = "text-primary underline underline-offset-2 hover:no-underline"

const fieldClass = cn(
  "bg-background placeholder:text-muted-foreground h-8 min-w-0 rounded-md border px-2.5 text-base outline-none md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3 disabled:opacity-50",
  "aria-invalid:border-destructive",
)

/** A kind's tile: OpenRouter's own mark, AnonRouter's initials. */
export function KindTile({ kind, className }: { kind: ModelKeyKind; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn(
        "bg-background text-foreground flex size-8 shrink-0 items-center justify-center rounded-md border",
        className,
      )}
    >
      {kind === "openrouter" ? (
        <OpenRouterMark className="size-4" />
      ) : (
        <span className="text-[11px] font-semibold tracking-tight">AR</span>
      )}
    </span>
  )
}

/**
 * Providers -> Custom -> Named keys.
 *
 * Any number of keys, each of a kind (OpenRouter, AnonRouter) and each with a
 * name of your choosing. The composer's model picker lists every key's
 * models under its name, so a thread can bill a work key and the next a
 * personal one. A named key is never shown again once saved: replacing one
 * is removing it and adding another.
 */
export function ModelKeySettings({ onChanged }: { onChanged?: () => void } = {}) {
  const [data, setData] = React.useState<{ keys: ModelKeyMeta[]; encryptionAvailable: boolean } | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [adding, setAdding] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      setData(await fetchModelKeys())
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load your keys.")
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  if (loadError && !data) return <InlineError onRetry={() => void load()}>{loadError}</InlineError>

  return (
    <div className="flex flex-col gap-3">
      {!adding && (
        <div className="flex justify-end">
          <Button
            variant="outline"
            className="h-[30px] shrink-0 rounded-md px-3 text-xs"
            onClick={() => setAdding(true)}
            disabled={!data || !data.encryptionAvailable}
          >
            <PlusIcon className="size-3.5" />
            Add key
          </Button>
        </div>
      )}

      {adding && (
        <AddKeyForm
          existing={data?.keys ?? []}
          onCancel={() => setAdding(false)}
          onSaved={(key) => {
            setAdding(false)
            setData((was) => (was ? { ...was, keys: [...was.keys, key] } : was))
            onChanged?.()
          }}
        />
      )}

      {!data ? (
        <div className="bg-card flex flex-col rounded-lg border" aria-hidden>
          {Array.from({ length: 2 }, (_, i) => (
            <div key={i} className={cn("flex items-center gap-3 px-4 py-3", i > 0 && "border-t")}>
              <Skeleton className="size-8 rounded-md" />
              <div className="flex flex-1 flex-col gap-1.5">
                <Skeleton className="h-3.5 w-32" />
                <Skeleton className="h-3 w-48" />
              </div>
            </div>
          ))}
        </div>
      ) : data.keys.length === 0 ? (
        !adding && (
          <p className="text-muted-foreground rounded-lg border border-dashed px-4 py-3 text-xs">
            No keys yet. Add one to run Custom on it.
          </p>
        )
      ) : (
        <ul className="bg-card flex flex-col overflow-hidden rounded-lg border">
          {data.keys.map((key, i) => (
            <KeyRow
              key={key.id}
              meta={key}
              first={i === 0}
              others={data.keys.filter((k) => k.id !== key.id)}
              choosable={data.keys.filter((k) => k.kind === "openrouter").length > 1}
              onRenamed={(next) =>
                setData((was) => (was ? { ...was, keys: was.keys.map((k) => (k.id === next.id ? next : k)) } : was))
              }
              onDefault={(next) =>
                setData((was) =>
                  was ? { ...was, keys: was.keys.map((k) => ({ ...k, isDefault: k.id === next.id })) } : was,
                )
              }
              onRemoved={() => {
                setData((was) => (was ? { ...was, keys: was.keys.filter((k) => k.id !== key.id) } : was))
                // Removing the default hands it to another key: read which.
                if (key.isDefault) void load()
                onChanged?.()
              }}
            />
          ))}
        </ul>
      )}
    </div>
  )
}

function nameError(name: string, others: ModelKeyMeta[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "Give the key a name."
  if (trimmed.length > MAX_NAME_LENGTH) return `Keep the name to ${MAX_NAME_LENGTH} characters.`
  if (others.some((k) => k.name.toLowerCase() === trimmed.toLowerCase())) {
    return `You already have a key called "${trimmed}".`
  }
  return null
}

function AddKeyForm({
  existing,
  onCancel,
  onSaved,
}: {
  existing: ModelKeyMeta[]
  onCancel: () => void
  onSaved: (key: ModelKeyMeta) => void
}) {
  const [kind, setKind] = React.useState<ModelKeyKind>("anonrouter")
  const [name, setName] = React.useState("")
  const [key, setKey] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const nameRef = React.useRef<HTMLInputElement>(null)
  const meta = MODEL_KEY_KINDS.find((k) => k.id === kind)!

  React.useEffect(() => {
    nameRef.current?.focus()
  }, [])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const problem = nameError(name, existing) ?? (key.trim() ? null : "Paste a key.")
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      onSaved(await createModelKey({ kind, name: name.trim(), key: key.trim() }))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the key.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="bg-card flex flex-col gap-3 rounded-lg border p-4" aria-busy={busy}>
      <div className="grid gap-3 sm:grid-cols-[10rem_1fr]">
        <label className="flex flex-col gap-1.5" htmlFor="model-key-kind">
          <span className="text-text-subtle text-xs font-medium">Provider</span>
          <NativeSelect id="model-key-kind" value={kind} onChange={(v) => setKind(v as ModelKeyKind)} disabled={busy}>
            {MODEL_KEY_KINDS.map((k) => (
              <option key={k.id} value={k.id}>
                {k.name}
              </option>
            ))}
          </NativeSelect>
        </label>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-text-subtle text-xs font-medium">Name</span>
          <input
            ref={nameRef}
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            maxLength={MAX_NAME_LENGTH}
            placeholder={kind === "anonrouter" ? "e.g. AnonRouter private" : "e.g. Work OpenRouter"}
            disabled={busy}
            className={fieldClass}
          />
        </label>
      </div>
      <label className="flex flex-col gap-1.5">
        <span className="text-text-subtle text-xs font-medium">{meta.name} key</span>
        <input
          type="password"
          value={key}
          onChange={(e) => {
            setKey(e.target.value)
            setError(null)
          }}
          placeholder={meta.placeholder}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          data-1p-ignore
          data-lpignore="true"
          disabled={busy}
          className={cn(fieldClass, "font-mono")}
        />
      </label>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <p className="text-muted-foreground text-xs leading-relaxed">
        {kind === "anonrouter" ? (
          <>
            Use an inference key (<code className="font-mono">ar_</code>) with OpenAI-compatible access, from{" "}
            <a href={meta.keysUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
              {meta.keysLabel}
            </a>
            . End-to-end-encrypted models aren&apos;t listed: they need the client to encrypt each prompt.
          </>
        ) : (
          <>
            Create one at{" "}
            <a href={meta.keysUrl} target="_blank" rel="noopener noreferrer" className={linkClass}>
              {meta.keysLabel}
            </a>
            .
          </>
        )}{" "}
        The key is checked with {meta.name} before it is saved, and is never shown again.
      </p>
      <div className="flex gap-2">
        <Button type="submit" className="rounded-md" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {busy ? "Checking…" : "Save key"}
        </Button>
        <Button type="button" variant="outline" className="rounded-md" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function KeyRow({
  meta,
  first,
  others,
  choosable,
  onRenamed,
  onDefault,
  onRemoved,
}: {
  meta: ModelKeyMeta
  first: boolean
  others: ModelKeyMeta[]
  /** More than one OpenRouter key, so which is the default is a choice. */
  choosable: boolean
  onRenamed: (next: ModelKeyMeta) => void
  onDefault: (next: ModelKeyMeta) => void
  onRemoved: () => void
}) {
  const [renaming, setRenaming] = React.useState(false)
  const [draft, setDraft] = React.useState(meta.name)
  const [confirming, setConfirming] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const now = Date.now()

  async function rename(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    if (draft.trim() === meta.name) {
      setRenaming(false)
      return
    }
    const problem = nameError(draft, others)
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      onRenamed(await renameModelKey(meta.id, draft.trim()))
      setRenaming(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename the key.")
    } finally {
      setBusy(false)
    }
  }

  async function makeDefault() {
    setBusy(true)
    setError(null)
    try {
      onDefault(await makeDefaultModelKey(meta.id))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not make it the default.")
    } finally {
      setBusy(false)
    }
  }

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await removeModelKey(meta.id)
      onRemoved()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the key.")
      setBusy(false)
    }
  }

  return (
    <li className={cn("flex flex-col gap-2 px-4 py-3", !first && "border-t")}>
      <div className="flex flex-wrap items-center gap-3">
        <KindTile kind={meta.kind} />
        <div className="flex min-w-0 flex-[1_1_12rem] flex-col gap-0.5">
          {renaming ? (
            <form onSubmit={rename} className="flex items-center gap-1.5">
              <input
                autoFocus
                aria-label="Key name"
                value={draft}
                maxLength={MAX_NAME_LENGTH}
                onChange={(e) => {
                  setDraft(e.target.value)
                  setError(null)
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") {
                    setRenaming(false)
                    setDraft(meta.name)
                    setError(null)
                  }
                }}
                disabled={busy}
                className={cn(fieldClass, "h-7 flex-1")}
              />
              <Button type="submit" size="icon" variant="ghost" className="size-7" aria-label="Save name" disabled={busy}>
                {busy ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Cancel rename"
                onClick={() => {
                  setRenaming(false)
                  setDraft(meta.name)
                  setError(null)
                }}
                disabled={busy}
              >
                <XIcon />
              </Button>
            </form>
          ) : (
            <span className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{meta.name}</span>
              <span className="text-muted-foreground inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px]">
                {KIND_NAMES[meta.kind]}
              </span>
              {meta.kind === "openrouter" && meta.isDefault && (
                <span
                  className="bg-primary/10 text-primary inline-flex h-5 shrink-0 items-center rounded-full px-2 text-[11px] font-medium"
                  title="Voice input, research, OMP and the other general uses bill this key."
                >
                  Default
                </span>
              )}
            </span>
          )}
          <span className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
            <span className="flex min-w-0 font-mono" aria-label={`ending ${meta.last4}`}>
              <span className="shrink-0">{meta.prefix}</span>
              <span className="min-w-0 overflow-hidden whitespace-nowrap" aria-hidden>
                {MASK.slice(0, 8)}
              </span>
              <span className="shrink-0">{meta.last4}</span>
            </span>
            <span aria-hidden>·</span>
            <span className="shrink-0" title={fullDate(meta.lastUsedAt)}>
              {meta.lastUsedAt ? `Used ${relativeWhen(meta.lastUsedAt, now).toLowerCase()}` : "Not used yet"}
            </span>
          </span>
        </div>
        {!renaming && (
          <div className="ml-auto flex items-center gap-1.5">
            {confirming ? (
              <>
                <span className="text-xs">Remove?</span>
                <Button variant="destructive" className="h-7 rounded-md px-2.5 text-xs" onClick={() => void remove()} disabled={busy}>
                  {busy ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
                  Remove
                </Button>
                <Button variant="outline" className="h-7 rounded-md px-2.5 text-xs" onClick={() => setConfirming(false)} disabled={busy}>
                  Keep
                </Button>
              </>
            ) : (
              <>
                {choosable && meta.kind === "openrouter" && !meta.isDefault && (
                  <Button
                    variant="ghost"
                    className="text-muted-foreground h-7 rounded-md px-2 text-xs"
                    title="Bill voice input, research, OMP and the other general uses to this key"
                    onClick={() => void makeDefault()}
                    disabled={busy}
                  >
                    {busy ? <Loader2Icon className="animate-spin" /> : <StarIcon />}
                    Make default
                  </Button>
                )}
                <Button
                  variant="ghost"
                  size="icon"
                  className="size-7"
                  aria-label={`Rename ${meta.name}`}
                  onClick={() => {
                    setDraft(meta.name)
                    setRenaming(true)
                  }}
                >
                  <PencilIcon />
                </Button>
                <Button
                  variant="ghost"
                  size="icon"
                  className="text-muted-foreground hover:text-destructive size-7"
                  aria-label={`Remove ${meta.name}`}
                  onClick={() => setConfirming(true)}
                >
                  <TrashIcon />
                </Button>
              </>
            )}
          </div>
        )}
      </div>
      {confirming && (
        <p className="text-muted-foreground text-xs">
          Threads on this key&apos;s models stop working until another model is picked.
        </p>
      )}
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
    </li>
  )
}
