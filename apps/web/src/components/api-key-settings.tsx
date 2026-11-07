"use client"

import * as React from "react"
import {
  AlertTriangleIcon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  ShieldCheckIcon,
  TrashIcon,
} from "lucide-react"

import { OpenRouterMark, ResendMark } from "@/components/brand-marks"
import { GithubMark } from "@/components/github-mark"
import { InlineError } from "@/components/layout/inline-error"
import { SettingsSection } from "@/components/layout/settings-section"
import { ApiKeysSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  clipboardAvailable,
  fetchApiKeys,
  fullDate,
  MASK,
  reauthenticate,
  relativeWhen,
  removeApiKey,
  revealApiKey,
  saveApiKey,
  writeClipboardLater,
  type ApiKeyMeta,
  type ApiKeyProvider,
  type ApiKeysResponse,
} from "@/lib/api-keys"
import { useToast } from "@/lib/realtime"
import { settingsPageHref } from "@/lib/sections"
import { cn } from "@/lib/utils"
import { TransitionLink } from "@/lib/view-transitions"

/** Everything that differs between one provider's card and another's. */
interface Provider {
  id: ApiKeyProvider
  name: string
  /** Lucide-shaped: a `className` and nothing else. */
  icon: React.ComponentType<{ className?: string }>
  description: string
  placeholder: string
  /** Where to get one, and what it needs. */
  help: React.ReactNode
  /** What stops when the key is removed. */
  consequence: string
  /** The fourth item in the footer strip. */
  extra?: (meta: ApiKeyMeta) => { label: string; value: string }
}

const linkClass = "text-primary underline underline-offset-2 hover:no-underline"

const PROVIDERS: Provider[] = [
  {
    id: "openrouter",
    name: "OpenRouter",
    icon: OpenRouterMark,
    description: "The key every agent turn is billed to.",
    placeholder: "sk-or-v1-…",
    help: (
      <>
        Create one at{" "}
        <a href="https://openrouter.ai/keys" target="_blank" rel="noopener noreferrer" className={linkClass}>
          openrouter.ai/keys
        </a>
        .
      </>
    ),
    consequence: "Agent turns will stop until a new key is added.",
    extra: () => ({ label: "Used by", value: "All projects" }),
  },
  {
    id: "resend",
    name: "Resend",
    icon: ResendMark,
    description: "Sends email on your behalf: address verification and notifications.",
    placeholder: "re_…",
    help: (
      <>
        Create one at{" "}
        <a href="https://resend.com/api-keys" target="_blank" rel="noopener noreferrer" className={linkClass}>
          resend.com/api-keys
        </a>
        .
      </>
    ),
    consequence: "Email sending will stop.",
  },
  {
    id: "github",
    name: "GitHub",
    icon: GithubMark,
    description: "Lists repos and branches when you create a project, and authenticates private clones.",
    placeholder: "ghp_… or github_pat_…",
    help: (
      <>
        Classic tokens need the <code className="font-mono">repo</code> scope; fine-grained tokens need read access to
        contents and metadata. Create one at{" "}
        <a href="https://github.com/settings/tokens" target="_blank" rel="noopener noreferrer" className={linkClass}>
          github.com/settings/tokens
        </a>
        .
      </>
    ),
    consequence: "Repo listing and private clones will stop.",
    extra: (meta) => ({ label: "Scopes", value: meta.scopes ?? "Unknown" }),
  },
]

type Purpose = "reveal" | "copy"

/** A pending Reveal or Copy waiting on the password dialog. */
interface StepUpRequest {
  provider: Provider
  purpose: Purpose
  opener: HTMLElement | null
  /** Started from the dialog's submit, with whether the password was right. */
  run: (gate: Promise<boolean>) => void
}

interface StepUp {
  /** A step-up this session made in the last five minutes, as far as this page knows. */
  active(): boolean
  /** The server said otherwise: forget it. */
  expire(): void
  request(request: StepUpRequest): void
}

/**
 * Account Setting -> API keys.
 *
 * One card per provider. A stored key is shown masked, drawn from its prefix
 * and last four alone. Reveal and Copy ask the server for the key itself,
 * which it gives only after the password is confirmed (five minutes per
 * confirmation) and records in Activity. A revealed key hides itself after
 * thirty seconds, when the tab is hidden, or when the card goes away.
 */
