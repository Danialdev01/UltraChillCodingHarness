"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2Icon, LogOutIcon, TrashIcon, UserPlusIcon, UsersRoundIcon } from "lucide-react"
import { canAssignRole, canManageMember, ROLE_PERMISSIONS } from "@ucch/protocol/plain"
import type { AssignableRole, Membership, WorkspaceRole } from "@ucch/protocol"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { ListRowsSkeleton } from "@/components/page-skeletons"
import { Outcome, useOutcome } from "@/components/settings-outcome"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect } from "@/components/ui/native-select"
import type { Workspace } from "@/lib/session"
import { addMember, listMembers, removeMember, updateMember, type WorkspaceMember } from "@/lib/workspace-api"
import { useTransitionRouter } from "@/lib/view-transitions"
import { useCachedState } from "@/lib/queries/cached-state"
import { qk } from "@/lib/query-keys"

export const ROLE_LABELS: Record<WorkspaceRole, string> = {
  owner: "Owner",
  admin: "Admin",
  member: "Member",
  viewer: "Viewer",
}

export const ROLE_BLURBS: Record<WorkspaceRole, string> = {
  owner: "Everything, including deleting the workspace.",
  admin: "Manages members, sharing and the harness subscription.",
  member: "Creates projects and sessions, and works with the agent.",
  viewer: "Reads projects and conversations; changes nothing.",
}

const ASSIGNABLE: AssignableRole[] = ["admin", "member", "viewer"]

/**
 * Who is in the workspace, as what, and the two things a member can be
 * allowed or refused on top of their role: creating projects and starting
 * sessions.
 */
export function WorkspaceMembersSettings({
  workspace,
  currentUserId,
}: {
  workspace: Workspace
  currentUserId: string
}) {
  // Cached, and refreshed live when anyone changes the membership (R2/R3).
  const [members, setMembers, load, loadState] = useCachedState<WorkspaceMember[]>(
    qk.members.list(workspace.id),
    () => listMembers(workspace.id),
    { persist: true },
  )
  const loadError = loadState.error ? loadState.error.message : null

  const actor: Membership = {
    role: workspace.role,
    // Overrides only narrow project and session creation, never management.
    canCreateProject: null,
    canCreateSession: null,
  }
  const manages = workspace.permissions.includes("members.manage")

  return (
    <div className="flex flex-col gap-4">
      {manages && <AddMember workspaceId={workspace.id} actor={actor} onAdded={load} />}

      <section className="rounded-lg border p-6">
        <h2 className="flex items-center gap-2 text-sm font-medium">
          <UsersRoundIcon className="text-muted-foreground size-4" />
          Members of {workspace.name}
        </h2>
        <p className="text-muted-foreground mt-2 max-w-prose text-sm">
          Each person has a role. Project and session creation can also be allowed or refused per
          person, whatever their role says.
        </p>

        {loadError && <p className="text-destructive mt-4 text-sm">{loadError}</p>}
        {!members && !loadError && <ListRowsSkeleton rows={3} className="mt-4 flex flex-col gap-2" />}
        {members && (
          <ul className="mt-4 flex flex-col divide-y">
            {members.map((member) => (
              <MemberRow
                key={member.userId}
                workspace={workspace}
                member={member}
                actor={actor}
                self={member.userId === currentUserId}
                onChanged={load}
              />
            ))}
          </ul>
        )}
      </section>

      <section className="rounded-lg border p-6">
        <h2 className="text-sm font-medium">Roles</h2>
        <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[8rem_1fr]">
          {(Object.keys(ROLE_LABELS) as WorkspaceRole[]).map((role) => (
            <React.Fragment key={role}>
              <dt className="font-medium">{ROLE_LABELS[role]}</dt>
              <dd className="text-muted-foreground">
                {ROLE_BLURBS[role]}{" "}
                <span className="text-xs">({ROLE_PERMISSIONS[role].length} permissions)</span>
              </dd>
            </React.Fragment>
          ))}
        </dl>
      </section>
    </div>
  )
}

function AddMember({
  workspaceId,
  actor,
  onAdded,
}: {
  workspaceId: string
  actor: Membership
  onAdded: () => Promise<void>
}) {
  const [identifier, setIdentifier] = React.useState("")
  const [role, setRole] = React.useState<AssignableRole>("member")
  const { busy, error, done, run } = useOutcome()

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <UserPlusIcon className="text-muted-foreground size-4" />
        Add a member
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Someone who already has an account here, by username or email. For anyone else, make an
        invite link under Sharing.
      </p>
      <form
        className="mt-4 flex max-w-xl flex-col gap-3 sm:flex-row sm:items-end"
        onSubmit={(e) => {
          e.preventDefault()
          void run(async () => {
            await addMember(workspaceId, identifier.trim(), role)
            setIdentifier("")
            await onAdded()
            return "Added."
          })
        }}
      >
        <div className="grid flex-1 gap-1.5">
          <Label htmlFor="member-identifier">Username or email</Label>
          <Input
            id="member-identifier"
            value={identifier}
            onChange={(e) => setIdentifier(e.target.value)}
            autoComplete="off"
            spellCheck={false}
          />
        </div>
        <div className="grid gap-1.5 sm:w-36">
          <Label htmlFor="member-role">Role</Label>
          <NativeSelect id="member-role" value={role} onChange={(v) => setRole(v as AssignableRole)}>
            {ASSIGNABLE.filter((r) => canAssignRole(actor, r)).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </NativeSelect>
        </div>
        <Button type="submit" disabled={busy || !identifier.trim()}>
          {busy && <Loader2Icon className="animate-spin" />}
          Add
        </Button>
      </form>
      <Outcome error={error} done={done} />
    </section>
  )
}

