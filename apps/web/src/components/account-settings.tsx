"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import {
  CheckIcon,
  KeyRoundIcon,
  Loader2Icon,
  MailIcon,
  TrashIcon,
  UserRoundIcon,
} from "lucide-react"

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import {
  fetchAccount,
  updateAvatar,
  updateEmail,
  updateName,
  updatePassword,
  type Account,
} from "@/lib/account-api"
import { fileToAvatar } from "@/lib/avatar-image"

/**
 * The account tab: who you are, how you sign in, and what you look like.
 *
 * Four independent forms rather than one. Each edits a different thing,
 * each fails for different reasons, and each is finished at a different
 * moment -- one Save across all three would report "saved" while the email
 * was refused, or block a picture on an unrelated password mistake.
 */
export function AccountSettings() {
  const router = useRouter()
  const [account, setAccount] = React.useState<Account | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    fetchAccount()
      .then(setAccount)
      .catch((e: unknown) => setLoadError(e instanceof Error ? e.message : String(e)))
  }, [])
  React.useEffect(() => load(), [load])

  /** The sidebar renders the same profile, so it has to be told too. */
  const refresh = React.useCallback(() => {
    load()
    router.refresh()
  }, [load, router])

  if (loadError) {
    return (
      <section className="rounded-lg border p-6">
        <p className="text-destructive text-sm">{loadError}</p>
      </section>
    )
  }
  if (!account) {
    return (
      <section className="text-muted-foreground flex items-center gap-2 rounded-lg border p-6 text-sm">
        <Loader2Icon className="size-4 animate-spin" />
        Loading your account…
      </section>
    )
  }

  return (
    <>
      <ProfilePicture account={account} onSaved={refresh} />
      <UsernameSection account={account} onSaved={refresh} />
      <EmailSection account={account} onSaved={refresh} />
      <PasswordSection account={account} onSaved={refresh} />
    </>
  )
}

/** A section's transient outcome: what went wrong, or that it worked. */
function useOutcome() {
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState<string | null>(null)

  // The confirmation clears itself; an error stays until the next attempt,
  // because it is the thing the reader has to act on.
  React.useEffect(() => {
    if (!done) return
    const timer = setTimeout(() => setDone(null), 4000)
    return () => clearTimeout(timer)
  }, [done])

  const run = React.useCallback(async (work: () => Promise<string>) => {
    setBusy(true)
    setError(null)
    setDone(null)
    try {
      setDone(await work())
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return false
    } finally {
      setBusy(false)
    }
  }, [])

  return { busy, error, done, run }
}

function Outcome({ error, done }: { error: string | null; done: string | null }) {
  if (!error && !done) return null
  return (
    <p className={`mt-3 flex items-center gap-1.5 text-sm ${error ? "text-destructive" : "text-ucch-active"}`}>
      {!error && <CheckIcon className="size-4 shrink-0" />}
      {error ?? done}
    </p>
  )
}

function initials(account: Account): string {
  const source = account.name || account.login || account.email || "?"
  return source
    .split(/[\s@._-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]!.toUpperCase())
    .join("")
}

function ProfilePicture({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const { busy, error, done, run } = useOutcome()
  const picker = React.useRef<HTMLInputElement>(null)

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <UserRoundIcon className="text-muted-foreground size-4" />
        Profile picture
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Shown beside your name in the sidebar. Cropped to a square and shrunk to{" "}
        {256}px before it is saved, so a photograph straight from a phone is fine.
      </p>

      <div className="mt-4 flex flex-wrap items-center gap-4">
        <Avatar className="size-16">
          <AvatarImage src={account.avatarUrl ?? undefined} alt="" />
          <AvatarFallback className="text-lg">{initials(account)}</AvatarFallback>
        </Avatar>

        <div className="flex flex-wrap gap-2">
          <input
            ref={picker}
            type="file"
            accept="image/png,image/jpeg,image/webp,image/gif,image/avif"
            className="hidden"
            onChange={(event) => {
              const file = event.target.files?.[0]
              // Cleared straight away so choosing the same file twice still
              // fires `change`.
              event.target.value = ""
              if (!file) return
              void run(async () => {
                await updateAvatar(await fileToAvatar(file))
                onSaved()
                return "Picture updated."
              })
            }}
          />
          <Button variant="outline" onClick={() => picker.current?.click()} disabled={busy}>
            {busy && <Loader2Icon className="animate-spin" />}
            {account.avatarUrl ? "Replace" : "Upload"}
          </Button>

          {account.avatarUrl && (
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  await updateAvatar(null)
                  onSaved()
                  return "Picture removed."
                })
              }
            >
              <TrashIcon />
              Remove
            </Button>
          )}
        </div>
      </div>

      <Outcome error={error} done={done} />
    </section>
  )
}