export function ApiKeySettings() {
  const [data, setData] = React.useState<ApiKeysResponse | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [stepUpRequest, setStepUpRequest] = React.useState<StepUpRequest | null>(null)
  /** When the last step-up lapses, in this tab's clock. Not a secret: a timestamp. */
  const stepUpUntil = React.useRef(0)

  const load = React.useCallback(async () => {
    try {
      const next = await fetchApiKeys()
      setData(next)
      setLoadError(null)
      if (next.stepUpExpiresInSeconds > 0) {
        stepUpUntil.current = Date.now() + next.stepUpExpiresInSeconds * 1000
      }
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load your keys.")
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  const stepUp = React.useMemo<StepUp>(
    () => ({
      // A little margin, so a request sent at 4:59 is not refused at 5:00.
      active: () => Date.now() < stepUpUntil.current - 5_000,
      expire: () => {
        stepUpUntil.current = 0
      },
      request: setStepUpRequest,
    }),
    [],
  )

  const reveal = data?.reveal
  return (
    <SettingsSection
      plain
      icon={KeyRoundIcon}
      title="API keys"
      description="Credentials the harness uses on your behalf. Keys are encrypted at rest and decrypted only when a request needs them."
    >
      <aside className="bg-muted/40 flex gap-3 rounded-lg border px-4 py-3 text-sm">
        <ShieldCheckIcon className="text-primary mt-0.5 size-4 shrink-0" aria-hidden />
        <div className="flex flex-col gap-1">
          <p className="font-medium">Revealing a key needs your password.</p>
          <p className="text-muted-foreground">
            A revealed key hides itself again after 30 seconds, and every reveal or copy is recorded in{" "}
            <TransitionLink href={settingsPageHref("activity")} className={linkClass}>
              Activity
            </TransitionLink>
            .
          </p>
          {reveal && !reveal.available && (
            <p className="text-warning">
              {reveal.reason}{" "}
              {reveal.code === "PASSWORD_REQUIRED" && (
                <TransitionLink href={settingsPageHref("account")} className={linkClass}>
                  Go to Account
                </TransitionLink>
              )}
            </p>
          )}
        </div>
      </aside>

      {data && !data.encryptionAvailable && (
        <InlineError tone="warning">
          <code className="font-mono">SECRET_KEY</code> is not configured on the server, so keys can&apos;t be stored
          or revealed. Generate one with <code className="font-mono">openssl rand -hex 32</code>.
        </InlineError>
      )}

      {loadError && !data ? (
        <InlineError onRetry={() => void load()}>{loadError}</InlineError>
      ) : !data ? (
        <ApiKeysSkeleton />
      ) : (
        <div className="flex flex-col gap-4">
          {PROVIDERS.map((provider) => (
            <ProviderCard
              key={provider.id}
              provider={provider}
              meta={data.keys.find((k) => k.provider === provider.id)!}
              encryptionAvailable={data.encryptionAvailable}
              githubFromLogin={data.githubFromLogin}
              stepUp={stepUp}
              onChanged={() => void load()}
            />
          ))}
        </div>
      )}

      <StepUpDialog
        request={stepUpRequest}
        onClose={() => setStepUpRequest(null)}
        onConfirmed={() => {
          stepUpUntil.current = Date.now() + 5 * 60_000
        }}
      />
    </SettingsSection>
  )
}

function ProviderCard({
  provider,
  meta,
  encryptionAvailable,
  githubFromLogin,
  stepUp,
  onChanged,
}: {
  provider: Provider
  meta: ApiKeyMeta
  encryptionAvailable: boolean
  githubFromLogin: boolean
  stepUp: StepUp
  onChanged: () => void
}) {
  const [replacing, setReplacing] = React.useState(false)
  const configured = meta.configured
  const editing = !configured || replacing

  return (
    <section
      aria-labelledby={`key-${provider.id}-title`}
      className="bg-card text-card-foreground overflow-hidden rounded-lg border"
    >
      <div className="flex flex-col gap-4 p-4">
        <div className="flex items-start gap-3">
          <span className="bg-background text-foreground flex size-8 shrink-0 items-center justify-center rounded-md border">
            <provider.icon className="size-4" aria-hidden />
          </span>
          <div className="flex min-w-0 flex-col gap-1">
            <div className="flex flex-wrap items-center gap-2">
              <h2 id={`key-${provider.id}-title`} className="text-sm font-medium">
                {provider.name}
              </h2>
              <StatusPill configured={configured} />
            </div>
            <p className="text-muted-foreground text-sm">{provider.description}</p>
          </div>
        </div>

        {editing ? (
          <KeyForm
            provider={provider}
            replacing={configured}
            encryptionAvailable={encryptionAvailable}
            note={
              provider.id === "github" && !configured && githubFromLogin
                ? "Until you add one, the token from signing in with GitHub is used, which covers the repos that sign-in can see."
                : null
            }
            onCancel={configured ? () => setReplacing(false) : undefined}
            onSaved={() => {
              setReplacing(false)
              onChanged()
            }}
          />
        ) : (
          <KeyRow
            provider={provider}
            meta={meta}
            encryptionAvailable={encryptionAvailable}
            stepUp={stepUp}
            onReplace={() => setReplacing(true)}
            onChanged={onChanged}
          />
        )}
      </div>

      {configured && <MetaStrip provider={provider} meta={meta} />}
    </section>
  )
}

function StatusPill({ configured }: { configured: boolean }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded-sm border px-1.5 py-px text-[11px] font-medium tracking-wide uppercase",
        configured
          ? "border-success/30 bg-success-soft text-success"
          : "border-warning/30 bg-warning-soft text-warning",
      )}
    >
      <span className={cn("size-1.5 rounded-[1px]", configured ? "bg-success" : "bg-warning")} aria-hidden />
      {configured ? "Active" : "Not configured"}
    </span>
  )
}