/** "Role default" / "Allowed" / "Not allowed", stored as null / true / false. */
function overrideValue(value: boolean | null): string {
  return value === null ? "default" : value ? "allow" : "deny"
}

function parseOverride(value: string): boolean | null {
  return value === "default" ? null : value === "allow"
}

function MemberRow({
  workspace,
  member,
  actor,
  self,
  onChanged,
}: {
  workspace: Workspace
  member: WorkspaceMember
  actor: Membership
  self: boolean
  onChanged: () => Promise<void>
}) {
  const router = useRouter()
  const transitionRouter = useTransitionRouter()
  const { busy, error, run } = useOutcome()
  const [confirming, setConfirming] = React.useState(false)
  const editable = !self && canManageMember(actor, member)
  const display = member.name || member.login

  const patch = (change: Parameters<typeof updateMember>[2]) =>
    void run(async () => {
      await updateMember(workspace.id, member.userId, change)
      await onChanged()
      return "Saved."
    })

  return (
    <li className="flex flex-col gap-3 py-3 first:pt-0 last:pb-0">
      <div className="flex items-center gap-3">
        <Avatar className="size-8">
          {member.avatarUrl && <AvatarImage src={member.avatarUrl} alt="" />}
          <AvatarFallback>{display.slice(0, 2).toUpperCase()}</AvatarFallback>
        </Avatar>
        <div className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate text-sm font-medium">
            {display}
            {self && <span className="text-muted-foreground font-normal"> (you)</span>}
          </span>
          <span className="text-muted-foreground truncate text-xs">{member.email ?? `@${member.login}`}</span>
        </div>
        {editable ? (
          <div className="w-32">
            <NativeSelect
              id={`role-${member.userId}`}
              value={member.role}
              disabled={busy}
              onChange={(v) => patch({ role: v as AssignableRole })}
            >
              {ASSIGNABLE.filter((r) => r === member.role || canAssignRole(actor, r)).map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABELS[r]}
                </option>
              ))}
            </NativeSelect>
          </div>
        ) : (
          <span className="text-muted-foreground text-sm">{ROLE_LABELS[member.role]}</span>
        )}
        {editable && (
          <Button variant="ghost" size="icon" aria-label={`Remove ${display}`} onClick={() => setConfirming(true)}>
            <TrashIcon />
          </Button>
        )}
        {self && member.role !== "owner" && (
          <Button variant="outline" size="sm" onClick={() => setConfirming(true)}>
            <LogOutIcon />
            Leave
          </Button>
        )}
      </div>

      {member.role !== "owner" && (
        <div className="flex flex-wrap gap-4 pl-11 text-xs">
          <Override
            id={`project-${member.userId}`}
            label="Create projects"
            value={member.canCreateProject}
            roleDefault={ROLE_PERMISSIONS[member.role].includes("project.create")}
            disabled={!editable || busy}
            onChange={(v) => patch({ canCreateProject: v })}
          />
          <Override
            id={`session-${member.userId}`}
            label="Create sessions"
            value={member.canCreateSession}
            roleDefault={ROLE_PERMISSIONS[member.role].includes("session.create")}
            disabled={!editable || busy}
            onChange={(v) => patch({ canCreateSession: v })}
          />
        </div>
      )}
      {error && <p className="text-destructive pl-11 text-sm">{error}</p>}

      <ConfirmDialog
        open={confirming}
        onOpenChange={setConfirming}
        title={self ? `Leave ${workspace.name}?` : `Remove ${display}?`}
        description={
          self
            ? "You will lose access to its projects until someone adds you again."
            : "They lose access to every project in this workspace. Their sessions stay."
        }
        confirmLabel={self ? "Leave" : "Remove"}
        onConfirm={async () => {
          await removeMember(workspace.id, member.userId)
          if (self) {
            // Nothing here is yours to see any more: back to the workspace
            // list, which no longer has it.
            transitionRouter.push("/")
            router.refresh()
            return
          }
          await onChanged()
        }}
      />
    </li>
  )
}

function Override({
  id,
  label,
  value,
  roleDefault,
  disabled,
  onChange,
}: {
  id: string
  label: string
  value: boolean | null
  roleDefault: boolean
  disabled: boolean
  onChange: (value: boolean | null) => void
}) {
  return (
    <label htmlFor={id} className="text-muted-foreground flex items-center gap-2">
      {label}
      <div className="w-40">
        <NativeSelect id={id} value={overrideValue(value)} disabled={disabled} onChange={(v) => onChange(parseOverride(v))}>
          <option value="default">Role default ({roleDefault ? "yes" : "no"})</option>
          <option value="allow">Allowed</option>
          <option value="deny">Not allowed</option>
        </NativeSelect>
      </div>
    </label>
  )
}