function UsernameSection({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const { busy, error, done, run } = useOutcome()
  const [name, setName] = React.useState(account.name ?? "")

  // Resynced when the account is reloaded, so a save elsewhere -- or the
  // reload after this one -- is reflected rather than sitting behind a
  // stale draft.
  React.useEffect(() => setName(account.name ?? ""), [account.name])
  const changed = name.trim() !== (account.name ?? "")

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <UserRoundIcon className="text-muted-foreground size-4" />
        Username
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        What you are called in the sidebar and on anything you own. It is not
        how you sign in, so changing it costs nothing and needs no password.
      </p>

      <form
        className="mt-4 flex max-w-xl flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            const stored = await updateName(name.trim())
            onSaved()
            return stored ? "Username updated." : "Username cleared."
          })
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="account-name">Username</Label>
          <Input
            id="account-name"
            value={name}
            onChange={(event) => setName(event.target.value)}
            autoComplete="nickname"
            maxLength={80}
            // The sign-in identifier, which this is not -- shown so an empty
            // field reads as "you will be called this" rather than as a gap.
            placeholder={account.login ?? "Your name"}
            disabled={busy}
          />
          {!name.trim() && (
            <p className="text-muted-foreground text-xs">
              Left empty, you are shown as {account.login ?? "your account id"}.
            </p>
          )}
        </div>

        <div>
          <Button type="submit" disabled={busy || !changed}>
            {busy && <Loader2Icon className="animate-spin" />}
            Save username
          </Button>
        </div>
      </form>

      <Outcome error={error} done={done} />
    </section>
  )
}

function EmailSection({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const { busy, error, done, run } = useOutcome()
  const [email, setEmail] = React.useState(account.email ?? "")
  const [password, setPassword] = React.useState("")

  React.useEffect(() => setEmail(account.email ?? ""), [account.email])
  const changed = email.trim() !== (account.email ?? "")

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <MailIcon className="text-muted-foreground size-4" />
        Email
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        {account.hasPassword
          ? "The address you sign in with. Changing it needs your current password."
          : "Your address. This account signs in through GitHub, so no password is needed to change it."}
      </p>

      <form
        className="mt-4 flex max-w-xl flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            await updateEmail(email.trim(), password || null)
            setPassword("")
            onSaved()
            return "Email updated."
          })
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="account-email">Email address</Label>
          <Input
            id="account-email"
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            autoComplete="email"
            placeholder="you@example.com"
            disabled={busy}
          />
        </div>

        {account.hasPassword && (
          <div className="grid gap-1.5">
            <Label htmlFor="account-email-password">Current password</Label>
            <Input
              id="account-email-password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
          </div>
        )}

        <div>
          <Button
            type="submit"
            disabled={busy || !changed || !email.trim() || (account.hasPassword && !password)}
          >
            {busy && <Loader2Icon className="animate-spin" />}
            Change email
          </Button>
        </div>
      </form>

      <Outcome error={error} done={done} />
    </section>
  )
}

function PasswordSection({ account, onSaved }: { account: Account; onSaved: () => void }) {
  const { busy, error, done, run } = useOutcome()
  const [current, setCurrent] = React.useState("")
  const [next, setNext] = React.useState("")
  const [confirm, setConfirm] = React.useState("")

  // Checked here as well as on the server so the mistake is caught before a
  // round trip -- and it is the one mistake the server cannot catch, since
  // it is only ever sent one of the two.
  const mismatch = confirm.length > 0 && next !== confirm
  const tooShort = next.length > 0 && next.length < 8

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <KeyRoundIcon className="text-muted-foreground size-4" />
        {account.hasPassword ? "Password" : "Set a password"}
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        {account.hasPassword
          ? "Changing your password signs out every other device. This one stays signed in."
          : "This account signs in through GitHub. Setting a password adds a second way in; it does not remove the first."}
      </p>

      <form
        className="mt-4 flex max-w-xl flex-col gap-3"
        onSubmit={(event) => {
          event.preventDefault()
          void run(async () => {
            await updatePassword(current || null, next)
            setCurrent("")
            setNext("")
            setConfirm("")
            onSaved()
            return account.hasPassword
              ? "Password changed. Other devices have been signed out."
              : "Password set."
          })
        }}
      >
        {account.hasPassword && (
          <div className="grid gap-1.5">
            <Label htmlFor="account-current-password">Current password</Label>
            <Input
              id="account-current-password"
              type="password"
              value={current}
              onChange={(event) => setCurrent(event.target.value)}
              autoComplete="current-password"
              disabled={busy}
            />
          </div>
        )}

        <div className="grid gap-1.5">
          <Label htmlFor="account-new-password">New password</Label>
          <Input
            id="account-new-password"
            type="password"
            value={next}
            onChange={(event) => setNext(event.target.value)}
            autoComplete="new-password"
            aria-invalid={tooShort}
            disabled={busy}
          />
          <p className="text-muted-foreground text-xs">
            At least 8 characters. Length is the only rule: a passphrase beats a short password
            with punctuation in it.
          </p>
        </div>

        <div className="grid gap-1.5">
          <Label htmlFor="account-confirm-password">Repeat new password</Label>
          <Input
            id="account-confirm-password"
            type="password"
            value={confirm}
            onChange={(event) => setConfirm(event.target.value)}
            autoComplete="new-password"
            aria-invalid={mismatch}
            disabled={busy}
          />
          {mismatch && <p className="text-destructive text-xs">These two do not match.</p>}
        </div>

        <div>
          <Button
            type="submit"
            disabled={
              busy ||
              next.length < 8 ||
              next !== confirm ||
              (account.hasPassword && !current)
            }
          >
            {busy && <Loader2Icon className="animate-spin" />}
            {account.hasPassword ? "Change password" : "Set password"}
          </Button>
        </div>
      </form>

      <Outcome error={error} done={done} />
    </section>
  )
}
