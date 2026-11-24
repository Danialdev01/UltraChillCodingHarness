"use client"

import * as React from "react"
import { GIT_PROVIDERS, GIT_PROVIDER_LABELS } from "@ucch/protocol/plain"
import type { GitProvider } from "@ucch/protocol"
import { CheckIcon, KeyRoundIcon, Loader2Icon, PencilIcon, PlusIcon, TrashIcon, XIcon } from "lucide-react"

import { GitProviderMark } from "@/components/git-provider-mark"
import { InlineError } from "@/components/layout/inline-error"
import { Button } from "@/components/ui/button"
import { PasswordInput } from "@/components/ui/password-input"
import { Skeleton } from "@/components/ui/skeleton"
import { fullDate, MASK, relativeWhen } from "@/lib/api-keys"
import {
  createGitAccount,
  fetchGitAccountSettings,
  MAX_NAME_LENGTH,
  removeGitAccount,
  updateGitAccount,
  type GitAccountMeta,
  type GitAccountsResponse,
} from "@/lib/git-accounts"
import { cn } from "@/lib/utils"

const linkClass = "text-primary underline underline-offset-2 hover:no-underline"
const code = (text: string) => <code className="font-mono">{text}</code>

const fieldClass = cn(
  "bg-background placeholder:text-muted-foreground h-8 min-w-0 rounded-md border px-2.5 text-base outline-none md:text-sm",
  "focus-visible:border-ring focus-visible:ring-ring focus-visible:ring-3 disabled:opacity-50",
)

interface ProviderInfo {
  description: string
  placeholder: string
  /** The server field, for a host that can be anybody's. */
  server?: { initial: string; placeholder: string }
  /** Where its tokens are made, under the server's own address. */
  tokensPath: string
  scopes: React.ReactNode
}

const INFO: Record<GitProvider, ProviderInfo> = {
  github: {
    description: "Repositories on github.com.",
    placeholder: "ghp_… or github_pat_…",
    tokensPath: "https://github.com/settings/tokens",
    scopes: (
      <>
        Classic tokens need the {code("repo")} scope. Fine-grained tokens need contents and metadata, with write access
        to push, and administration to create repositories.
      </>
    ),
  },
  gitlab: {
    description: "Projects on gitlab.com or your own GitLab server.",
    placeholder: "glpat-…",
    server: { initial: "https://gitlab.com", placeholder: "https://gitlab.com" },
    tokensPath: "/-/user_settings/personal_access_tokens",
    scopes: (
      <>
        It needs the {code("api")} and {code("write_repository")} scopes.
      </>
    ),
  },
  gitea: {
    description: "Repositories on your own Gitea server.",
    placeholder: "Access token",
    server: { initial: "", placeholder: "https://git.example.com" },
    tokensPath: "/user/settings/applications",
    scopes: (
      <>
        It needs read and write access to {code("repository")}, and to read {code("user")} and {code("organization")}.
        Creating repositories needs write access to {code("user")} or {code("organization")} too.
      </>
    ),
  },
}

const errorText = (e: unknown, fallback: string) => (e instanceof Error ? e.message : fallback)

/**
 * Settings -> Providers -> Git Provider.
 *
 * A card per host, each with any number of named accounts. Their repositories
 * are what New project offers, and their tokens are what clones, pulls and
 * pushes authenticate with. A token is never shown again once saved.
 */
export function GitProviderSettings() {
  const [data, setData] = React.useState<GitAccountsResponse | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      setData(await fetchGitAccountSettings())
      setLoadError(null)
    } catch (e) {
      setLoadError(errorText(e, "Could not load your git accounts."))
    }
  }, [])

  React.useEffect(() => {
    void load()
  }, [load])

  return (
    <section aria-labelledby="git-providers-heading" className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <h1 id="git-providers-heading" className="text-lg font-semibold">
          Git providers
        </h1>
        <p className="text-muted-foreground text-sm">
          Accounts New project imports from and creates repositories on. Tokens are encrypted at rest and used to clone,
          pull and push your projects.
        </p>
      </div>

      {data && !data.encryptionAvailable && (
        <InlineError tone="warning">
          {code("SECRET_KEY")} is not configured on the server, so tokens can&apos;t be stored. Generate one with{" "}
          {code("openssl rand -hex 32")}.
        </InlineError>
      )}

      {loadError && !data ? (
        <InlineError onRetry={() => void load()}>{loadError}</InlineError>
      ) : (
        GIT_PROVIDERS.map((provider) => (
          <ProviderCard key={provider} provider={provider} data={data} onChanged={() => void load()} />
        ))
      )}
    </section>
  )
}

