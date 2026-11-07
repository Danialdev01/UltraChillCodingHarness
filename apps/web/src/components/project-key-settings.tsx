"use client"

import * as React from "react"
import { KeyRoundIcon, Loader2Icon, ShieldAlertIcon, ShieldCheckIcon } from "lucide-react"
import { PROJECT_KEY_MAX, PROJECT_KEY_MIN } from "@ucch/protocol/plain"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  changeProjectKey,
  projectKeyStatus,
  resetProjectKey,
  setupProjectKey,
  type ProjectKeyStatus,
} from "@/lib/env-api"
import { newKeyProblem } from "@/lib/project-key"
import { lockProject, unlockProject } from "@/lib/project-key-store"
import { useLiveResource } from "@/lib/realtime"
import type { Project } from "@/lib/session"
import { SettingsSection } from "@/components/layout/settings-section"

/** A password field that password managers leave alone. */
function KeyInput(props: React.ComponentProps<typeof Input>) {
  return (
    <Input
      type="password"
      maxLength={PROJECT_KEY_MAX}
      autoComplete="new-password"
      data-1p-ignore
      data-lpignore="true"
      className="max-w-sm"
      {...props}
    />
  )
}

/**
 * The project key, on the manage page's Project key tab.
 *
 * Optional, but it is what turns the documentation's Environment Variables
 * on: their values are encrypted with it in `.agent/env.val`. It is never
 * stored, so it cannot be recovered -- a forgotten key can only be reset,
 * which removes every value.
 */
export function ProjectKeySettings({ project }: { project: Project }) {
  const [status, setStatus] = React.useState<ProjectKeyStatus | null>(null)
  const [error, setError] = React.useState<string | null>(null)

  const load = React.useCallback(() => {
    projectKeyStatus(project.hash).then(
      (s) => {
        setStatus(s)
        setError(null)
      },
      (e) => setError(e instanceof Error ? e.message : "Could not load."),
    )
  }, [project.hash])
  React.useEffect(load, [load])
  useLiveResource("keys", load, project.id)

  return (
    <SettingsSection icon={KeyRoundIcon} title={<>Project key
        {status &&
          (status.configured ? (
            <span className="text-success inline-flex items-center gap-1 text-xs font-normal">
              <ShieldCheckIcon className="size-3.5" /> Set up
            </span>
          ) : (
            <span className="text-muted-foreground inline-flex items-center gap-1 text-xs font-normal">
              <ShieldAlertIcon className="size-3.5" /> Not set up · recommended
            </span>
          ))}</>} description={<>Encrypts the project&apos;s environment variables, which are kept in{" "}
        <code className="font-mono">.agent/env.val</code>. Environment Variables, under Documentation, is
        enabled once the project has a key, and values can only be seen by someone who enters it here in
        the app. The key is never stored, so it cannot be recovered: keep it somewhere safe.</>} bare>

      {error && (
        <p role="alert" className="text-destructive mt-3 text-xs">
          {error}
        </p>
      )}

      {status === null ? (
        !error && <Skeleton className="mt-4 h-24 max-w-sm" />
      ) : status.configured ? (
        <ChangeKey project={project} onReset={load} />
      ) : (
        <SetUpKey project={project} legacyCount={status.legacyCount} onDone={load} />
      )}
    </SettingsSection>
  )
}

