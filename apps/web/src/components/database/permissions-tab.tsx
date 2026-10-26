"use client"

import * as React from "react"
import { KeyRoundIcon, Loader2Icon, MoreHorizontalIcon, PlusIcon, RefreshCwIcon, ShieldMinusIcon, Trash2Icon } from "lucide-react"
import { CreateUserBody } from "@ucch/protocol/database"
import { privilegesFor } from "@ucch/protocol/plain"
import type { DbUser } from "@ucch/protocol"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { Flag } from "@/components/database/column-form"
import { errorText, useDb, type Listing } from "@/components/database/db-context"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table"
import { createUser, dropUser, fetchUsers, grantPrivileges, revokePrivileges } from "@/lib/database-api"

/**
 * Who can get at this database and what they may do: MySQL accounts
 * (`user@host`) or PostgreSQL roles, with the privileges each holds here.
 * Grants and revokes are on the open database as a whole, the way
 * phpMyAdmin's database-level Privileges tab does them.
 */
export function PermissionsTab() {
  const { ref, engine, db } = useDb()
  const [users, setUsers] = React.useState<Listing<DbUser[]>>({ state: "loading" })
  const [creating, setCreating] = React.useState(false)
  const [granting, setGranting] = React.useState<{ user: DbUser; action: "grant" | "revoke" } | null>(null)
  const [dropping, setDropping] = React.useState<DbUser | null>(null)
  const [force, setForce] = React.useState(false)

  const load = React.useCallback(async () => {
    try {
      setUsers({ state: "loaded", data: await fetchUsers(ref) })
    } catch (error) {
      setUsers({ state: "failed", error: errorText(error, "Could not list the users.") })
    }
  }, [ref])

  React.useEffect(() => {
    setUsers({ state: "loading" })
    void load()
  }, [load])

  const label = (user: DbUser) => (user.host ? `${user.name}@${user.host}` : user.name)

  return (
    <div className="flex flex-col gap-3 p-4">
      <div className="flex items-center gap-2">
        <h2 className="text-sm font-medium">{engine === "mysql" ? "Accounts" : "Roles"}</h2>
        {users.state === "loaded" && <span className="text-muted-foreground text-xs">{users.data.length}</span>}
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="icon-sm" onClick={() => void load()} title="Refresh">
            <RefreshCwIcon />
            <span className="sr-only">Refresh</span>
          </Button>
          <Button size="sm" onClick={() => setCreating(true)}>
            <PlusIcon />
            Add {engine === "mysql" ? "account" : "role"}
          </Button>
        </div>
      </div>

      {users.state === "loading" ? (
        <div className="rounded-lg border">
          {Array.from({ length: 4 }, (_, i) => (
            <div key={i} className="flex items-center gap-4 border-b px-3 py-2.5 last:border-b-0">
              <Skeleton className="h-3 w-32" />
              <Skeleton className="h-3 w-48" />
            </div>
          ))}
        </div>
      ) : users.state === "failed" ? (
        <p role="alert" className="text-destructive text-sm">
          {users.error}
        </p>
      ) : (
        <div className="rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{engine === "mysql" ? "Account" : "Role"}</TableHead>
                <TableHead>On {db}</TableHead>
                <TableHead>{engine === "mysql" ? "Global" : "Flags"}</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {users.data.map((user) => (
                <TableRow key={label(user)}>
                  <TableCell className="font-mono text-xs font-medium">{label(user)}</TableCell>
                  <TableCell>
                    <Chips items={user.privileges} empty="none" />
                  </TableCell>
                  <TableCell>
                    <Chips
                      items={
                        engine === "mysql"
                          ? user.global
                          : Object.entries(user.flags)
                              .filter(([, on]) => on)
                              .map(([flag]) => flag)
                      }
                      empty="—"
                    />
                  </TableCell>
                  <TableCell className="py-1">
                    <DropdownMenu>
                      <DropdownMenuTrigger render={<Button variant="ghost" size="icon-xs" />}>
                        <MoreHorizontalIcon />
                        <span className="sr-only">More for {label(user)}</span>
                      </DropdownMenuTrigger>
                      <DropdownMenuContent className="w-44" align="end">
                        <DropdownMenuItem onClick={() => setGranting({ user, action: "grant" })}>
                          <KeyRoundIcon className="text-muted-foreground" />
                          Grant…
                        </DropdownMenuItem>
                        <DropdownMenuItem onClick={() => setGranting({ user, action: "revoke" })}>
                          <ShieldMinusIcon className="text-muted-foreground" />
                          Revoke…
                        </DropdownMenuItem>
                        <DropdownMenuSeparator />
                        <DropdownMenuItem
                          variant="destructive"
                          onClick={() => {
                            setForce(false)
                            setDropping(user)
                          }}
                        >
                          <Trash2Icon />
                          Drop
                        </DropdownMenuItem>
                      </DropdownMenuContent>
                    </DropdownMenu>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <CreateUserDialog open={creating} onOpenChange={setCreating} onCreated={load} />
      {granting && (
        <GrantDialog
          user={granting.user}
          action={granting.action}
          open
          onOpenChange={(open) => !open && setGranting(null)}
          onDone={load}
        />
      )}
      <ConfirmDialog
        open={dropping !== null}
        onOpenChange={(open) => !open && setDropping(null)}
        title={`Drop ${dropping ? label(dropping) : ""}?`}
        description={engine === "mysql" ? "The account can no longer log in to this server." : "The role is removed from the server."}
        confirmLabel="Drop"
        onConfirm={async () => {
          if (!dropping) return
          await dropUser(ref, dropping.name, { host: dropping.host ?? undefined, force })
          await load()
        }}
      >
        {engine === "postgresql" && (
          <Flag id="drop-force" label="Also drop what it owns and reassign its grants" checked={force} onChange={setForce} className="text-sm" />
        )}
      </ConfirmDialog>
    </div>
  )
}

function Chips({ items, empty }: { items: string[]; empty: string }) {
  if (items.length === 0) return <span className="text-muted-foreground text-xs">{empty}</span>
  return (
    <span className="flex flex-wrap gap-1">
      {items.map((item) => (
        <span key={item} className="bg-muted rounded px-1.5 py-0.5 font-mono text-[11px] whitespace-nowrap">
          {item}
        </span>
      ))}
    </span>
  )
}

function CreateUserDialog({ open, onOpenChange, onCreated }: { open: boolean; onOpenChange: (open: boolean) => void; onCreated: () => Promise<void> }) {
  const { ref, engine } = useDb()
  const [name, setName] = React.useState("")
  const [host, setHost] = React.useState("%")
  const [password, setPassword] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!open) return
    setName("")
    setHost("%")
    setPassword("")
    setPending(false)
    setError(null)
  }, [open])

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    const parsed = CreateUserBody.safeParse({ name: name.trim(), password, ...(engine === "mysql" ? { host: host.trim() } : {}) })
    if (!parsed.success) {
      const issue = parsed.error.issues[0]!
      return setError(`${issue.path.join(".") || "user"}: ${issue.message}`)
    }
    setPending(true)
    setError(null)
    try {
      await createUser(ref, parsed.data)
      await onCreated()
      onOpenChange(false)
    } catch (caught) {
      setError(errorText(caught))
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-sm">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>New {engine === "mysql" ? "account" : "role"}</DialogTitle>
            <DialogDescription>Created with no privileges; grant some from its row afterwards.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-4">
            <Field>
              <FieldLabel htmlFor="user-name">Name</FieldLabel>
              <Input id="user-name" value={name} onChange={(e) => setName(e.target.value)} autoComplete="off" spellCheck={false} autoFocus disabled={pending} className="font-mono text-sm" />
            </Field>
            {engine === "mysql" && (
              <Field>
                <FieldLabel htmlFor="user-host">Host</FieldLabel>
                <Input id="user-host" value={host} onChange={(e) => setHost(e.target.value)} autoComplete="off" spellCheck={false} disabled={pending} className="font-mono text-sm" />
              </Field>
            )}
            <Field>
              <FieldLabel htmlFor="user-password">Password</FieldLabel>
              <Input id="user-password" type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" disabled={pending} />
            </Field>
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
              Cancel
            </DialogClose>
            <Button type="submit" disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}

function GrantDialog({
  user,
  action,
  open,
  onOpenChange,
  onDone,
}: {
  user: DbUser
  action: "grant" | "revoke"
  open: boolean
  onOpenChange: (open: boolean) => void
  onDone: () => Promise<void>
}) {
  const { ref, engine, db } = useDb()
  const options = privilegesFor(engine)
  const [chosen, setChosen] = React.useState<Set<string>>(() => new Set(action === "revoke" ? user.privileges.filter((p) => options.includes(p)) : []))
  const [connect, setConnect] = React.useState(false)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (chosen.size === 0) return setError("pick at least one privilege")
    setPending(true)
    setError(null)
    try {
      const body = { host: user.host ?? undefined, privileges: [...chosen], ...(action === "revoke" && engine === "postgresql" ? { connect } : {}) }
      await (action === "grant" ? grantPrivileges : revokePrivileges)(ref, user.name, body)
      await onDone()
      onOpenChange(false)
    } catch (caught) {
      setError(errorText(caught))
      setPending(false)
    }
  }

  const who = user.host ? `${user.name}@${user.host}` : user.name

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-md">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {action === "grant" ? "Grant to" : "Revoke from"} {who}
            </DialogTitle>
            <DialogDescription>On {db}{engine === "postgresql" ? "'s public tables" : ""}.</DialogDescription>
          </DialogHeader>
          <div className="flex flex-col gap-3 py-4">
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 text-sm">
              {options.map((privilege) => (
                <Flag
                  key={privilege}
                  id={`priv-${privilege.replace(/\s/g, "-")}`}
                  label={<span className="font-mono text-xs">{privilege}</span>}
                  checked={chosen.has(privilege)}
                  disabled={pending}
                  onChange={(on) => {
                    const next = new Set(chosen)
                    if (on) next.add(privilege)
                    else next.delete(privilege)
                    setChosen(next)
                  }}
                />
              ))}
            </div>
            {action === "revoke" && engine === "postgresql" && (
              <Flag id="priv-connect" label="Also revoke CONNECT on the database" checked={connect} disabled={pending} onChange={setConnect} className="text-sm" />
            )}
            {error && (
              <p role="alert" className="text-destructive text-sm">
                {error}
              </p>
            )}
          </div>
          <DialogFooter>
            <DialogClose render={<Button type="button" variant="outline" disabled={pending} />}>
              Cancel
            </DialogClose>
            <Button type="submit" variant={action === "revoke" ? "destructive" : "default"} disabled={pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              {action === "grant" ? "Grant" : "Revoke"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