function ProviderCard({
  provider,
  data,
  onChanged,
}: {
  provider: GitProvider
  data: GitAccountsResponse | null
  onChanged: () => void
}) {
  const [adding, setAdding] = React.useState(false)
  const label = GIT_PROVIDER_LABELS[provider]
  const accounts = data?.accounts.filter((a) => a.provider === provider) ?? []

  return (
    <section
      aria-labelledby={`git-${provider}-title`}
      className="bg-card text-card-foreground overflow-hidden rounded-lg border"
    >
      <div className="flex flex-wrap items-center gap-3 p-4">
        <span className="bg-background flex size-8 shrink-0 items-center justify-center rounded-md border">
          <GitProviderMark provider={provider} className="size-4" />
        </span>
        <div className="flex min-w-0 flex-[1_1_12rem] flex-col">
          <h2 id={`git-${provider}-title`} className="text-sm font-medium">
            {label}
          </h2>
          <p className="text-muted-foreground text-sm">{INFO[provider].description}</p>
        </div>
        {!adding && (
          <Button
            variant="outline"
            className="h-[30px] shrink-0 rounded-md px-3 text-xs"
            aria-label={`Add ${label} account`}
            onClick={() => setAdding(true)}
            disabled={!data?.encryptionAvailable}
          >
            <PlusIcon className="size-3.5" />
            Add account
          </Button>
        )}
      </div>

      {adding && data && (
        <AddAccountForm
          provider={provider}
          existing={data.accounts}
          onCancel={() => setAdding(false)}
          onSaved={() => {
            setAdding(false)
            onChanged()
          }}
        />
      )}

      {!data ? (
        <div className="border-t px-4 py-3" aria-hidden>
          <Skeleton className="h-3.5 w-48" />
        </div>
      ) : accounts.length > 0 ? (
        <ul>
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              account={account}
              others={data.accounts.filter((a) => a.id !== account.id)}
              encryptionAvailable={data.encryptionAvailable}
              onChanged={onChanged}
            />
          ))}
        </ul>
      ) : (
        !adding && (
          <p className="text-muted-foreground border-t px-4 py-3 text-xs">
            {provider === "github" && data.githubFromLogin
              ? "Until you add one, the token from signing in with GitHub is used, which covers the repos that sign-in can see."
              : "No accounts yet."}
          </p>
        )
      )}
    </section>
  )
}

function nameError(name: string, others: GitAccountMeta[]): string | null {
  const trimmed = name.trim()
  if (!trimmed) return "Give the account a name."
  if (others.some((a) => a.name.toLowerCase() === trimmed.toLowerCase())) {
    return `You already have a git account called "${trimmed}".`
  }
  return null
}

