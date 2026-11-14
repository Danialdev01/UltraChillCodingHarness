"use client"

import * as React from "react"
import { InlineError } from "@/components/layout/inline-error"
import dynamic from "next/dynamic"
import {
  AlertTriangleIcon,
  BrainIcon,
  BracesIcon,
  KeyRoundIcon,
  Loader2Icon,
  MoreHorizontalIcon,
  RefreshCwIcon,
  StarIcon,
  TerminalIcon,
  TrashIcon,
} from "lucide-react"

import type { LoginProgram } from "@/components/login-terminal-dialog"
import { Button, buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { NativeSelect } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { AccountsList } from "@/components/agent-accounts"
import {
  clearOmpMemory,
  fetchAccounts,
  fetchOmpMemory,
  fetchProviders,
  saveDefaultProvider,
  type AgentAccount,
  type OmpMemoryStats,
  type ProviderCard,
  type ProviderId,
  type ProvidersResponse,
} from "@/lib/providers-api"
import { formatBytes } from "@/lib/attachments"
import { cn } from "@/lib/utils"
import { TransitionLink } from "@/lib/view-transitions"

// xterm comes with the sign-in dialogs, which most visits to settings never open.
const LoginTerminalDialog = dynamic(
  () => import("@/components/login-terminal-dialog").then((m) => m.LoginTerminalDialog),
  { ssr: false },
)
const ClaudeLoginDialog = dynamic(
  () => import("@/components/claude-login-dialog").then((m) => m.ClaudeLoginDialog),
  { ssr: false },
)

/** Where the Codex warning acknowledgement is remembered. */
const CODEX_ACK_KEY = "ucch:codex-warning-ack"

/** The providers this page lists. OMP is configured under the workspace's Harness settings. */
type ListedId = Exclude<ProviderId, "omp">

/** What the list shows of each provider: its tile, and a line saying what it is. */
const PROVIDER_META: Record<ListedId, { name: string; subtitle: string; tile: React.ReactNode }> = {
  claude: {
    name: "Claude Code",
    subtitle: "Runs the claude CLI on your Claude subscription.",
    tile: <span className="text-[11px] font-semibold tracking-tight">CC</span>,
  },
  codex: {
    name: "Codex",
    subtitle: "Runs the codex CLI on your ChatGPT subscription.",
    tile: <span className="text-[11px] font-semibold tracking-tight">Cx</span>,
  },
  native: {
    name: "Custom",
    subtitle: "The harness's own agent loop, billed to your OpenRouter key.",
    tile: <BracesIcon className="size-3.5" aria-hidden />,
  },
}

type Tone = "ok" | "warn" | "muted"

/** A provider's state in a word, and the longer line under it. */
function providerStatus(card: ProviderCard): { badge: string; detail: string; tone: Tone } {
  if (!card.enabled) return { badge: "Disabled", detail: "Turned off on this server.", tone: "muted" }
  if (!card.installed) {
    return card.id === "native"
      ? { badge: "Unavailable", detail: card.error ?? "The built-in loop is not available.", tone: "muted" }
      : { badge: "Not installed", detail: "The CLI was not found on this server.", tone: "muted" }
  }
  if (!card.authenticated) {
    return card.id === "native"
      ? { badge: "No key", detail: "Add an OpenRouter key under API keys.", tone: "warn" }
      : { badge: "Not signed in", detail: "Sign in an account below.", tone: "warn" }
  }
  const how =
    card.authMode === "subscription" ? "subscription" : card.authMode === "token" ? "token" : "API key"
  return {
    badge: "Ready",
    detail: card.id === "native" ? "OpenRouter API key" : `Signed in · ${how}`,
    tone: card.authMode === "api-key" && card.id !== "native" ? "warn" : "ok",
  }
}

const DOT: Record<Tone, string> = {
  ok: "bg-ucch-active",
  warn: "bg-warning",
  muted: "bg-muted-foreground/50",
}

/**
 * A signed-in CLI provider's list line: its default account's context, or
 * for Codex how much of the session window that account has used.
 */
function accountLine(provider: "claude" | "codex", accounts: AgentAccount[] | null): string | null {
  const own = accounts?.filter((a) => a.provider === provider) ?? []
  const account = own.find((a) => a.isDefault && a.authenticated) ?? own.find((a) => a.authenticated)
  if (!account) return null
  const session = account.quota?.status === "ok" ? account.quota.windows?.find((w) => w.id === "session") : undefined
  if (provider === "codex" && session) return `Signed in · ${Math.round(session.usedPercent)}% used`
  return `Signed in · ${account.context === "work" ? "Work" : "Personal"}`
}

/** Width of an element, kept current: the card lays out by its own width, not the window's. */
function useWidth<T extends HTMLElement>(): [React.RefObject<T | null>, number | null] {
  const ref = React.useRef<T>(null)
  const [width, setWidth] = React.useState<number | null>(null)
  React.useEffect(() => {
    const node = ref.current
    if (!node) return
    const observer = new ResizeObserver(([entry]) => setWidth(entry?.contentRect.width ?? null))
    observer.observe(node)
    return () => observer.disconnect()
  }, [])
  return [ref, width]
}

/**
 * The agent providers: which backend answers a turn, and whether each one
 * is ready to.
 *
 * A header with the last check, the default for new threads, then one card
 * holding the providers as a list on the left and the chosen one's details
 * on the right (stacked when the card is narrow). Claude Code and Codex need
 * the vendor's CLI signed in on the server, and this is where that happens
 * -- in a terminal, running the CLI's own login flow, so the server never
 * handles the credential. The Custom loop needs an OpenRouter key from the
 * API tab.
 *
 * What it shows comes from probing the CLIs themselves. A masked account
 * label is the most any of it reveals.
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
  const [checkedAt, setCheckedAt] = React.useState<Date | null>(null)
  const [login, setLogin] = React.useState<{ program: LoginProgram; profileId?: string } | null>(null)
  const [accounts, setAccounts] = React.useState<AgentAccount[] | null>(null)
  const [projectId, setProjectId] = React.useState<string>(projects[0]?.id ?? "")
  const [selected, setSelected] = React.useState<ListedId | null>(null)

  const load = React.useCallback(async (fresh: boolean) => {
    setRefreshing(true)
    try {
      const [providers, list] = await Promise.all([fetchProviders(fresh, workspaceId), fetchAccounts(workspaceId, fresh)])
      setData(providers)
      setAccounts(list)
      setLoadError(null)
      setCheckedAt(new Date())
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
    return <InlineError>{loadError}</InlineError>
  }

  const cards = data?.providers ?? null
  // The workspace's subscription has no Custom loop: that one is billed to an account's own key.
  const order: ListedId[] = workspaceId ? ["claude", "codex"] : ["claude", "codex", "native"]
  const defaultProvider = workspaceId ? null : (data?.defaultProvider ?? null)
  const listedDefault = order.find((id) => id === defaultProvider) ?? null
  const current: ListedId = selected ?? listedDefault ?? order[0]!
  const Heading = workspaceId ? "h2" : "h1"

  async function makeDefault(provider: ProviderId) {
    await saveDefaultProvider(provider === "native" ? null : provider)
    setData((was) => (was ? { ...was, defaultProvider: provider } : was))
  }

  return (
    <div className="flex flex-col gap-7">
      <section aria-labelledby="providers-heading" className="flex w-full flex-col gap-3">
        {/* A: header row */}
        <div className="flex items-center justify-between gap-3">
          <Heading id="providers-heading" className={cn("font-semibold", workspaceId ? "text-sm" : "text-lg")}>
            Providers
          </Heading>
          <Button
            variant="ghost"
            className="text-muted-foreground h-[30px] gap-1.5 px-2.5 text-xs"
            onClick={() => void load(true)}
            disabled={refreshing}
            title="Check every provider again"
          >
            <RefreshCwIcon className={cn("size-[13px]", refreshing && "animate-spin")} />
            {refreshing
              ? "Checking…"
              : checkedAt
                ? `Checked ${checkedAt.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`
                : "Check again"}
          </Button>
        </div>

        {data && !data.cliEnabled && (
          <p className="border-warning/40 bg-warning-soft text-warning flex gap-2 rounded-[10px] border px-4 py-3 text-sm">
            <AlertTriangleIcon className="mt-0.5 size-4 shrink-0" aria-hidden />
            <span>
              The Claude Code and Codex providers are disabled on this server. Until the container
              runtime lands they run the CLI on the host, so production needs{" "}
              <code className="font-mono">AGENT_ALLOW_HOST_SHELL=true</code>, the same flag the
              terminal needs.
            </span>
          </p>
        )}

        {/* B: default-provider card */}
        {!workspaceId && (
          <DefaultProviderCard
            value={data?.defaultProvider ?? "native"}
            cards={cards}
            order={order}
            onChoose={makeDefault}
          />
        )}

        {/* C: list and detail card */}
        <ProvidersCard
          cards={cards}
          order={order}
          current={current}
          defaultProvider={listedDefault}
          onSelect={setSelected}
          onMakeDefault={workspaceId || readOnly ? undefined : makeDefault}
          onRefresh={() => void load(true)}
          lines={{ claude: accountLine("claude", accounts), codex: accountLine("codex", accounts) }}
          footer={
            <SignInFooter projects={projects} projectId={projectId} onProjectChange={setProjectId} />
          }
          renderDetail={(id, compact) => {
            const card = cards?.[id] ?? null
            if (id === "native") return <NativeRows card={card} />
            const list = accounts?.filter((a) => a.provider === id) ?? null
            const props = {
              card,
              accounts: list,
              canLogin: projects.length > 0 && !readOnly,
              readOnly,
              workspaceId,
              compact,
              onChanged: () => void load(true),
            }
            return id === "claude" ? (
              <ClaudeRows {...props} onLogin={(account) => setLogin({ program: "claude-login", profileId: account.id })} />
            ) : (
              <CodexRows {...props} onLogin={(account) => setLogin({ program: "codex-login", profileId: account.id })} />
            )
          }}
        />
      </section>

      {projects.length > 0 && <MemoryCard projects={projects} workspaceId={workspaceId} readOnly={readOnly} />}

      {login?.program === "claude-login" && projectId && (
        <ClaudeLoginDialog
          projectId={projectId}
          credentialWorkspaceId={workspaceId}
          profileId={login.profileId}
          open
          onOpenChange={(open) => {
            if (!open) {
              setLogin(null)
              void load(true)
            }
          }}
          onSignedIn={() => void load(true)}
        />
      )}
      {login?.program === "codex-login" && projectId && (
        <LoginTerminalDialog
          projectId={projectId}
          credentialWorkspaceId={workspaceId}
          profileId={login.profileId}
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

function DefaultProviderCard({
  value,
  cards,
  order,
  onChoose,
}: {
  value: ProviderId
  cards: Record<ProviderId, ProviderCard> | null
  order: ListedId[]
  onChoose: (provider: ProviderId) => Promise<void>
}) {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function choose(provider: ProviderId) {
    setBusy(true)
    setError(null)
    try {
      await onChoose(provider)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="@container bg-card rounded-[10px] border">
      <SettingsRow
        first
        title={<label htmlFor="default-provider">New threads start on</label>}
        description="Used when the composer doesn't choose. A thread stays on the provider its first message ran under; switching means a new thread."
      >
        {/* Before the cards arrive the pick is a guess; a bar, not a wrong value. */}
        {!cards ? (
          <Skeleton className="h-8 w-[200px] @max-[480px]:w-full" />
        ) : (
          <div className="w-[200px] @max-[480px]:w-full">
            <NativeSelect id="default-provider" value={value} onChange={(id) => void choose(id as ProviderId)} disabled={busy}>
              {order.map((id) => (
                <option key={id} value={id}>
                  {PROVIDER_META[id].name}
                </option>
              ))}
              {!order.some((id) => id === value) && <option value={value}>{cards[value]?.label ?? value}</option>}
            </NativeSelect>
          </div>
        )}
      </SettingsRow>
      {error && <p className="text-destructive px-5 pb-4 text-sm">{error}</p>}
    </div>
  )
}

/**
 * One row of settings: the label and its line on the left, the control on
 * the right. Below 480px of card the control wraps under the text.
 */
function SettingsRow({
  title,
  description,
  children,
  first = false,
  align = "center",
  className,
}: {
  title: React.ReactNode
  description?: React.ReactNode
  children?: React.ReactNode
  first?: boolean
  /** `start` for a row whose text runs to several lines. */
  align?: "center" | "start"
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex justify-between gap-x-6 gap-y-2.5 px-5 py-4 @max-[480px]:flex-wrap",
        align === "center" ? "items-center" : "items-start",
        !first && "border-t",
        className,
      )}
    >
      <div className="min-w-0 flex-[0_1_auto]">
        <div className="text-sm font-medium">{title}</div>
        {description && <div className="text-muted-foreground mt-0.5 max-w-[420px] text-xs leading-relaxed">{description}</div>}
      </div>
      {children !== undefined && (
        <div className={cn("flex shrink-0 items-center justify-end @max-[480px]:justify-start", align === "start" && "pt-0.5")}>
          {children}
        </div>
      )}
    </div>
  )
}

function Tile({ id, size }: { id: ListedId; size: 30 | 32 }) {
  return (
    <span
      aria-hidden
      className={cn(
        "bg-muted text-foreground flex shrink-0 items-center justify-center rounded-lg border",
        size === 30 ? "size-[30px]" : "size-8",
      )}
    >
      {PROVIDER_META[id].tile}
    </span>
  )
}

function StatusBadge({ card }: { card: ProviderCard | null }) {
  if (!card) return <Skeleton className="h-5 w-16 rounded-full" />
  const status = providerStatus(card)
  return (
    <span
      className={cn(
        "inline-flex h-5 items-center gap-1.5 rounded-full border px-2 text-xs",
        status.tone === "ok" && "border-ucch-active/40 text-ucch-active",
        status.tone === "warn" && "border-warning/40 bg-warning-soft text-warning",
        status.tone === "muted" && "text-muted-foreground",
      )}
    >
      <span className={cn("size-1.5 rounded-full", DOT[status.tone])} aria-hidden />
      {status.badge}
    </span>
  )
}

function ProvidersCard({
  cards,
  order,
  current,
  defaultProvider,
  onSelect,
  onMakeDefault,
  onRefresh,
  footer,
  lines,
  renderDetail,
}: {
  cards: Record<ProviderId, ProviderCard> | null
  order: ListedId[]
  current: ListedId
  defaultProvider: ListedId | null
  onSelect: (id: ListedId) => void
  onMakeDefault?: (id: ListedId) => Promise<void>
  onRefresh: () => void
  footer: React.ReactNode
  lines?: Partial<Record<ListedId, string | null>>
  renderDetail: (id: ListedId, compact: boolean) => React.ReactNode
}) {
  const [ref, width] = useWidth<HTMLDivElement>()
  const compact = width !== null && width < 480
  const card = cards?.[current] ?? null

  return (
    <div ref={ref} className="@container bg-card flex flex-wrap overflow-hidden rounded-[10px] border">
      {/* Left: the list */}
      <div
        role="tablist"
        aria-orientation="vertical"
        aria-label="Providers"
        className="flex basis-full flex-col border-b @min-[700px]:max-w-[280px] @min-[700px]:flex-[1_1_250px] @min-[700px]:border-r @min-[700px]:border-b-0"
      >
        {order.map((id) => (
          <ListItem
            key={id}
            id={id}
            card={cards?.[id] ?? null}
            selected={id === current}
            isDefault={id === defaultProvider}
            line={lines?.[id]}
            onSelect={() => onSelect(id)}
          />
        ))}
        <div className="flex-1" />
        <div className="border-t px-[18px] py-3">{footer}</div>
      </div>

      {/* Right: the chosen provider */}
      <div role="tabpanel" aria-label={PROVIDER_META[current].name} className="flex min-w-0 flex-[999_1_420px] flex-col">
        <div className="flex items-center gap-3 px-5 py-[18px]">
          <Tile id={current} size={32} />
          <div className="min-w-0 flex-1">
            <div className="truncate text-base leading-5 font-semibold">{PROVIDER_META[current].name}</div>
            <div className="text-muted-foreground truncate text-[12.5px] leading-[18px]">{PROVIDER_META[current].subtitle}</div>
          </div>
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More for ${PROVIDER_META[current].name}`}
              className="text-muted-foreground hover:text-foreground hover:bg-muted aria-expanded:bg-muted grid size-[30px] shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <MoreHorizontalIcon className="size-4" />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              {onMakeDefault && (
                <DropdownMenuItem
                  disabled={current === defaultProvider || !card}
                  onClick={() => void onMakeDefault(current).catch(() => {})}
                >
                  <StarIcon />
                  {current === defaultProvider ? "Default for new threads" : "Make default"}
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={onRefresh}>
                <RefreshCwIcon />
                Check again
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
        {renderDetail(current, compact)}
      </div>
    </div>
  )
}

function ListItem({
  id,
  card,
  selected,
  isDefault,
  line,
  onSelect,
}: {
  id: ListedId
  card: ProviderCard | null
  /** What a ready provider's second line says, in place of how it is signed in. */
  line?: string | null
  selected: boolean
  isDefault: boolean
  onSelect: () => void
}) {
  const status = card ? providerStatus(card) : null
  const version = card?.version ? `v${card.version}` : id === "native" ? "built-in" : null
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={cn(
        "flex w-full items-center gap-3 border-b px-4 py-3.5 text-left transition-colors outline-none",
        "hover:bg-muted/50 focus-visible:bg-muted/60",
        // Inset, so the bar takes no room and nothing shifts when it moves.
        selected && "bg-muted/40 shadow-[inset_2px_0_0_var(--color-foreground)]",
      )}
    >
      <Tile id={id} size={30} />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex min-w-0 items-center gap-2">
          <span className="max-w-full shrink-0 truncate text-sm leading-5 font-medium">{PROVIDER_META[id].name}</span>
          {/* The version gives way before the name does. */}
          {version && <span className="text-muted-foreground min-w-0 truncate font-mono text-[11px]">{version}</span>}
        </span>
        <span className="flex min-w-0 items-center gap-1.5">
          {status ? (
            <>
              <span className={cn("size-1.5 shrink-0 rounded-full", DOT[status.tone])} aria-hidden />
              <span className="text-muted-foreground truncate text-xs leading-[18px]">
                {status.tone === "ok" ? (line ?? status.detail) : status.badge}
              </span>
            </>
          ) : (
            <Skeleton className="h-3 w-24" />
          )}
        </span>
      </span>
      {isDefault && (
        <span className="text-muted-foreground inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px]">
          Default
        </span>
      )}
    </button>
  )
}

/** The list's foot: where sign-in terminals open, which needs a project to publish on. */
function SignInFooter({
  projects,
  projectId,
  onProjectChange,
}: {
  projects: { id: string; name: string }[]
  projectId: string
  onProjectChange: (id: string) => void
}) {
  if (projects.length === 0) {
    return (
      <p className="text-muted-foreground text-xs leading-relaxed">
        Sign-in runs in a terminal. Create a project first to open one, or paste a token.
      </p>
    )
  }
  return (
    <div className="flex flex-col gap-2">
      <p className="text-muted-foreground text-xs leading-relaxed">
        Sign-in runs in a terminal on the server, through the CLI&apos;s own login.
      </p>
      {projects.length > 1 && (
        // Which project changes nothing about the login; a terminal just has to be published somewhere.
        <label className="text-muted-foreground flex min-w-0 items-center gap-2 text-xs">
          <span className="shrink-0">Open in</span>
          <select
            value={projectId}
            onChange={(e) => onProjectChange(e.target.value)}
            className="border-input bg-background h-7 min-w-0 flex-1 truncate rounded-md border px-2 text-xs"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        </label>
      )}
    </div>
  )
}

function StatusRow({ card }: { card: ProviderCard | null }) {
  return (
    <SettingsRow title="Status" description={card ? providerStatus(card).detail : <Skeleton className="mt-1 h-3 w-36" />}>
      <StatusBadge card={card} />
    </SettingsRow>
  )
}

function VersionRow({ card }: { card: ProviderCard | null }) {
  return (
    <SettingsRow
      title="CLI version"
      description={
        !card ? (
          <Skeleton className="mt-1 h-3 w-32" />
        ) : card.installed ? (
          "Detected on this server."
        ) : (
          <span className="font-mono">{card.error ?? "Not found on this server."}</span>
        )
      }
    >
      {card ? (
        <span className="text-muted-foreground font-mono text-xs">{card.version ? `v${card.version}` : "—"}</span>
      ) : (
        <Skeleton className="h-4 w-14" />
      )}
    </SettingsRow>
  )
}

function ModelsRow({ card, description }: { card: ProviderCard | null; description: string }) {
  const models = card?.models ?? []
  const shown = models.slice(0, 3).map((m) => m.name)
  return (
    <SettingsRow title="Models" description={description}>
      {!card ? (
        <Skeleton className="h-4 w-20" />
      ) : models.length === 0 ? (
        <span className="text-muted-foreground text-xs">{card.id === "native" ? "Full catalogue" : "None listed"}</span>
      ) : (
        <span
          className="text-muted-foreground block max-w-[220px] truncate text-xs"
          title={models.map((m) => m.name).join(", ")}
        >
          {shown.join(", ")}
          {models.length > shown.length ? ` +${models.length - shown.length}` : ""}
        </span>
      )}
    </SettingsRow>
  )
}

function WarningRows({ warnings }: { warnings: string[] }) {
  return warnings.map((warning) => (
    <SettingsRow
      key={warning}
      align="start"
      title={
        <span className="text-warning flex items-center gap-1.5">
          <AlertTriangleIcon className="size-3.5" aria-hidden />
          Warning
        </span>
      }
      description={warning}
    />
  ))
}

function AccountsHeading({ intro }: { intro?: React.ReactNode }) {
  return (
    <>
      <h3 className="px-5 pt-6 pb-1 text-sm font-semibold">Accounts</h3>
      {intro && <p className="text-muted-foreground max-w-[560px] px-5 pt-1 text-xs leading-relaxed">{intro}</p>}
    </>
  )
}

interface CliRowsProps {
  card: ProviderCard | null
  accounts: AgentAccount[] | null
  canLogin: boolean
  readOnly: boolean
  workspaceId: string | undefined
  compact: boolean
  onLogin: (account: AgentAccount) => void
  onChanged: () => void
}

function ClaudeRows({ card, accounts, canLogin, readOnly, workspaceId, compact, onLogin, onChanged }: CliRowsProps) {
  const usable = Boolean(card?.enabled && card.installed)
  return (
    <>
      <StatusRow card={card} />
      <VersionRow card={card} />
      <ModelsRow card={card} description="What the composer offers for Claude Code." />
      <WarningRows warnings={card?.warnings ?? []} />
      <AccountsHeading
        intro={
          <>
            You sign in through the CLI&apos;s own login, in a terminal here: the server never reads, stores or
            forwards the credential.
          </>
        }
      />
      <AccountsList
        provider="claude"
        accounts={accounts}
        workspaceId={workspaceId}
        readOnly={readOnly}
        canSignIn={usable && canLogin}
        compact={compact}
        onSignIn={onLogin}
        onChanged={onChanged}
      />
    </>
  )
}

function CodexRows({ card, accounts, canLogin, readOnly, workspaceId, compact, onLogin, onChanged }: CliRowsProps) {
  const [acknowledged, setAcknowledged] = React.useState(false)

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

  const usable = Boolean(card?.enabled && card.installed)
  // The first warning is the spec's own text; the rest are probe findings.
  const [advisory, ...findings] = card?.warnings ?? []

  return (
    <>
      <StatusRow card={card} />
      <VersionRow card={card} />
      <ModelsRow card={card} description="What the composer offers for Codex." />
      {advisory && (
        <SettingsRow
          align="start"
          title={
            <span className="text-warning flex items-center gap-1.5">
              <AlertTriangleIcon className="size-3.5" aria-hidden />
              Before you sign in
            </span>
          }
          description={
            <>
              {advisory} Signing in needs your word that this is your own machine and your own repositories.
            </>
          }
        >
          <label className="flex items-center gap-2 text-xs whitespace-nowrap">
            <input type="checkbox" checked={acknowledged} onChange={(e) => acknowledge(e.target.checked)} />
            I understand
          </label>
        </SettingsRow>
      )}
      <WarningRows warnings={findings} />
      <AccountsHeading />
      <AccountsList
        provider="codex"
        accounts={accounts}
        workspaceId={workspaceId}
        readOnly={readOnly}
        canSignIn={usable && canLogin && acknowledged}
        compact={compact}
        onSignIn={onLogin}
        onChanged={onChanged}
      />
    </>
  )
}

function NativeRows({ card }: { card: ProviderCard | null }) {
  return (
    <>
      <StatusRow card={card} />
      <ModelsRow card={card} description="Any model in the OpenRouter catalogue." />
      <SettingsRow
        title="Billing"
        description="Billed to your OpenRouter key; usage and cost are recorded per turn."
        className="mb-2"
      >
        <TransitionLink href="/setting/api" className={cn(buttonVariants({ variant: "outline" }), "h-[30px] px-3 text-xs")}>
          <KeyRoundIcon className="size-3.5" />
          API keys
        </TransitionLink>
      </SettingsRow>
    </>
  )
}

/**
 * One project's OMP memory (OMP OM7.3, solution §7.3): how much the bank
 * holds, and a Clear button. Counts only -- the memories themselves stay on
 * the server. The bank is the one the cards above pay for: yours, or with
 * `workspaceId` the workspace's dedicated subscription's.
 */
function MemoryCard({
  projects,
  workspaceId,
  readOnly,
}: {
  projects: { id: string; name: string }[]
  workspaceId?: string
  readOnly: boolean
}) {
  const [projectId, setProjectId] = React.useState(projects[0]!.id)
  const [stats, setStats] = React.useState<{ projectId: string; value: OmpMemoryStats } | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [confirming, setConfirming] = React.useState(false)
  const [clearing, setClearing] = React.useState(false)

  React.useEffect(() => {
    let live = true
    setError(null)
    setConfirming(false)
    fetchOmpMemory(projectId, workspaceId).then(
      (value) => live && setStats({ projectId, value }),
      (e: unknown) => live && setError(e instanceof Error ? e.message : "Could not read the memory."),
    )
    return () => {
      live = false
    }
  }, [projectId, workspaceId])

  async function clear() {
    setClearing(true)
    setError(null)
    try {
      await clearOmpMemory(projectId, workspaceId)
      setStats({ projectId, value: await fetchOmpMemory(projectId, workspaceId) })
      setConfirming(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not clear the memory.")
    } finally {
      setClearing(false)
    }
  }

  const current = stats?.projectId === projectId ? stats.value : null

  return (
    <section className="bg-card rounded-lg border p-4">
      <div className="flex flex-wrap items-center gap-2">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <BrainIcon className="text-muted-foreground size-4" />
          OMP memory
        </h2>
        {projects.length > 1 && (
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            aria-label="Project"
            className="border-input bg-background h-7 rounded-md border px-2 text-xs"
          >
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </select>
        )}
      </div>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        What Custom turns have kept about this project{workspaceId ? " on the workspace's subscription" : ""}: facts
        they retained, and summaries of past turns. Turned on under the workspace&apos;s Harness settings.
      </p>
      <p className="text-warning mt-2 max-w-prose text-sm">
        Do not ask an agent to remember secrets: memory is stored as plain text and recalled into later turns.
      </p>
      {!current && !error && <Skeleton className="mt-4 h-5 w-72" />}
      {current && (
        <p className="mt-4 text-sm">
          {current.exists ? (
            <>
              {current.facts} {current.facts === 1 ? "fact" : "facts"}, {current.episodes}{" "}
              {current.episodes === 1 ? "turn summary" : "turn summaries"}
              <span className="text-muted-foreground">
                {" "}
                · {formatBytes(current.bytes)}
                {current.lastAt ? ` · last added ${new Date(current.lastAt).toLocaleString()}` : ""}
              </span>
            </>
          ) : (
            <span className="text-muted-foreground">Nothing remembered yet.</span>
          )}
        </p>
      )}
      {current?.exists && !readOnly && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          {confirming ? (
            <>
              <span className="text-sm">Forget everything for this project?</span>
              <Button variant="destructive" size="sm" onClick={() => void clear()} disabled={clearing}>
                {clearing ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
                Clear memory
              </Button>
              <Button variant="outline" size="sm" onClick={() => setConfirming(false)} disabled={clearing}>
                Keep it
              </Button>
            </>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
              <TrashIcon />
              Clear…
            </Button>
          )}
        </div>
      )}
      {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
    </section>
  )
}
