"use client"

import * as React from "react"
import type { GitRemoteInfo } from "@ucch/protocol"
import { GitBranchIcon, Loader2Icon, PlusIcon, SaveIcon, Trash2Icon } from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { ConnectRemoteDialog } from "@/components/git/connect-remote-dialog"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  fetchGitRemote,
  gitConnectRemote,
  gitPush,
  gitRemoveRemote,
  gitSetRemote,
  GitApiError,
} from "@/lib/git-api"
import { looksLikeRepoUrl } from "@/lib/repo-url"

type Load =
  | { state: "loading" }
  | { state: "not-repo" }
  | { state: "error"; message: string }
  | { state: "ready"; remote: GitRemoteInfo }

/**
 * Where the project's `origin` points, on the manage page.
 *
 * Adding a remote goes through the same dialog as the Git view's, because
 * adding one also fetches and joins the histories. Changing the address only
 * repoints `origin` -- nothing is fetched until the next pull or push -- and
 * removing it keeps every local commit.
 */
export function GitRemoteSettings({ hash }: { hash: string }) {
  const [load, setLoad] = React.useState<Load>({ state: "loading" })
  const [url, setUrl] = React.useState("")
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saved, setSaved] = React.useState(false)
  const [connecting, setConnecting] = React.useState(false)
  const [removing, setRemoving] = React.useState(false)

  const show = React.useCallback((remote: GitRemoteInfo) => {
    setLoad({ state: "ready", remote })
    setUrl(remote.url ?? "")
  }, [])

  const refresh = React.useCallback(async () => {
    try {
      show(await fetchGitRemote(hash))
    } catch (e) {
      if (e instanceof GitApiError && e.notRepo) setLoad({ state: "not-repo" })
      else setLoad({ state: "error", message: e instanceof Error ? e.message : "Could not read the remote." })
    }
  }, [hash, show])

  React.useEffect(() => {
    void refresh()
  }, [refresh])

  /** Runs one change, keeping its error beside the control that caused it. */
  async function run<T>(label: string, work: () => Promise<T>): Promise<T | null> {
    setBusy(label)
    setError(null)
    setSaved(false)
    try {
      return await work()
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.")
      return null
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <GitBranchIcon className="text-muted-foreground size-4" />
        Git remote
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Where pull and push go. The account&apos;s GitHub token is used for github.com remotes.
      </p>

      <div className="mt-4 max-w-xl">
        {load.state === "loading" && <Skeleton className="h-9 w-full" />}

        {load.state === "not-repo" && (
          <p className="text-muted-foreground text-sm">This project is not a git repository.</p>
        )}

        {load.state === "error" && (
          <p role="alert" className="text-destructive text-sm">
            {load.message}
          </p>
        )}

        {load.state === "ready" && load.remote.url === null && (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-muted-foreground text-sm">
              No remote yet. Commits stay in this project until one is added.
            </p>
            <Button
              size="sm"
              onClick={() => {
                setError(null)
                setConnecting(true)
              }}
            >
              <PlusIcon />
              Add remote
            </Button>
          </div>
        )}

        {load.state === "ready" && load.remote.url !== null && (
          <RemoteForm
            remote={load.remote}
            url={url}
            busy={busy}
            error={connecting || removing ? null : error}
            saved={saved}
            onUrlChange={(next) => {
              setUrl(next)
              setSaved(false)
            }}
            onSave={async () => {
              const result = await run("Save", () => gitSetRemote(hash, url.trim()))
              if (!result) return
              show(result)
              setSaved(true)
            }}
            onRemove={() => {
              setError(null)
              setRemoving(true)
            }}
          />
        )}
      </div>

      {load.state === "ready" && (
        <ConnectRemoteDialog
          open={connecting}
          status={load.remote.status}
          busy={busy}
          error={error}
          onOpenChange={(open) => {
            setConnecting(open)
            if (!open) void refresh()
          }}
          onConnect={(next) => run("Connect remote", () => gitConnectRemote(hash, next))}
          onPush={() => run("Push", () => gitPush(hash))}
        />
      )}

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        title="Remove the remote?"
        description={
          <>
            <span className="font-mono">origin</span> and its remote-tracking branches are forgotten. Every
            local commit stays, and the repository it pointed at is not touched.
          </>
        }
        confirmLabel="Remove"
        onConfirm={async () => {
          // Thrown rather than returned, so the dialog shows it and stays open.
          show(await gitRemoveRemote(hash))
        }}
      />
    </section>
  )
}

function RemoteForm({
  remote,
  url,
  busy,
  error,
  saved,
  onUrlChange,
  onSave,
  onRemove,
}: {
  remote: GitRemoteInfo
  url: string
  busy: string | null
  error: string | null
  saved: boolean
  onUrlChange(url: string): void
  onSave(): Promise<void>
  onRemove(): void
}) {
  const trimmed = url.trim()
  const changed = trimmed !== remote.url
  const canSave = changed && looksLikeRepoUrl(trimmed) && busy === null
  const { branch, upstream, ahead, behind } = remote.status

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault()
        if (canSave) void onSave()
      }}
    >
      <Field>
        <FieldLabel htmlFor="git-remote-url">
          <span className="font-mono">origin</span> URL
        </FieldLabel>
        <div className="flex gap-2">
          <Input
            id="git-remote-url"
            value={url}
            onChange={(e) => onUrlChange(e.target.value)}
            placeholder="https://github.com/owner/repo.git"
            spellCheck={false}
            autoComplete="off"
            disabled={busy !== null}
          />
          <Button type="submit" disabled={!canSave}>
            {busy === "Save" ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
            Save
          </Button>
        </div>
        <FieldDescription>
          {branch === null
            ? "HEAD is detached."
            : upstream
              ? `${branch} tracks ${upstream}${trackingCounts(ahead, behind)}.`
              : `${branch} does not track a remote branch yet; the next push will set it.`}{" "}
          Changing the URL does not fetch anything.
        </FieldDescription>
        {error && (
          <p role="alert" className="text-destructive text-xs whitespace-pre-wrap">
            {error}
          </p>
        )}
        {saved && !error && <p className="text-success text-xs">Saved.</p>}
      </Field>

      <div className="mt-6 flex flex-wrap items-center justify-between gap-3 rounded-md border border-dashed p-3">
        <p className="text-muted-foreground text-sm">
          Disconnect this project from <span className="font-mono">origin</span>.
        </p>
        <Button type="button" variant="outline" size="sm" disabled={busy !== null} onClick={onRemove}>
          <Trash2Icon />
          Remove remote
        </Button>
      </div>
    </form>
  )
}

function trackingCounts(ahead: number, behind: number): string {
  if (ahead === 0 && behind === 0) return ", up to date"
  const parts = []
  if (ahead > 0) parts.push(`${ahead} ahead`)
  if (behind > 0) parts.push(`${behind} behind`)
  return `, ${parts.join(" and ")}`
}