/** The provider's name, or the first numbered one that is free. */
function suggestName(provider: GitProvider, existing: GitAccountMeta[]): string {
  const label = GIT_PROVIDER_LABELS[provider]
  const taken = new Set(existing.map((a) => a.name.toLowerCase()))
  let name: string = label
  for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${label} ${n}`
  return name
}

function TokenInput({
  provider,
  value,
  onChange,
  disabled,
  autoFocus,
}: {
  provider: GitProvider
  value: string
  onChange: (value: string) => void
  disabled: boolean
  autoFocus?: boolean
}) {
  return (
    <PasswordInput
      bare
      revealLabel="token"
      aria-label={`${GIT_PROVIDER_LABELS[provider]} token`}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={INFO[provider].placeholder}
      autoComplete="off"
      spellCheck={false}
      autoCapitalize="none"
      autoCorrect="off"
      data-1p-ignore
      data-lpignore="true"
      autoFocus={autoFocus}
      disabled={disabled}
      className={cn(fieldClass, "w-full font-mono")}
    />
  )
}

function AddAccountForm({
  provider,
  existing,
  onCancel,
  onSaved,
}: {
  provider: GitProvider
  existing: GitAccountMeta[]
  onCancel: () => void
  onSaved: () => void
}) {
  const info = INFO[provider]
  const label = GIT_PROVIDER_LABELS[provider]
  const [name, setName] = React.useState(() => suggestName(provider, existing))
  const [server, setServer] = React.useState(info.server?.initial ?? "")
  const [token, setToken] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  const address = server.trim().replace(/\/+$/, "")
  const isUrl = /^https?:\/\/[^\s/]+/i.test(address)
  const tokensUrl = info.server ? (isUrl ? `${address}${info.tokensPath}` : null) : info.tokensPath

  async function save(event: React.FormEvent) {
    event.preventDefault()
    if (busy) return
    const problem =
      nameError(name, existing) ??
      (info.server && !isUrl ? "Enter the server URL, starting with https://." : null) ??
      (token.trim() ? null : "Paste a token.")
    if (problem) {
      setError(problem)
      return
    }
    setBusy(true)
    setError(null)
    try {
      await createGitAccount({
        provider,
        name: name.trim(),
        token: token.trim(),
        ...(info.server ? { baseUrl: address } : {}),
      })
      onSaved()
    } catch (e) {
      setError(errorText(e, "Could not save the account."))
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="flex flex-col gap-3 border-t p-4" aria-busy={busy}>
      <div className={cn("grid gap-3", info.server && "sm:grid-cols-2")}>
        <label className="flex min-w-0 flex-col gap-1.5">
          <span className="text-text-subtle text-xs font-medium">Name</span>
          <input
            autoFocus
            value={name}
            onChange={(e) => {
              setName(e.target.value)
              setError(null)
            }}
            maxLength={MAX_NAME_LENGTH}
            disabled={busy}
            className={fieldClass}
          />
        </label>
        {info.server && (
          <label className="flex min-w-0 flex-col gap-1.5">
            <span className="text-text-subtle text-xs font-medium">Server URL</span>
            <input
              value={server}
              onChange={(e) => {
                setServer(e.target.value)
                setError(null)
              }}
              placeholder={info.server.placeholder}
              inputMode="url"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={300}
              disabled={busy}
              className={cn(fieldClass, "font-mono")}
            />
          </label>
        )}
      </div>
      {/^http:/i.test(address) && (
        <InlineError tone="warning">
          The token will be sent unencrypted. http:// works only for a server on this machine or a private network.
        </InlineError>
      )}
      <div className="flex flex-col gap-1.5">
        <span className="text-text-subtle text-xs font-medium">Access token</span>
        <TokenInput
          provider={provider}
          value={token}
          onChange={(value) => {
            setToken(value)
            setError(null)
          }}
          disabled={busy}
        />
      </div>
      {error && (
        <p role="alert" className="text-destructive text-sm">
          {error}
        </p>
      )}
      <p className="text-muted-foreground text-xs leading-relaxed">
        {info.scopes}{" "}
        {tokensUrl && (
          <>
            Create one at{" "}
            <a href={tokensUrl} target="_blank" rel="noopener noreferrer" className={cn(linkClass, "break-all")}>
              {tokensUrl.replace(/^https?:\/\//, "")}
            </a>
            .{" "}
          </>
        )}
        The token is checked with {label} before it is saved, and is never shown again.
      </p>
      <div className="flex gap-2">
        <Button type="submit" className="rounded-md" disabled={busy}>
          {busy && <Loader2Icon className="animate-spin" />}
          {busy ? "Checking…" : "Save account"}
        </Button>
        <Button type="button" variant="outline" className="rounded-md" onClick={onCancel} disabled={busy}>
          Cancel
        </Button>
      </div>
    </form>
  )
}

function AccountRow({
  account,
  others,
  encryptionAvailable,
  onChanged,
}: {
  account: GitAccountMeta
  others: GitAccountMeta[]
  encryptionAvailable: boolean
  onChanged: () => void
}) {
  const [mode, setMode] = React.useState<"view" | "rename" | "token" | "remove">("view")
  const [draft, setDraft] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  function enter(next: typeof mode, value = "") {
    setMode(next)
    setDraft(value)
    setError(null)
  }

  async function run(work: () => Promise<unknown>, fallback: string) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await work()
      enter("view")
      onChanged()
    } catch (e) {
      setError(errorText(e, fallback))
    } finally {
      setBusy(false)
    }
  }

  function submit(event: React.FormEvent) {
    event.preventDefault()
    const value = draft.trim()
    if (mode === "rename" && value === account.name) return enter("view")
    const problem = mode === "rename" ? nameError(value, others) : value ? null : "Paste a token."
    if (problem) return setError(problem)
    void run(
      () => updateGitAccount(account.id, mode === "rename" ? { name: value } : { token: value }),
      "Could not save it.",
    )
  }

  const editing = mode === "rename" || mode === "token"

  return (
    <li className="flex flex-col gap-2 border-t px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <div className="flex min-w-0 flex-[1_1_14rem] flex-col gap-0.5">
          {editing ? (
            <form
              onSubmit={submit}
              className="flex items-center gap-1.5"
              onKeyDown={(e) => {
                if (e.key === "Escape" && !busy) enter("view")
              }}
            >
              <div className="min-w-0 flex-1">
                {mode === "rename" ? (
                  <input
                    autoFocus
                    aria-label="Account name"
                    value={draft}
                    maxLength={MAX_NAME_LENGTH}
                    onChange={(e) => setDraft(e.target.value)}
                    disabled={busy}
                    className={cn(fieldClass, "w-full")}
                  />
                ) : (
                  <TokenInput provider={account.provider} value={draft} onChange={setDraft} disabled={busy} autoFocus />
                )}
              </div>
              <Button type="submit" size="icon" variant="ghost" className="size-7" aria-label="Save" disabled={busy}>
                {busy ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Cancel"
                onClick={() => enter("view")}
                disabled={busy}
              >
                <XIcon />
              </Button>
            </form>
          ) : (
            <span className="flex min-w-0 items-baseline gap-2">
              <span className="truncate text-sm font-medium">{account.name}</span>
              {account.login && <span className="text-muted-foreground truncate text-xs">{account.login}</span>}
            </span>
          )}
          <span className="text-muted-foreground flex min-w-0 flex-wrap items-center gap-x-2 text-xs">
            <span className="font-mono" aria-label={`Token ending ${account.last4}`}>
              {account.prefix}
              <span aria-hidden>{MASK.slice(0, 8)}</span>
              {account.last4}
            </span>
            {account.provider !== "github" && (
              <span className="min-w-0 truncate font-mono">{account.baseUrl.replace(/^https:\/\//, "")}</span>
            )}
            {account.scopes && <span className="min-w-0 truncate">{account.scopes}</span>}
            <span title={fullDate(account.lastUsedAt)}>
              {account.lastUsedAt ? `Used ${relativeWhen(account.lastUsedAt, Date.now()).toLowerCase()}` : "Not used yet"}
            </span>
          </span>
        </div>

        {mode === "remove" ? (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="text-xs">Remove?</span>
            <Button
              variant="destructive"
              className="h-7 rounded-md px-2.5 text-xs"
              onClick={() => void run(() => removeGitAccount(account.id), "Could not remove the account.")}
              disabled={busy}
            >
              {busy ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
              Remove
            </Button>
            <Button
              variant="outline"
              className="h-7 rounded-md px-2.5 text-xs"
              onClick={() => enter("view")}
              disabled={busy}
            >
              Keep
            </Button>
          </div>
        ) : (
          !editing && (
            <div className="ml-auto flex items-center gap-1.5">
              <Button
                variant="ghost"
                className="text-muted-foreground h-7 rounded-md px-2 text-xs"
                onClick={() => enter("token")}
                disabled={!encryptionAvailable}
              >
                <KeyRoundIcon />
                Replace token
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                aria-label={`Rename ${account.name}`}
                onClick={() => enter("rename", account.name)}
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                className="text-muted-foreground hover:text-destructive size-7"
                aria-label={`Remove ${account.name}`}
                onClick={() => enter("remove")}
              >
                <TrashIcon />
              </Button>
            </div>
          )
        )}
      </div>
      {mode === "remove" && (
        <p className="text-muted-foreground text-xs">
          Projects cloned with it keep their files, but private ones can&apos;t pull or push without another account on
          that server.
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
