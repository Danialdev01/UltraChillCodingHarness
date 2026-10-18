"use client"

import * as React from "react"
import dynamic from "next/dynamic"
import {
  AlertTriangleIcon,
  BotIcon,
  CheckIcon,
  KeyRoundIcon,
  Loader2Icon,
  LogInIcon,
  LogOutIcon,
  RefreshCwIcon,
  TerminalIcon,
  TrashIcon,
} from "lucide-react"

import type { LoginProgram } from "@/components/login-terminal-dialog"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  fetchProviders,
  saveClaudeToken,
  saveDefaultProvider,
  signOutProvider,
  type ProviderCard,
  type ProviderId,
  type ProvidersResponse,
} from "@/lib/providers-api"
import { cn } from "@/lib/utils"

// xterm comes with the sign-in terminal, which most visits to settings never open.
const LoginTerminalDialog = dynamic(
  () => import("@/components/login-terminal-dialog").then((m) => m.LoginTerminalDialog),
  { ssr: false },
)

/** Where the Codex warning acknowledgement is remembered. */
const CODEX_ACK_KEY = "ucch:codex-warning-ack"

/**
 * The agent providers: which backend answers a turn, and whether each one
 * is ready to.
 *
 * Three cards. The native loop needs an OpenRouter key from the API tab.
 * Claude Code and Codex need the vendor's CLI signed in on the server, and
 * this page is where that happens -- in a terminal, running the CLI's own
 * login flow, so the server never handles the credential. Claude also takes
 * a pasted `setup-token` for the headless case; that one the server does
 * hold, encrypted, and it says so.
 *
 * What the cards show comes from probing the CLIs themselves. A masked
 * account label is the most any of it reveals.
 */
