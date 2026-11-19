"use client"

import * as React from "react"
import { FingerprintIcon, KeyRoundIcon, ServerIcon, UploadIcon } from "lucide-react"
import type { SshAuthMethod, SshHostSummary } from "@ucch/protocol"

import {
  Callout,
  Code,
  FIELD,
  FormDialog,
  FormDialogFooter,
  FormField,
  Optional,
  SECONDARY_BUTTON,
  Segmented,
  TEXTAREA,
} from "@/components/form-dialog"
import { qk } from "@/lib/query-keys"
import { createSshHost, updateSshHost } from "@/lib/ssh-api"
import { useInvalidate } from "@/lib/use-invalidate"
import { cn } from "@/lib/utils"

const AUTH_OPTIONS = [
  { value: "password", label: "Password" },
  { value: "key", label: "Private key" },
] as const satisfies readonly { value: SshAuthMethod; label: string }[]

/**
 * Adds a server, or changes one. Saving tries the login first, so a typo in
 * the host or a wrong key is found here rather than in the first terminal,
 * and pins the host key the server presents.
 *
 * Editing never shows the stored password or key: leaving the field empty
 * keeps it.
 */
export function SshHostDialog({
  workspaceId,
  host,
  open,
  onOpenChange,
  onSaved,
}: {
  workspaceId: string
  /** The host to change; absent to add one. */
  host?: SshHostSummary
  open: boolean
  onOpenChange: (open: boolean) => void
  onSaved?: (host: SshHostSummary) => void
}) {
  const invalidate = useInvalidate()
  const editing = host !== undefined
  const [name, setName] = React.useState("")
  const [address, setAddress] = React.useState("")
  const [port, setPort] = React.useState("22")
  const [username, setUsername] = React.useState("root")
  const [authMethod, setAuthMethod] = React.useState<SshAuthMethod>("password")
  const [secret, setSecret] = React.useState("")
  const [passphrase, setPassphrase] = React.useState("")
  const [busy, setBusy] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const keyFile = React.useRef<HTMLInputElement>(null)

  React.useEffect(() => {
    if (!open) return
    setName(host?.name ?? "")
    setAddress(host?.host ?? "")
    setPort(String(host?.port ?? 22))
    setUsername(host?.username ?? "root")
    setAuthMethod(host?.authMethod ?? "password")
    setSecret("")
    setPassphrase("")
    setError(null)
  }, [open, host])

  const portNumber = Number(port)
  const portValid = Number.isInteger(portNumber) && portNumber >= 1 && portNumber <= 65535
  const methodChanged = editing && authMethod !== host.authMethod
  const ready =
    name.trim() !== "" &&
    address.trim() !== "" &&
    username.trim() !== "" &&
    portValid &&
    // A new host needs its secret; a changed method needs the new kind of secret.
    (secret !== "" || (editing && !methodChanged))

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!ready || busy) return
    setBusy(true)
    setError(null)
    try {
      const fields = {
        name: name.trim(),
        host: address.trim(),
        port: portNumber,
        username: username.trim(),
        authMethod,
        ...(secret ? { secret } : {}),
        ...(authMethod === "key" && (secret || passphrase) ? { passphrase } : {}),
      }
      const saved = editing
        ? await updateSshHost(host.id, fields)
        : await createSshHost(workspaceId, { ...fields, secret })
      invalidate(qk.sshHosts.all)
      onSaved?.(saved)
      onOpenChange(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  async function readKeyFile(file: File | undefined) {
    if (!file) return
    if (file.size > 16_384) {
      setError("That file is too large to be a private key.")
      return
    }
    setSecret(await file.text())
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={busy}
      icon={ServerIcon}
      title={editing ? `Edit ${host.name}` : "Add a server"}
      description={
        editing
          ? "The login is tried again before the change is kept."
          : "A machine this workspace reaches over SSH. The login is tried before it is saved."
      }
      onSubmit={submit}
      footer={
        <FormDialogFooter
          busy={busy}
          disabled={!ready}
          hint={busy ? "Connecting…" : "Credentials stay on the server, encrypted"}
          hintIcon={KeyRoundIcon}
        >
          {editing ? "Save" : "Add server"}
        </FormDialogFooter>
      }
    >
      <FormField label="Name" htmlFor="ssh-name">
        <input
          id="ssh-name"
          className={FIELD}
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Production web"
          maxLength={80}
          autoFocus
          autoComplete="off"
        />
      </FormField>

      <div className="grid grid-cols-[1fr_88px] gap-3">
        <FormField label="Host" htmlFor="ssh-host">
          <input
            id="ssh-host"
            className={FIELD}
            value={address}
            onChange={(e) => setAddress(e.target.value)}
            placeholder="203.0.113.10 or vps.example.com"
            autoComplete="off"
            spellCheck={false}
          />
        </FormField>
        <FormField label="Port" htmlFor="ssh-port" error={port !== "" && !portValid ? "1-65535" : undefined}>
          <input
            id="ssh-port"
            className={FIELD}
            value={port}
            onChange={(e) => setPort(e.target.value.replace(/[^0-9]/g, ""))}
            inputMode="numeric"
          />
        </FormField>
      </div>

      <FormField label="User" htmlFor="ssh-user">
        <input
          id="ssh-user"
          className={FIELD}
          value={username}
          onChange={(e) => setUsername(e.target.value)}
          autoComplete="off"
          spellCheck={false}
        />
      </FormField>

      <FormField label="Sign in with" labelId="ssh-auth-label">
        <Segmented options={AUTH_OPTIONS} value={authMethod} onChange={setAuthMethod} labelledBy="ssh-auth-label" />
      </FormField>

      {authMethod === "password" ? (
        <FormField
          label="Password"
          htmlFor="ssh-password"
          helper={editing && !methodChanged ? "Leave empty to keep the saved password." : undefined}
        >
          <input
            id="ssh-password"
            type="password"
            className={FIELD}
            value={secret}
            onChange={(e) => setSecret(e.target.value)}
            autoComplete="new-password"
            placeholder={editing && !methodChanged ? "••••••••" : undefined}
          />
        </FormField>
      ) : (
        <>
          <FormField
            label="Private key"
            htmlFor="ssh-key"
            helper={
              editing && !methodChanged
                ? "Leave empty to keep the saved key."
                : (
                    <>
                      OpenSSH or PEM, e.g. the contents of <Code>~/.ssh/id_ed25519</Code>.
                    </>
                  )
            }
            aside={
              <button type="button" className={SECONDARY_BUTTON} onClick={() => keyFile.current?.click()}>
                <UploadIcon />
                From file
              </button>
            }
          >
            <textarea
              id="ssh-key"
              className={cn(TEXTAREA, "fd-mono min-h-28 text-[11px]")}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              placeholder={"-----BEGIN OPENSSH PRIVATE KEY-----\n…"}
              spellCheck={false}
              autoComplete="off"
            />
            <input
              ref={keyFile}
              type="file"
              className="hidden"
              onChange={(e) => {
                void readKeyFile(e.target.files?.[0])
                e.target.value = ""
              }}
            />
          </FormField>
          <FormField
            label={
              <>
                Passphrase
                <Optional />
              </>
            }
            htmlFor="ssh-passphrase"
            helper={editing && host.hasPassphrase && !secret ? "Leave empty to keep the saved passphrase." : undefined}
          >
            <input
              id="ssh-passphrase"
              type="password"
              className={FIELD}
              value={passphrase}
              onChange={(e) => setPassphrase(e.target.value)}
              autoComplete="new-password"
            />
          </FormField>
        </>
      )}

      {editing && host.hostKeySha256 && (
        <Callout icon={FingerprintIcon}>
          Host key <Code>{host.hostKeySha256}</Code>. A connection that presents another key is refused.
        </Callout>
      )}

      {error && (
        <p role="alert" className="text-destructive text-[12px] leading-normal break-words">
          {error}
        </p>
      )}
    </FormDialog>
  )
}
