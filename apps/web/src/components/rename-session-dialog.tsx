"use client"

import * as React from "react"
import { PencilIcon } from "lucide-react"

import { FIELD, FormDialog, FormDialogFooter, FormField } from "@/components/form-dialog"
import { renameProject } from "@/lib/create-project"
/**
 * Renames a session. A session workspace's session is its project, renamed
 * by default; `save` names it some other way (a project's session, whose
 * title is its thread's).
 */
export function RenameSessionDialog({
  session,
  onOpenChange,
  onRenamed,
  save,
}: {
  session: { hash: string; name: string } | null
  onOpenChange: (open: boolean) => void
  onRenamed: () => void
  save?: (name: string) => Promise<void>
}) {
  const [name, setName] = React.useState("")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    if (!session) return
    setName(session.name)
    setError(null)
  }, [session])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!session || pending || !name.trim()) return
    setPending(true)
    setError(null)
    try {
      await (save ? save(name.trim()) : renameProject(session.hash, name.trim()))
      onOpenChange(false)
      onRenamed()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not rename it.")
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={session !== null}
      onOpenChange={onOpenChange}
      busy={pending}
      icon={PencilIcon}
      title="Rename session"
      description="The title shown on the session's card."
      onSubmit={submit}
      footer={
        <FormDialogFooter busy={pending} disabled={!name.trim() || name.trim() === session?.name}>
          {pending ? "Saving…" : "Rename"}
        </FormDialogFooter>
      }
    >
      <FormField label="Title" htmlFor="session-title" error={error}>
        <input
          id="session-title"
          className={FIELD}
          value={name}
          onChange={(e) => setName(e.target.value)}
          maxLength={100}
          autoFocus
          required
          disabled={pending}
        />
      </FormField>
    </FormDialog>
  )
}