export function ProviderSettings({
  projects,
  workspaceId,
  readOnly = false,
}: {
  projects: { id: string; name: string }[]
  /**
   * Set on the workspace's Harness page: the cards are that workspace's
   * dedicated subscription rather than your own, and the account-only
   * parts -- the default provider, the OpenRouter key -- are left out.
   */
  workspaceId?: string
  /** Shown, but nothing can be changed: a member looking at the workspace's subscription. */
  readOnly?: boolean
}) {
  const [data, setData] = React.useState<ProvidersResponse | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [refreshing, setRefreshing] = React.useState(false)
  const [login, setLogin] = React.useState<LoginProgram | null>(null)
  const [projectId, setProjectId] = React.useState<string>(projects[0]?.id ?? "")

  const load = React.useCallback(async (fresh: boolean) => {
    setRefreshing(true)
    try {
      setData(await fetchProviders(fresh, workspaceId))
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load providers.")
    } finally {
      setRefreshing(false)
    }
  }, [workspaceId])

  React.useEffect(() => {
    void load(false)
  }, [load])

  if (loadError && !data) {
    return (
      <section className="rounded-lg border p-6">
        <p className="text-destructive text-sm">{loadError}</p>
      </section>
    )
  }

  const cards = data?.providers

  return (
    <div className="flex flex-col gap-4">
      {data && !data.cliEnabled && (
        <p className="border-warning/40 bg-warning-soft text-warning flex gap-2 rounded-lg border px-4 py-3 text-sm">
          <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
          <span>
            The Claude Code and Codex providers are disabled on this server. Until the container
            runtime lands they run the CLI on the host, so production needs{" "}
            <code className="font-mono">AGENT_ALLOW_HOST_SHELL=true</code>, the same flag the
            terminal needs.
          </span>
        </p>
      )}

      {!workspaceId && (
        <>
          <DefaultProviderCard
            value={data?.defaultProvider ?? "native"}
            cards={cards ?? null}
            onChange={(provider) =>
              setData((current) => (current ? { ...current, defaultProvider: provider } : current))
            }
          />

          <NativeCard card={cards?.native ?? null} />
        </>
      )}

      <ClaudeCard
        card={cards?.claude ?? null}
        encryptionAvailable={data?.encryptionAvailable ?? true}
        canLogin={projects.length > 0 && !readOnly}
        readOnly={readOnly}
        workspaceId={workspaceId}
        onLogin={() => setLogin("claude-login")}
        onChanged={() => void load(true)}
      />

      <CodexCard
        card={cards?.codex ?? null}
        canLogin={projects.length > 0 && !readOnly}
        readOnly={readOnly}
        workspaceId={workspaceId}
        onLogin={() => setLogin("codex-login")}
        onChanged={() => void load(true)}
      />

      <div className="flex items-center gap-3">
        <Button variant="outline" size="sm" onClick={() => void load(true)} disabled={refreshing}>
          {refreshing ? <Loader2Icon className="animate-spin" /> : <RefreshCwIcon />}
          Check again
        </Button>
        {projects.length > 1 && (
          // A sign-in terminal is published on a project's channel, so one
          // has to be named. Which one changes nothing about the login.
          <label className="text-muted-foreground flex items-center gap-2 text-xs">
            Sign in via
            <select
              value={projectId}
              onChange={(e) => setProjectId(e.target.value)}
              className="border-input bg-background h-7 rounded-md border px-2 text-xs"
            >
              {projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
          </label>
        )}
        {projects.length === 0 && (
          <span className="text-muted-foreground text-xs">
            Create a project first to sign in from a terminal, or paste a token.
          </span>
        )}
      </div>

      {login && projectId && (
        <LoginTerminalDialog
          program={login}
          projectId={projectId}
          credentialWorkspaceId={workspaceId}
          open
          onOpenChange={(open) => {
            if (!open) {
              setLogin(null)
              void load(true)
            }
          }}
          onExited={() => void load(true)}
        />
      )}
    </div>
  )
}

function StatusPill({ card }: { card: ProviderCard | null }) {
  if (!card) return <Skeleton className="h-5 w-24 rounded-full" />
  const [label, tone] = !card.enabled
    ? ["Disabled", "muted"]
    : !card.installed
      ? ["Not installed", "muted"]
      : card.authenticated
        ? [
            card.authMode === "subscription"
              ? "Signed in · subscription"
              : card.authMode === "token"
                ? "Signed in · token"
                : "Signed in · API key",
            card.authMode === "api-key" ? "warn" : "ok",
          ]
        : ["Not signed in", "warn"]
  return (
    <span
      className={cn(
        "rounded-full border px-2 py-0.5 text-xs",
        tone === "ok" && "border-ucch-active/40 text-ucch-active",
        tone === "warn" && "border-warning/40 bg-warning-soft text-warning",
        tone === "muted" && "text-muted-foreground",
      )}
    >
      {label}
    </span>
  )
}

function CardShell({
  icon: Icon,
  title,
  card,
  children,
}: {
  icon: React.ComponentType<{ className?: string }>
  title: string
  card: ProviderCard | null
  children: React.ReactNode
}) {
  return (
    <section className="rounded-lg border p-6">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Icon className="text-muted-foreground size-4" />
          {title}
        </h2>
        <StatusPill card={card} />
        {card?.version && (
          <span className="text-muted-foreground font-mono text-xs">v{card.version}</span>
        )}
        {card?.account && (
          <span className="text-muted-foreground font-mono text-xs">{card.account}</span>
        )}
      </div>
      {children}
    </section>
  )
}

function DefaultProviderCard({
  value,
  cards,
  onChange,
}: {
  value: ProviderId
  cards: Record<ProviderId, ProviderCard> | null
  onChange: (provider: ProviderId) => void
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function choose(provider: ProviderId) {
    setBusy(true)
    setError(null)
    try {
      await saveDefaultProvider(provider === "native" ? null : provider)
      onChange(provider)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <BotIcon className="text-muted-foreground size-4" />
        Default provider
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Which backend a new thread starts on when the composer does not say. A thread stays on the
        provider its first message ran under; switching means a new thread.
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        {(["native", "claude", "codex"] as const).map((id) =>
          // Before the cards arrive the pick is a guess; bars, not a wrong highlight.
          !cards ? (
            <Skeleton key={id} className="h-8 w-20" />
          ) : (
            <Button
              key={id}
              variant={value === id ? "default" : "outline"}
              size="sm"
              disabled={busy}
              onClick={() => void choose(id)}
            >
              {cards[id]?.label ?? id}
            </Button>
          ),
        )}
      </div>
      {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
    </section>
  )
}

function NativeCard({ card }: { card: ProviderCard | null }) {
  return (
    <CardShell icon={KeyRoundIcon} title="Custom (built-in loop)" card={card}>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        The harness's own agent, billed to your OpenRouter key from the{" "}
        <a href="#api" className="text-ucch-active underline underline-offset-2">
          API Management
        </a>{" "}
        tab. Any model in the catalogue; usage and cost are recorded per turn.
      </p>
    </CardShell>
  )
}

function ClaudeCard({
  card,
  encryptionAvailable,
  canLogin,
  readOnly,
  workspaceId,
  onLogin,
  onChanged,
}: {
  card: ProviderCard | null
  encryptionAvailable: boolean
  canLogin: boolean
  readOnly: boolean
  workspaceId: string | undefined
  onLogin: () => void
  onChanged: () => void
}) {
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState<"token" | "clear" | "signout" | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)

  async function act(kind: "token" | "clear" | "signout", fn: () => Promise<void>) {
    setBusy(kind)
    setError(null)
    setSaved(false)
    try {
      await fn()
      setSaved(kind === "token")
      setDraft("")
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const usable = Boolean(card?.enabled && card.installed)

  return (
    <CardShell icon={TerminalIcon} title="Claude Code" card={card}>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Runs the <code className="font-mono">claude</code> CLI on your Claude subscription. Sign in
        from a terminal here -- the server never sees the credential -- or paste a long-lived token
        from <code className="font-mono">claude setup-token</code> run on your own machine, which the
        server stores encrypted and injects for each run.
      </p>

      {card?.warnings?.map((warning) => (
        <p key={warning} className="text-warning mt-2 text-sm">
          {warning}
        </p>
      ))}
      {card?.error && !card.installed && (
        <p className="text-muted-foreground mt-2 font-mono text-xs">{card.error}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={onLogin} disabled={!usable || !canLogin || busy !== null}>
          <LogInIcon />
          Sign in (terminal)
        </Button>
        {card?.authenticated && !readOnly && (
          <Button
            variant="outline"
            onClick={() => void act("signout", () => signOutProvider("claude", workspaceId))}
            disabled={busy !== null}
          >
            {busy === "signout" ? <Loader2Icon className="animate-spin" /> : <LogOutIcon />}
            Sign out
          </Button>
        )}
      </div>

      {!readOnly && <div className="mt-4 flex max-w-xl flex-wrap items-center gap-2">
        <Input
          type="password"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder={card?.token?.configured ? "A token is stored; paste to replace" : "sk-ant-oat01-…"}
          autoComplete="off"
          spellCheck={false}
          aria-label="Claude OAuth token"
          className="min-w-64 flex-1 font-mono text-sm"
          disabled={busy !== null || !encryptionAvailable}
        />
        <Button
          variant="outline"
          onClick={() => void act("token", () => saveClaudeToken(draft.trim(), workspaceId))}
          disabled={busy !== null || !draft.trim() || !encryptionAvailable}
        >
          {busy === "token" && <Loader2Icon className="animate-spin" />}
          {card?.token?.configured ? "Replace token" : "Save token"}
        </Button>
        {card?.token?.configured && (
          <Button
            variant="outline"
            onClick={() => void act("clear", () => saveClaudeToken(null, workspaceId))}
            disabled={busy !== null}
          >
            <TrashIcon />
            Remove token
          </Button>
        )}
      </div>}

      <div className="mt-3 text-sm">
        {error ? (
          <p className="text-destructive">{error}</p>
        ) : saved ? (
          <p className="text-ucch-active flex items-center gap-1.5">
            <CheckIcon className="size-4" />
            Saved.
          </p>
        ) : !card ? (
          <Skeleton className="my-0.5 h-3.5 w-3/4 max-w-prose" />
        ) : card.token?.configured ? (
          <p className={cn("text-muted-foreground", card.token.expiresSoon && "text-warning")}>
            A token stored on {card.token.issuedAt ? new Date(card.token.issuedAt).toLocaleDateString() : "an unknown date"}{" "}
            is in use.{card.token.expiresSoon && " Tokens last a year: it is time to mint a new one."}
          </p>
        ) : !encryptionAvailable ? (
          <p className="text-muted-foreground">
            <code className="font-mono">SECRET_KEY</code> is not configured, so a token cannot be stored. Sign in
            from the terminal instead.
          </p>
        ) : (
          <p className="text-muted-foreground">
            No token stored. Signing in from the terminal is the better-hygiene path; the token is for
            servers where that is awkward.
          </p>
        )}
      </div>
    </CardShell>
  )
}

function CodexCard({
  card,
  canLogin,
  readOnly,
  workspaceId,
  onLogin,
  onChanged,
}: {
  card: ProviderCard | null
  canLogin: boolean
  readOnly: boolean
  workspaceId: string | undefined
  onLogin: () => void
  onChanged: () => void
}) {
  const [acknowledged, setAcknowledged] = React.useState(false)
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    try {
      setAcknowledged(globalThis.localStorage?.getItem(CODEX_ACK_KEY) === "1")
    } catch {
      /* not remembered */
    }
  }, [])

  function acknowledge(next: boolean) {
    setAcknowledged(next)
    try {
      if (next) globalThis.localStorage?.setItem(CODEX_ACK_KEY, "1")
      else globalThis.localStorage?.removeItem(CODEX_ACK_KEY)
    } catch {
      /* not remembered */
    }
  }

  async function signOut() {
    setBusy(true)
    setError(null)
    try {
      await signOutProvider("codex", workspaceId)
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const usable = Boolean(card?.enabled && card.installed)
  // The first warning is the spec's own text; the rest are probe findings.
  const [advisory, ...findings] = card?.warnings ?? []

  return (
    <CardShell icon={TerminalIcon} title="Codex" card={card}>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Runs the <code className="font-mono">codex</code> CLI on your ChatGPT subscription, signed
        in with a device code from a terminal here.
      </p>

      {advisory && (
        <div className="border-warning/40 bg-warning-soft mt-3 max-w-prose rounded-md border px-3 py-2 text-sm">
          <p className="text-warning flex gap-2">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            {advisory}
          </p>
          <label className="mt-2 flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={acknowledged}
              onChange={(e) => acknowledge(e.target.checked)}
            />
            I understand and this is my own machine and my own repositories.
          </label>
        </div>
      )}
      {findings.map((warning) => (
        <p key={warning} className="text-warning mt-2 text-sm">
          {warning}
        </p>
      ))}
      {card?.error && !card.installed && (
        <p className="text-muted-foreground mt-2 font-mono text-xs">{card.error}</p>
      )}

      <div className="mt-4 flex flex-wrap items-center gap-2">
        <Button onClick={onLogin} disabled={!usable || !canLogin || !acknowledged || busy}>
          <LogInIcon />
          Sign in (device code)
        </Button>
        {card?.authenticated && !readOnly && (
          <Button variant="outline" onClick={() => void signOut()} disabled={busy}>
            {busy ? <Loader2Icon className="animate-spin" /> : <LogOutIcon />}
            Sign out
          </Button>
        )}
      </div>
      {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
    </CardShell>
  )
}
