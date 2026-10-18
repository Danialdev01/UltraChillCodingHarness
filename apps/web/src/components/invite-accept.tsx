"use client"

import * as React from "react"
import { useRouter } from "next/navigation"
import { Loader2Icon, UsersRoundIcon } from "lucide-react"

import { ROLE_BLURBS, ROLE_LABELS } from "@/components/workspace-members-settings"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useTransitionRouter } from "@/lib/view-transitions"
import { acceptInvite, previewInvite, type InvitePreview } from "@/lib/workspace-api"

/**
 * The page an invite link opens: whose workspace, as what, and a button.
 * Joining is a click rather than automatic, so a link opened by accident
 * -- or by a preview bot -- does not quietly add anyone to anything.
 */
export function InviteAccept({ token }: { token: string }) {
  const router = useRouter()
  const transitionRouter = useTransitionRouter()
  const [invite, setInvite] = React.useState<InvitePreview | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [joining, setJoining] = React.useState(false)

  React.useEffect(() => {
    previewInvite(token).then(setInvite, (e: unknown) => setError(e instanceof Error ? e.message : String(e)))
  }, [token])

  // The shell follows the workspace in the address; the refresh is what
  // lists a workspace just joined in its switcher.
  const enter = (workspaceHash: string) => {
    transitionRouter.push(`/${workspaceHash}`)
    router.refresh()
  }

  return (
    <section className="rounded-lg border p-6">
      <h1 className="flex items-center gap-2 text-base font-medium">
        <UsersRoundIcon className="text-muted-foreground size-4" />
        Workspace invite
      </h1>
      {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
      {!invite && !error && (
        <div className="mt-3 flex flex-col gap-2">
          <Skeleton className="h-4 w-3/4" />
          <Skeleton className="h-3 w-1/2" />
          <Skeleton className="mt-2 h-8 w-32" />
        </div>
      )}
      {invite && (
        <>
          <p className="mt-3 text-sm">
            {invite.ownerName} invited you to <span className="font-medium">{invite.workspaceName}</span> as{" "}
            <span className="font-medium">{ROLE_LABELS[invite.role].toLowerCase()}</span>.
          </p>
          <p className="text-muted-foreground mt-1 text-sm">{ROLE_BLURBS[invite.role]}</p>
          <div className="mt-4">
            {invite.alreadyMember ? (
              <Button onClick={() => enter(invite.workspaceHash)}>Open workspace</Button>
            ) : (
              <Button
                disabled={joining}
                onClick={() => {
                  setJoining(true)
                  setError(null)
                  acceptInvite(token).then(
                    ({ workspaceHash }) => enter(workspaceHash),
                    (e: unknown) => {
                      setJoining(false)
                      setError(e instanceof Error ? e.message : String(e))
                    },
                  )
                }}
              >
                {joining && <Loader2Icon className="animate-spin" />}
                Join workspace
              </Button>
            )}
          </div>
        </>
      )}
    </section>
  )
}
