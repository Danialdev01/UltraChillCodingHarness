"use client"

import * as React from "react"
import {
  BriefcaseIcon,
  CheckIcon,
  Loader2Icon,
  LogInIcon,
  LogOutIcon,
  MoreHorizontalIcon,
  PencilIcon,
  PlusIcon,
  TrashIcon,
  UserIcon,
  XIcon,
} from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  accountStatus,
  createAccount,
  deleteAccount,
  signOutAccount,
  updateAccount,
  type AccountContext,
  type AccountProvider,
  type AgentAccount,
} from "@/lib/providers-api"
import { cn } from "@/lib/utils"

/**
 * One provider's subscription accounts: "Work" and "Personal" logins side by
 * side, each signed in through the CLI's own flow in a terminal, in its own
 * folder on the server. The harness never reads what a login wrote; this
 * list shows the CLI's own status check, the label, the context tag and
 * the last limit it saw.
 *
 * Drawn as the providers panel's account box and the add-account row under
 * it. With `compact` (a narrow panel) "Sign in again" moves into the row's
 * ⋯ menu.
 *
 * Moving a session between two accounts of one provider is only ever done
 * by hand, from the session header or a limit card.
 */
export function AccountsList({
  provider,
  accounts,
  workspaceId,
  readOnly,
  canSignIn,
  compact = false,
  onSignIn,
  onChanged,
}: {
  provider: AccountProvider
  /** Null until the first fetch arrives. */
  accounts: AgentAccount[] | null
  workspaceId?: string
  readOnly: boolean
  /** False when no sign-in can start now (no project to host the terminal, not acknowledged, …). */
  canSignIn: boolean
  compact?: boolean
  onSignIn: (account: AgentAccount) => void
  onChanged: () => void
}) {
  const [adding, setAdding] = React.useState(false)

  if (!accounts) {
    return (
      <div className="mx-5 mt-3.5 mb-6 overflow-hidden rounded-lg border" aria-hidden>
        <div className="flex items-center gap-3 px-3.5 py-3">
          <Skeleton className="size-7 rounded-full" />
          <div className="flex flex-1 flex-col gap-1.5">
            <Skeleton className="h-3.5 w-32" />
            <Skeleton className="h-3 w-44" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <>
      {accounts.length > 0 && (
        <ul className="mx-5 mt-3.5 overflow-hidden rounded-lg border">
          {accounts.map((account) => (
            <AccountRow
              key={account.id}
              provider={provider}
              account={account}
              workspaceId={workspaceId}
              readOnly={readOnly}
              canSignIn={canSignIn}
              compact={compact}
              onSignIn={() => onSignIn(account)}
              onChanged={onChanged}
            />
          ))}
        </ul>
      )}
      <div className="px-5 pt-3 pb-6">
        {readOnly ? (
          accounts.length === 0 && <p className="text-muted-foreground text-xs">No accounts connected.</p>
        ) : adding ? (
          <NewAccountForm
            provider={provider}
            workspaceId={workspaceId}
            onDone={(created) => {
              setAdding(false)
              if (created) onChanged()
            }}
          />
        ) : (
          <p className="text-muted-foreground flex flex-wrap items-center gap-x-2 gap-y-1 text-xs">
            <Button variant="ghost" size="sm" className="text-foreground -ml-1 pl-1" onClick={() => setAdding(true)}>
              <PlusIcon />
              Connect another account
            </Button>
            <span>
              {accounts.length > 1
                ? "Each is its own subscription; the harness never moves a session between them by itself."
                : "Keep work and personal accounts apart."}
            </span>
          </p>
        )}
      </div>
    </>
  )
}

function AccountRow({
  provider,
  account,
  workspaceId,
  readOnly,
  canSignIn,
  compact,
  onSignIn,
  onChanged,
}: {
  provider: AccountProvider
  account: AgentAccount
  workspaceId?: string
  readOnly: boolean
  canSignIn: boolean
  compact: boolean
  onSignIn: () => void
  onChanged: () => void
}) {
  const [busy, setBusy] = React.useState<"signout" | "delete" | "context" | "rename" | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [renaming, setRenaming] = React.useState(false)
  const [label, setLabel] = React.useState(account.label)
  const [confirmDelete, setConfirmDelete] = React.useState(false)
  const status = accountStatus(account)

  async function act(kind: NonNullable<typeof busy>, run: () => Promise<void>) {
    setBusy(kind)
    setError(null)
    try {
      await run()
      onChanged()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(null)
    }
  }

  const otherContext: AccountContext = account.context === "work" ? "personal" : "work"
  const session = account.quota?.status === "ok" ? account.quota.windows?.find((w) => w.id === "session") : undefined
  const signInLabel = account.authenticated ? "Sign in again" : "Sign in"
  const ContextIcon = account.context === "work" ? BriefcaseIcon : UserIcon

  return (
    <li className="border-t px-3.5 py-3 first:border-t-0">
      <div className="flex items-center gap-3">
        <span
          aria-hidden
          className="bg-muted text-muted-foreground grid size-7 shrink-0 place-items-center rounded-full text-xs font-semibold uppercase"
        >
          {account.label.trim().charAt(0) || "?"}
        </span>

        <div className="min-w-0 flex-1">
          {renaming ? (
            <form
              className="flex items-center gap-1"
              onSubmit={(e) => {
                e.preventDefault()
                void act("rename", () => updateAccount(account.id, { label }, workspaceId)).then(() => setRenaming(false))
              }}
            >
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={40}
                aria-label="Account name"
                className="h-7 w-40 text-sm"
                autoFocus
              />
              <Button type="submit" size="icon-sm" variant="ghost" aria-label="Save name" disabled={busy !== null}>
                {busy === "rename" ? <Loader2Icon className="animate-spin" /> : <CheckIcon />}
              </Button>
              <Button
                type="button"
                size="icon-sm"
                variant="ghost"
                aria-label="Cancel"
                onClick={() => {
                  setRenaming(false)
                  setLabel(account.label)
                }}
              >
                <XIcon />
              </Button>
            </form>
          ) : (
            <div className="flex min-w-0 items-center gap-2">
              <span className="truncate text-sm font-medium">{account.label}</span>
              <span className="text-muted-foreground inline-flex h-5 shrink-0 items-center gap-1 rounded-full border px-2 text-[11px] capitalize">
                <ContextIcon className="size-3" aria-hidden />
                {account.context}
              </span>
              {account.authMode === "api-key" && account.authenticated && (
                <span className="border-warning/40 bg-warning-soft text-warning inline-flex h-5 shrink-0 items-center rounded-full border px-2 text-[11px]">
                  API key
                </span>
              )}
            </div>
          )}

          {provider === "codex" && session ? (
            <div className="mt-1.5 flex items-center gap-2">
              <span className="bg-muted relative h-1 w-24 shrink-0 overflow-hidden rounded-[2px]" aria-hidden>
                <span
                  className={cn(
                    "absolute inset-y-0 left-0 rounded-[2px]",
                    session.usedPercent >= 90 ? "bg-warning" : "bg-ucch-active",
                  )}
                  style={{ width: `${Math.min(100, Math.max(0, session.usedPercent))}%` }}
                />
              </span>
              <span className="text-muted-foreground truncate text-xs">
                {Math.round(session.usedPercent)}% of session used
              </span>
            </div>
          ) : (
            <p className="text-muted-foreground mt-0.5 truncate text-xs">
              {status.tone !== "ok" && (
                <span className={cn(status.tone === "warn" && "text-warning")}>
                  {status.label}
                  {account.account ? " · " : ""}
                </span>
              )}
              {account.account && <span className="font-mono">{account.account}</span>}
              {!account.account && status.tone === "ok" && status.label}
            </p>
          )}
        </div>

        {!readOnly && !compact && (
          <Button
            size="sm"
            variant={account.authenticated ? "outline" : "default"}
            className="shrink-0"
            onClick={onSignIn}
            disabled={!canSignIn || busy !== null}
          >
            <LogInIcon />
            {signInLabel}
          </Button>
        )}

        {!readOnly && (
          <DropdownMenu>
            <DropdownMenuTrigger
              aria-label={`More for ${account.label}`}
              disabled={busy !== null}
              className="text-muted-foreground hover:text-foreground hover:bg-muted aria-expanded:bg-muted grid size-[30px] shrink-0 place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
            >
              {busy !== null && busy !== "rename" ? (
                <Loader2Icon className="size-4 animate-spin" />
              ) : (
                <MoreHorizontalIcon className="size-4" />
              )}
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end" className="min-w-48">
              {compact && (
                <DropdownMenuItem disabled={!canSignIn} onClick={onSignIn}>
                  <LogInIcon />
                  {signInLabel}
                </DropdownMenuItem>
              )}
              {account.authenticated && (
                <DropdownMenuItem onClick={() => void act("signout", () => signOutAccount(account.id, workspaceId))}>
                  <LogOutIcon />
                  Sign out
                </DropdownMenuItem>
              )}
              <DropdownMenuItem onClick={() => setRenaming(true)}>
                <PencilIcon />
                Rename
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={() => void act("context", () => updateAccount(account.id, { context: otherContext }, workspaceId))}
              >
                {otherContext === "work" ? <BriefcaseIcon /> : <UserIcon />}
                Mark as {otherContext}
              </DropdownMenuItem>
              {!account.isDefault && (
                <>
                  <DropdownMenuSeparator />
                  <DropdownMenuItem variant="destructive" onClick={() => setConfirmDelete(true)}>
                    <TrashIcon />
                    Delete…
                  </DropdownMenuItem>
                </>
              )}
            </DropdownMenuContent>
          </DropdownMenu>
        )}
      </div>

      {error && <p className="text-destructive mt-2 pl-10 text-sm">{error}</p>}

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${account.label}?`}
        description="The account and the login it holds on the server are deleted. Sessions on it stay, but have to move to another account to keep going."
        confirmLabel="Delete account and its login"
        onConfirm={async () => {
          await deleteAccount(account.id, workspaceId)
          onChanged()
        }}
      />
    </li>
  )
}

function NewAccountForm({
  provider,
  workspaceId,
  onDone,
}: {
  provider: AccountProvider
  workspaceId?: string
  onDone: (created: boolean) => void
}) {
  const [label, setLabel] = React.useState("")
  const [context, setContext] = React.useState<AccountContext>("work")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      await createAccount({ provider, label, context }, workspaceId)
      onDone(true)
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught))
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={(e) => void submit(e)} className="flex flex-col gap-2 rounded-lg border border-dashed px-3.5 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          value={label}
          onChange={(e) => setLabel(e.target.value)}
          placeholder="Name, e.g. Work"
          maxLength={40}
          aria-label="New account name"
          className="h-8 w-48 text-sm"
          autoFocus
        />
        <select
          value={context}
          onChange={(e) => setContext(e.target.value as AccountContext)}
          aria-label="Context"
          className="border-input bg-background h-8 rounded-md border px-2 text-sm"
        >
          <option value="work">Work</option>
          <option value="personal">Personal</option>
        </select>
        <Button type="submit" size="sm" disabled={busy || !label.trim()}>
          {busy ? <Loader2Icon className="animate-spin" /> : <PlusIcon />}
          Add
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={() => onDone(false)} disabled={busy}>
          Cancel
        </Button>
      </div>
      <p className="text-muted-foreground text-xs">Added signed out; sign it in next, through the CLI&apos;s own login.</p>
      {error && <p className="text-destructive text-sm">{error}</p>}
    </form>
  )
}