/** A stored key: masked, or for thirty seconds revealed, with what can be done to it. */
function KeyRow({
  provider,
  meta,
  encryptionAvailable,
  stepUp,
  onReplace,
  onChanged,
}: {
  provider: Provider
  meta: ApiKeyMeta
  encryptionAvailable: boolean
  stepUp: StepUp
  onReplace: () => void
  onChanged: () => void
}) {
  const toast = useToast()
  // The plaintext's only home, and only for `expiresAt - now`.
  const [revealed, setRevealed] = React.useState<{ key: string; expiresAt: number } | null>(null)
  const [now, setNow] = React.useState(() => Date.now())
  const [busy, setBusy] = React.useState<Purpose | null>(null)
  const [copied, setCopied] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [removing, setRemoving] = React.useState(false)
  const busyRef = React.useRef(false)

  const hide = React.useCallback(() => setRevealed(null), [])

  // The countdown, and the wipe when it reaches zero.
  React.useEffect(() => {
    if (!revealed) return
    const tick = () => {
      const t = Date.now()
      setNow(t)
      if (t >= revealed.expiresAt) setRevealed(null)
    }
    tick()
    const timer = setInterval(tick, 250)
    return () => clearInterval(timer)
  }, [revealed])

  // Switching tabs or minimising hides it at once.
  React.useEffect(() => {
    if (!revealed) return
    const onVisibility = () => {
      if (document.visibilityState === "hidden") setRevealed(null)
    }
    document.addEventListener("visibilitychange", onVisibility)
    return () => document.removeEventListener("visibilitychange", onVisibility)
  }, [revealed])

  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 2_000)
    return () => clearTimeout(timer)
  }, [copied])

  // Leaving the page drops it with the component; this makes it explicit.
  React.useEffect(() => () => setRevealed(null), [])

  function access(purpose: Purpose, opener: HTMLElement | null) {
    if (busyRef.current) return
    setError(null)
    if (purpose === "copy" && !clipboardAvailable()) {
      toast({
        title: "Clipboard unavailable",
        description: "This browser won't let the page copy. Use Reveal and copy the key yourself.",
        tone: "error",
      })
      return
    }
    const run = (gate: Promise<boolean>) =>
      void (purpose === "reveal" ? doReveal(gate, opener) : doCopy(gate, opener))
    if (stepUp.active()) run(Promise.resolve(true))
    else stepUp.request({ provider, purpose, opener, run })
  }

  async function doReveal(gate: Promise<boolean>, opener: HTMLElement | null) {
    busyRef.current = true
    setBusy("reveal")
    try {
      if (!(await gate)) return
      const result = await revealApiKey(provider.id, "reveal")
      if (result.kind === "key") {
        setRevealed({ key: result.key, expiresAt: Date.now() + result.expiresInSeconds * 1000 })
        onChanged()
      } else if (result.kind === "reauth") {
        stepUp.expire()
        stepUp.request({ provider, purpose: "reveal", opener, run: (g) => void doReveal(g, opener) })
      } else {
        setError(result.error)
      }
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  async function doCopy(gate: Promise<boolean>, opener: HTMLElement | null) {
    busyRef.current = true
    setBusy("copy")
    // What happened, without the key: the key itself only ever passes
    // through the promise handed to the clipboard.
    type Outcome = { kind: "gate" } | { kind: "key" } | { kind: "reauth" } | { kind: "error"; error: string }
    const outcome: { current: Outcome } = { current: { kind: "gate" } }
    try {
      const ok = await writeClipboardLater(
        gate.then(async (passed) => {
          if (!passed) return null
          const result = await revealApiKey(provider.id, "copy")
          if (result.kind === "key") {
            outcome.current = { kind: "key" }
            return result.key
          }
          outcome.current = result.kind === "reauth" ? { kind: "reauth" } : { kind: "error", error: result.error }
          return null
        }),
      )
      const settled = outcome.current
      if (ok) {
        setCopied(true)
        onChanged()
      } else if (settled.kind === "reauth") {
        stepUp.expire()
        stepUp.request({ provider, purpose: "copy", opener, run: (g) => void doCopy(g, opener) })
      } else if (settled.kind === "error") {
        setError(settled.error)
      } else if (settled.kind === "key") {
        // The key came and the clipboard refused it. The access is logged
        // either way; say plainly that nothing was copied.
        onChanged()
        toast({ title: "Couldn't copy", description: "The browser refused the clipboard write. Try again.", tone: "error" })
      }
      // `gate`: the password was wrong; the dialog is already saying so.
    } finally {
      busyRef.current = false
      setBusy(null)
    }
  }

  const secondsLeft = revealed ? Math.max(0, Math.ceil((revealed.expiresAt - now) / 1000)) : 0
  const fieldId = `key-${provider.id}-value`
  const blocked = !encryptionAvailable

  return (
    <div className="flex flex-col gap-2">
      <div className="flex flex-wrap items-center gap-2">
        <div className="relative min-w-0 flex-[1_1_18rem]">
          {revealed ? (
            <input
              id={fieldId}
              readOnly
              value={revealed.key}
              aria-label={`${provider.name} key, revealed, hides in ${secondsLeft} seconds`}
              spellCheck={false}
              autoComplete="off"
              className={cn(
                "bg-background border-warning h-8 w-full truncate rounded-md border px-2.5 pr-28 font-mono text-sm outline-none",
                "focus-visible:ring-warning/40 focus-visible:ring-3",
              )}
              onFocus={(e) => e.currentTarget.select()}
            />
          ) : (
            // Drawn from metadata alone. Prefix and last four never clip; on
            // a narrow screen only the dots between them give way.
            <div
              id={fieldId}
              role="textbox"
              aria-readonly="true"
              aria-label={`${provider.name} key, hidden, ending ${meta.last4 ?? "unknown"}`}
              tabIndex={0}
              className={cn(
                "bg-background flex h-8 w-full items-center rounded-md border px-2.5 font-mono text-sm outline-none",
                "focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3",
              )}
            >
              <span className="shrink-0">{meta.prefix}</span>
              <span className="text-muted-foreground min-w-0 overflow-hidden whitespace-nowrap" aria-hidden>
                {MASK}
              </span>
              <span className="shrink-0">{meta.last4}</span>
            </div>
          )}
          {revealed && (
            <span
              role="timer"
              className="text-warning bg-background absolute top-1/2 right-2 -translate-y-1/2 rounded-sm px-1.5 text-xs font-medium tabular-nums"
            >
              Hides in {secondsLeft}s
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5 sm:gap-2">
          <Button
            variant="outline"
            className="rounded-md"
            aria-pressed={revealed ? true : false}
            aria-controls={fieldId}
            disabled={blocked || busy !== null}
            onClick={(e) => (revealed ? hide() : access("reveal", e.currentTarget))}
          >
            {busy === "reveal" ? <Loader2Icon className="animate-spin" /> : revealed ? <EyeOffIcon /> : <EyeIcon />}
            {revealed ? "Hide" : "Reveal"}
          </Button>
          <Button
            variant="outline"
            className="rounded-md"
            disabled={blocked || busy !== null}
            onClick={(e) => access("copy", e.currentTarget)}
          >
            {busy === "copy" ? <Loader2Icon className="animate-spin" /> : copied ? <CheckIcon /> : <CopyIcon />}
            {copied ? "Copied" : "Copy"}
          </Button>
          <Button variant="outline" className="rounded-md" onClick={onReplace} disabled={blocked || busy !== null}>
            Replace
          </Button>
          <Button
            variant="destructive"
            size="icon"
            className="size-8 rounded-md"
            aria-label={`Remove ${provider.name} key`}
            onClick={() => setRemoving(true)}
            disabled={busy !== null}
          >
            <TrashIcon />
          </Button>
        </div>
      </div>
      <p aria-live="polite" className={cn("text-sm", error ? "text-destructive" : "sr-only")}>
        {error ?? (copied ? `${provider.name} key copied to the clipboard.` : "")}
      </p>
      <RemoveDialog
        provider={provider}
        open={removing}
        onOpenChange={setRemoving}
        onRemoved={() => {
          setRevealed(null)
          onChanged()
        }}
      />
    </div>
  )
}

/** Adding a key, or replacing the stored one. */
function KeyForm({
  provider,
  replacing,
  encryptionAvailable,
  note,
  onCancel,
  onSaved,
}: {
  provider: Provider
  replacing: boolean
  encryptionAvailable: boolean
  note: string | null
  onCancel?: () => void
  onSaved: () => void
}) {
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  const id = `key-${provider.id}-input`

  React.useEffect(() => {
    if (replacing) inputRef.current?.focus()
  }, [replacing])

  async function save(event: React.FormEvent) {
    event.preventDefault()
    const key = draft.trim()
    if (!key || busy) return
    setBusy(true)
    setError(null)
    try {
      await saveApiKey(provider.id, key)
      setDraft("")
      onSaved()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the key.")
      inputRef.current?.focus()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-2" aria-busy={busy}>
      <label htmlFor={id} className="text-text-subtle text-xs font-medium">
        {replacing ? `New ${provider.name} key` : `${provider.name} key`}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <input
          ref={inputRef}
          id={id}
          type="password"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
            setError(null)
          }}
          placeholder={provider.placeholder}
          autoComplete="off"
          spellCheck={false}
          autoCapitalize="none"
          autoCorrect="off"
          data-1p-ignore
          data-lpignore="true"
          aria-invalid={error ? true : undefined}
          aria-describedby={`${id}-help${error ? ` ${id}-error` : ""}`}
          disabled={busy || !encryptionAvailable}
          className={cn(
            "bg-background placeholder:text-muted-foreground h-8 min-w-0 flex-[1_1_18rem] rounded-md border px-2.5 font-mono text-base outline-none md:text-sm",
            "focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3 disabled:opacity-50",
            "aria-invalid:border-destructive",
          )}
        />
        <div className="flex gap-2">
          <Button type="submit" className="rounded-md" disabled={busy || !draft.trim() || !encryptionAvailable}>
            {busy && <Loader2Icon className="animate-spin" />}
            {busy ? "Checking…" : "Save key"}
          </Button>
          {onCancel && (
            <Button type="button" variant="outline" className="rounded-md" onClick={onCancel} disabled={busy}>
              Cancel
            </Button>
          )}
        </div>
      </div>
      {error && (
        <p id={`${id}-error`} role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <p id={`${id}-help`} className="text-muted-foreground text-sm">
        {note && <span className="mb-1 block">{note}</span>}
        {provider.help}
      </p>
    </form>
  )
}

function MetaStrip({ provider, meta }: { provider: Provider; meta: ApiKeyMeta }) {
  const now = Date.now()
  const items: { label: string; value: string; title?: string }[] = [
    meta.createdAt
      ? { label: "Added", value: relativeWhen(meta.createdAt, now), title: fullDate(meta.createdAt) }
      : { label: "Added", value: "Unknown", title: "Stored before key history was recorded" },
    { label: "Last used", value: relativeWhen(meta.lastUsedAt, now), title: fullDate(meta.lastUsedAt) },
    { label: "Last revealed", value: relativeWhen(meta.lastRevealedAt, now), title: fullDate(meta.lastRevealedAt) },
  ]
  const extra = provider.extra?.(meta)
  if (extra) items.push(extra)
  return (
    <dl className="bg-muted/40 flex flex-wrap gap-x-6 gap-y-2 border-t px-4 py-3 text-xs">
      {items.map((item) => (
        <div key={item.label} className="flex gap-1.5">
          <dt className="text-text-subtle">{item.label}</dt>
          <dd className="text-foreground" title={item.title}>
            {item.value}
          </dd>
        </div>
      ))}
    </dl>
  )
}

function RemoveDialog({
  provider,
  open,
  onOpenChange,
  onRemoved,
}: {
  provider: Provider
  open: boolean
  onOpenChange: (open: boolean) => void
  onRemoved: () => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function remove() {
    setBusy(true)
    setError(null)
    try {
      await removeApiKey(provider.id)
      onOpenChange(false)
      onRemoved()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not remove the key.")
    } finally {
      setBusy(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !busy && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Remove {provider.name} key?</DialogTitle>
          <DialogDescription>{provider.consequence}</DialogDescription>
        </DialogHeader>
        {error && (
          <p role="alert" className="text-destructive text-sm">
            {error}
          </p>
        )}
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={busy}>
            Cancel
          </Button>
          <Button variant="destructive" onClick={() => void remove()} disabled={busy}>
            {busy ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
            Remove key
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** The password check before a Reveal or Copy, once per five minutes. */
function StepUpDialog({
  request,
  onClose,
  onConfirmed,
}: {
  request: StepUpRequest | null
  onClose: () => void
  onConfirmed: () => void
}) {
  const [password, setPassword] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const inputRef = React.useRef<HTMLInputElement>(null)
  // Focus goes back to whichever button asked.
  const opener = React.useRef<HTMLElement | null>(null)
  // The request survives the close animation, so the title does not blank out.
  const [shown, setShown] = React.useState<StepUpRequest | null>(null)

  React.useEffect(() => {
    if (!request) return
    opener.current = request.opener
    setShown(request)
    setPassword("")
    setError(null)
  }, [request])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!request || busy || !password) return
    setBusy(true)
    setError(null)
    const attempt = reauthenticate(password)
    // Started inside the submit, so a Copy's clipboard write still counts
    // as the user's own action.
    request.run(attempt.then((r) => r.ok))
    const result = await attempt
    setBusy(false)
    if (result.ok) {
      setPassword("")
      onConfirmed()
      onClose()
    } else {
      setError(result.error)
      setPassword("")
      inputRef.current?.focus()
    }
  }

  const verb = shown?.purpose === "copy" ? "Copy" : "Reveal"
  return (
    <Dialog open={request !== null} onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="sm:max-w-md" initialFocus={inputRef} finalFocus={opener}>
        <form onSubmit={submit} className="flex flex-col gap-4">
          <DialogHeader>
            <DialogTitle>
              {verb} {shown?.provider.name} key
            </DialogTitle>
            <DialogDescription>
              Confirm your password to continue. The key will hide again after 30 seconds.
            </DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="step-up-password" className="text-text-subtle text-xs font-medium">
              Password
            </label>
            <input
              ref={inputRef}
              id="step-up-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value)
                setError(null)
              }}
              aria-invalid={error ? true : undefined}
              aria-describedby={error ? "step-up-error" : undefined}
              disabled={busy}
              className={cn(
                "bg-background h-8 w-full rounded-md border px-2.5 text-base outline-none md:text-sm",
                "focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3",
                "aria-invalid:border-destructive",
              )}
            />
            {error && (
              <p id="step-up-error" role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy || !password}>
              {busy && <Loader2Icon className="animate-spin" />}
              {verb} key
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
