"use client"

import * as React from "react"
import { Loader2Icon } from "lucide-react"
import {
  DATABASE_ENGINE_LABELS,
  DEFAULT_DB_PORTS,
  DatabaseEngine,
  type DatabaseConnectionSummary,
  type DatabaseConnectionUpdate,
} from "@ucch/protocol"

import { errorText } from "@/components/database/db-context"
import { Button } from "@/components/ui/button"
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Field, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { updateConnection } from "@/lib/database-api"
import { cn } from "@/lib/utils"
import { useTransitionRouter } from "@/lib/view-transitions"

/**
 * A saved connection's settings, filled in with what is stored. The one
 * field that cannot be is the password -- it never leaves the server -- so
 * it starts empty and empty means "keep the one you have". Only what
 * changed is sent, and the server tests the result before keeping it.
 */
export function ConnectionSettingsDialog({
  connection,
  open,
  onOpenChange,
}: {
  connection: DatabaseConnectionSummary
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const router = useTransitionRouter()
  const [name, setName] = React.useState(connection.name)
  const [engine, setEngineState] = React.useState<DatabaseEngine>(connection.engine)
  const [host, setHost] = React.useState(connection.host)
  const [port, setPort] = React.useState(String(connection.port))
  const [username, setUsername] = React.useState(connection.username)
  const [password, setPassword] = React.useState("")
  const [database, setDatabase] = React.useState(connection.database ?? "")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // The stored values every time it opens, whatever was typed last time.
  React.useEffect(() => {
    if (!open) return
    setName(connection.name)
    setEngineState(connection.engine)
    setHost(connection.host)
    setPort(String(connection.port))
    setUsername(connection.username)
    setPassword("")
    setDatabase(connection.database ?? "")
    setPending(false)
    setError(null)
  }, [open, connection])

  // Switching engine moves the port along only while it is still a default.
  function setEngine(next: DatabaseEngine) {
    if (port === "" || port === String(DEFAULT_DB_PORTS[engine])) setPort(String(DEFAULT_DB_PORTS[next]))
    setEngineState(next)
  }

  const portNumber = Number(port)
  const valid = host.trim() !== "" && username !== "" && Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535

  function changes(): DatabaseConnectionUpdate {
    const patch: DatabaseConnectionUpdate = {}
    if (name.trim() !== connection.name) patch.name = name.trim() || connection.name
    if (engine !== connection.engine) patch.engine = engine
    if (host.trim() !== connection.host) patch.host = host.trim()
    if (portNumber !== connection.port) patch.port = portNumber
    if (username !== connection.username) patch.username = username
    if (password !== "") patch.password = password
    if (database.trim() !== (connection.database ?? "")) patch.database = database.trim()
    return patch
  }

  async function submit(event: React.FormEvent) {
    event.preventDefault()
    if (!valid) return
    const patch = changes()
    if (Object.keys(patch).length === 0) return onOpenChange(false)
    setPending(true)
    setError(null)
    try {
      await updateConnection(connection.id, patch)
      onOpenChange(false)
      // The sidebar and the header name the connection from the layout's
      // list; a refresh re-reads it.
      router.refresh()
    } catch (caught) {
      setError(errorText(caught))
      setPending(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={(next) => !pending && onOpenChange(next)}>
      <DialogContent className="sm:max-w-lg">
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Connection settings</DialogTitle>
            <DialogDescription>
              How {connection.name} is reached. Changes are tested against the server before they are kept.
            </DialogDescription>
          </DialogHeader>

          <div className="flex flex-col gap-4 py-4">
            <Field>
              <FieldLabel htmlFor="conn-name">Name</FieldLabel>
              <Input id="conn-name" value={name} onChange={(e) => setName(e.target.value)} maxLength={80} autoComplete="off" disabled={pending} />
            </Field>

            <div className="flex flex-col gap-2">
              <span className="text-sm font-medium">Engine</span>
              <div className="grid grid-cols-2 gap-1" role="radiogroup" aria-label="Engine">
                {DatabaseEngine.options.map((option) => (
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={engine === option}
                    disabled={pending}
                    onClick={() => setEngine(option)}
                    className={cn(
                      "focus-visible:ring-ring h-8 rounded-md border text-sm transition-colors focus-visible:ring-2 focus-visible:outline-none disabled:opacity-60",
                      engine === option
                        ? "bg-accent text-accent-foreground border-foreground/30"
                        : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                    )}
                  >
                    {DATABASE_ENGINE_LABELS[option]}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid grid-cols-3 gap-3">
              <Field className="col-span-2">
                <FieldLabel htmlFor="conn-host">Host</FieldLabel>
                <Input id="conn-host" value={host} onChange={(e) => setHost(e.target.value)} spellCheck={false} autoComplete="off" disabled={pending} />
              </Field>
              <Field>
                <FieldLabel htmlFor="conn-port">Port</FieldLabel>
                <Input
                  id="conn-port"
                  value={port}
                  onChange={(e) => setPort(e.target.value.replace(/\D/g, ""))}
                  inputMode="numeric"
                  autoComplete="off"
                  disabled={pending}
                />
              </Field>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <Field>
                <FieldLabel htmlFor="conn-username">Username</FieldLabel>
                <Input id="conn-username" value={username} onChange={(e) => setUsername(e.target.value)} spellCheck={false} autoComplete="off" disabled={pending} />
              </Field>
              <Field>
                <FieldLabel htmlFor="conn-password">Password</FieldLabel>
                <Input
                  id="conn-password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Unchanged"
                  autoComplete="new-password"
                  disabled={pending}
                />
              </Field>
            </div>
            <Field>
              <FieldLabel htmlFor="conn-database">
                Default database <span className="text-muted-foreground font-normal">(optional)</span>
              </FieldLabel>
              <Input
                id="conn-database"
                value={database}
                onChange={(e) => setDatabase(e.target.value)}
                placeholder={engine === "mysql" ? "mysql" : "postgres"}
                spellCheck={false}
                autoComplete="off"
                disabled={pending}
              />
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
            <Button type="submit" disabled={!valid || pending}>
              {pending && <Loader2Icon className="animate-spin" />}
              {pending ? "Testing…" : "Test and save"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  )
}
