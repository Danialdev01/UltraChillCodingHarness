"use client"

import * as React from "react"
import { CheckIcon, CopyIcon, LinkIcon, Loader2Icon, Share2Icon, TrashIcon } from "lucide-react"
import { canAssignRole } from "@ucch/protocol/plain"
import type { AssignableRole } from "@ucch/protocol"

import { ListRowsSkeleton } from "@/components/page-skeletons"
import { Outcome, useOutcome } from "@/components/settings-outcome"
import { ROLE_LABELS } from "@/components/workspace-members-settings"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import type { Workspace } from "@/lib/session"
import {
  createInvite,
  inviteUrl,
  listInvites,
  revokeInvite,
  type WorkspaceInvite,
} from "@/lib/workspace-api"

const EXPIRY_DAYS = [1, 7, 30] as const

/**
 * Making the workspace shareable: invite links that let anyone with an
 * account join with a preset role. A link is shown once, when it is made --
 * the server keeps only its hash -- and can be revoked at any time.
 */
export function WorkspaceSharingSettings({ workspace }: { workspace: Workspace }) {
  const manages = workspace.permissions.includes("members.manage")
  const [invites, setInvites] = React.useState<WorkspaceInvite[] | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)
  const [fresh, setFresh] = React.useState<string | null>(null)

  const load = React.useCallback(async () => {
    try {
      setInvites(await listInvites(workspace.id))
      setLoadError(null)
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : String(e))
    }
  }, [workspace.id])

  React.useEffect(() => {
    if (manages) void load()
  }, [load, manages])

  if (!manages) {
    return (
      <section className="rounded-lg border p-6">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <Share2Icon className="text-muted-foreground size-4" />
          Sharing
        </h2>
        <p className="text-muted-foreground mt-2 max-w-prose text-sm">
          {workspace.shared
            ? `${workspace.ownerName} shared this workspace with you as ${ROLE_LABELS[workspace.role].toLowerCase()}. Only an owner or admin can invite others.`
            : "Only an owner or admin can invite others."}
        </p>
      </section>
    )
  }

  return (
    <div className="flex flex-col gap-4">
      <CreateInvite
        workspace={workspace}
        onCreated={async (token) => {
          setFresh(inviteUrl(token))
          await load()
        }}
      />

      {fresh && <FreshLink url={fresh} />}

      <section className="rounded-lg border p-6">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <LinkIcon className="text-muted-foreground size-4" />
          Active invite links
        </h2>
        {loadError && <p className="text-destructive mt-4 text-sm">{loadError}</p>}
        {!invites && !loadError && <ListRowsSkeleton rows={2} className="mt-4 flex flex-col gap-2" />}
        {invites && invites.length === 0 && (
          <p className="text-muted-foreground mt-2 text-sm">No links are active.</p>
        )}
        {invites && invites.length > 0 && (
          <ul className="mt-4 flex flex-col divide-y">
            {invites.map((invite) => (
              <InviteRow key={invite.id} workspaceId={workspace.id} invite={invite} onRevoked={load} />
            ))}
          </ul>
        )}
      </section>
    </div>
  )
}

function CreateInvite({
  workspace,
  onCreated,
}: {
  workspace: Workspace
  onCreated: (token: string) => Promise<void>
}) {
  const actor = { role: workspace.role, canCreateProject: null, canCreateSession: null }
  const roles = (["admin", "member", "viewer"] as const).filter((r) => canAssignRole(actor, r))
  const [role, setRole] = React.useState<AssignableRole>("member")
  const [days, setDays] = React.useState<number>(7)
  const [maxUses, setMaxUses] = React.useState("")
  const { busy, error, done, run } = useOutcome()

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <Share2Icon className="text-muted-foreground size-4" />
        Share {workspace.name}
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Anyone who opens the link while signed in joins with the role you pick. Copy it now: it is
        only shown once.
      </p>
      <form
        className="mt-4 grid max-w-xl gap-3 sm:grid-cols-3 sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            const uses = maxUses.trim() ? Number.parseInt(maxUses, 10) : null
            const { token } = await createInvite(workspace.id, {
              role,
              expiresInDays: days,
              maxUses: uses && uses > 0 ? uses : null,
            })
            await onCreated(token)
            return "Link created."
          })
        }}
      >
        <div className="grid gap-1.5">
          <Label htmlFor="invite-role">Role</Label>
          <NativeSelect id="invite-role" value={role} onChange={(v) => setRole(v as AssignableRole)}>
            {roles.map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="invite-expiry">Expires after</Label>
          <NativeSelect id="invite-expiry" value={String(days)} onChange={(v) => setDays(Number(v))}>
            {EXPIRY_DAYS.map((d) => (
              <option key={d} value={d}>
                {d === 1 ? "1 day" : `${d} days`}
              </option>
            ))}
          </NativeSelect>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="invite-uses">Max uses</Label>
          <Input
            id="invite-uses"
            inputMode="numeric"
            placeholder="Unlimited"
            value={maxUses}
            onChange={(e) => setMaxUses(e.target.value.replace(/\D/g, ""))}
          />
        </div>
        <Button type="submit" disabled={busy} className="sm:col-span-3 sm:justify-self-start">
          {busy && <Loader2Icon className="animate-spin" />}
          Create invite link
        </Button>
      </form>
      <Outcome error={error} done={done} />
    </section>
  )
}

function FreshLink({ url }: { url: string }) {
  const [copied, setCopied] = React.useState(false)
  return (
    <section className="border-ucch-active/40 rounded-lg border p-6">
      <h2 className="text-sm font-medium">Your new invite link</h2>
      <div className="mt-3 flex max-w-xl gap-2">
        <Input readOnly value={url} className="font-mono text-xs" onFocus={(e) => e.currentTarget.select()} />
        <Button
          variant="outline"
          onClick={() => {
            void navigator.clipboard.writeText(url).then(() => {
              setCopied(true)
              setTimeout(() => setCopied(false), 2000)
            })
          }}
        >
          {copied ? <CheckIcon /> : <CopyIcon />}
          {copied ? "Copied" : "Copy"}
        </Button>
      </div>
    </section>
  )
}

function InviteRow({
  workspaceId,
  invite,
  onRevoked,
}: {
  workspaceId: string
  invite: WorkspaceInvite
  onRevoked: () => Promise<void>
}) {
  const { busy, error, run } = useOutcome()
  return (
    <li className="flex items-center gap-3 py-2 first:pt-0 last:pb-0 text-sm">
      <div className="grid min-w-0 flex-1 leading-tight">
        <span>{ROLE_LABELS[invite.role]} link</span>
        <span className="text-muted-foreground text-xs">
          Expires {new Date(invite.expiresAt).toLocaleDateString()} · used {invite.uses}
          {invite.maxUses !== null ? ` of ${invite.maxUses}` : ""} time{invite.uses === 1 ? "" : "s"}
        </span>
        {error && <span className="text-destructive text-xs">{error}</span>}
      </div>
      <Button
        variant="outline"
        size="sm"
        disabled={busy}
        onClick={() =>
          void run(async () => {
            await revokeInvite(workspaceId, invite.id)
            await onRevoked()
            return "Revoked."
          })
        }
      >
        {busy ? <Loader2Icon className="animate-spin" /> : <TrashIcon />}
        Revoke
      </Button>
    </li>
  )
}
