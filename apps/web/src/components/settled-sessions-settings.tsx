"use client"

import * as React from "react"
import { Trash2Icon } from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { SettingsSection } from "@/components/layout/settings-section"
import { Button } from "@/components/ui/button"
import { deleteSettledSessions } from "@/lib/project-sessions"
import { qk } from "@/lib/query-keys"
import { useToast } from "@/lib/realtime"
import type { Workspace } from "@/lib/session"
import { useInvalidate } from "@/lib/use-invalidate"

/**
 * Deleting every settled session of a session workspace, data and all.
 *
 * Settling a session only marks it done; this is where its chat, files and
 * terminal history are removed. Sessions that are not settled are left
 * alone. Shown only to those who may delete sessions (workspace admins).
 */
export function SettledSessionsSettings({ workspace }: { workspace: Workspace }) {
  const [open, setOpen] = React.useState(false)
  const toast = useToast()
  const invalidate = useInvalidate()

  if (workspace.kind !== "session" || !workspace.permissions.includes("workspace.manage")) return null

  return (
    <SettingsSection
      icon={Trash2Icon}
      title="Settled sessions"
      description="Settling a session keeps its data until you delete it here. Only settled sessions are deleted; the others are not touched."
      bare
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-muted-foreground max-w-prose text-sm">
          Deletes the chat, files and history of every settled session in {workspace.name}. It cannot be undone.
        </p>
        <Button type="button" variant="destructive" onClick={() => setOpen(true)}>
          <Trash2Icon />
          Delete settled session data
        </Button>
      </div>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title="Delete all settled session data?"
        description="Every settled session in this workspace is deleted with its files and history. Sessions that are not settled stay. This cannot be undone."
        confirmLabel="Delete settled sessions"
        onConfirm={async () => {
          const result = await deleteSettledSessions(workspace.id)
          invalidate(qk.bootstrap(), qk.sessions.all, qk.projects.all)
          toast({
            title:
              result.deleted === 0
                ? "No settled sessions to delete"
                : `Deleted ${result.deleted} settled ${result.deleted === 1 ? "session" : "sessions"}`,
            description:
              [
                result.skipped ? `${result.skipped} could not be deleted (a turn may still be running).` : "",
                result.leftFiles ? `Some files of ${result.leftFiles} could not be removed from disk.` : "",
              ]
                .filter(Boolean)
                .join(" ") || undefined,
            tone: result.skipped || result.leftFiles ? "error" : undefined,
          })
        }}
      />
    </SettingsSection>
  )
}