function SetUpKey({ project, legacyCount, onDone }: { project: Project; legacyCount: number; onDone: () => void }) {
  const [key, setKey] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [note, setNote] = React.useState<string | null>(null)

  const problem = newKeyProblem(key, confirm)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (problem) return setError(problem)
    setPending(true)
    setError(null)
    try {
      const { migrated, skipped } = await setupProjectKey(project.hash, key)
      unlockProject(project.hash, key)
      if (migrated || skipped) {
        setNote(
          `${migrated} saved ${migrated === 1 ? "key was" : "keys were"} moved into .agent/env.val` +
            (skipped ? `; ${skipped} could not be read and stayed behind.` : "."),
        )
      }
      onDone()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not set the project key up.")
    } finally {
      setPending(false)
    }
  }

  return (
    <form className="mt-4 grid max-w-xl gap-3" onSubmit={submit} autoComplete="off">
      <Field>
        <FieldLabel htmlFor="project-key-new">Project key</FieldLabel>
        <KeyInput id="project-key-new" value={key} onChange={(e) => setKey(e.target.value)} disabled={pending} />
      </Field>
      <Field>
        <FieldLabel htmlFor="project-key-confirm">Confirm the key</FieldLabel>
        <KeyInput id="project-key-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={pending} />
        <FieldDescription>
          At least {PROJECT_KEY_MIN} characters.
          {legacyCount > 0 &&
            ` The ${legacyCount} ${legacyCount === 1 ? "key" : "keys"} saved before will be moved into .agent/env.val and encrypted with it.`}
        </FieldDescription>
      </Field>
      {error && (
        <p role="alert" className="text-destructive text-xs">
          {error}
        </p>
      )}
      {note && <p className="text-muted-foreground text-xs">{note}</p>}
      <div>
        <Button type="submit" disabled={pending || !key}>
          {pending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
          Set up project key
        </Button>
      </div>
    </form>
  )
}

function ChangeKey({ project, onReset }: { project: Project; onReset: () => void }) {
  const [current, setCurrent] = React.useState("")
  const [key, setKey] = React.useState("")
  const [confirm, setConfirm] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [done, setDone] = React.useState(false)
  const [resetting, setResetting] = React.useState(false)

  const problem = newKeyProblem(key, confirm)

  const submit = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!current) return setError("Enter the current project key.")
    if (problem) return setError(problem)
    setPending(true)
    setError(null)
    setDone(false)
    try {
      await changeProjectKey(project.hash, current, key)
      unlockProject(project.hash, key)
      setCurrent("")
      setKey("")
      setConfirm("")
      setDone(true)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the project key.")
    } finally {
      setPending(false)
    }
  }

  return (
    <>
      <form className="mt-4 grid max-w-xl gap-3" onSubmit={submit} autoComplete="off">
        <Field>
          <FieldLabel htmlFor="project-key-current">Current key</FieldLabel>
          <KeyInput id="project-key-current" autoComplete="off" value={current} onChange={(e) => setCurrent(e.target.value)} disabled={pending} />
        </Field>
        <Field>
          <FieldLabel htmlFor="project-key-next">New key</FieldLabel>
          <KeyInput id="project-key-next" value={key} onChange={(e) => setKey(e.target.value)} disabled={pending} />
        </Field>
        <Field>
          <FieldLabel htmlFor="project-key-next-confirm">Confirm the new key</FieldLabel>
          <KeyInput id="project-key-next-confirm" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={pending} />
          <FieldDescription>Every value is re-encrypted with the new key.</FieldDescription>
        </Field>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
        {done && <p className="text-muted-foreground text-xs">The project key was changed.</p>}
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={pending || !current || !key}>
            {pending ? <Loader2Icon className="animate-spin" /> : <KeyRoundIcon />}
            Change key
          </Button>
          <Button type="button" variant="ghost" className="text-destructive" onClick={() => setResetting(true)}>
            Forgot the key? Reset
          </Button>
        </div>
      </form>

      <ConfirmDialog
        open={resetting}
        onOpenChange={setResetting}
        title="Reset the project key?"
        description="Without the key the values cannot be decrypted, so resetting removes .agent/env.val and every environment variable in it. Afterwards you can set up a new key."
        confirmLabel="Reset and remove all values"
        typeToConfirm={project.name}
        onConfirm={async () => {
          await resetProjectKey(project.hash)
          lockProject(project.hash)
          setResetting(false)
          onReset()
        }}
      />
    </>
  )
}
