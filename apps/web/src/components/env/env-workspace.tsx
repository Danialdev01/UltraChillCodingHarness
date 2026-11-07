"use client"

import * as React from "react"
import {
  CheckIcon,
  CopyIcon,
  ExternalLinkIcon,
  EyeIcon,
  EyeOffIcon,
  KeyRoundIcon,
  Loader2Icon,
  LockIcon,
  LockOpenIcon,
  PencilIcon,
  PlusIcon,
  ShieldIcon,
  Trash2Icon,
  VariableIcon,
} from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { EnvVarDialog, type EnvVarDialogState } from "@/components/env/env-var-dialog"
import { UnlockDialog } from "@/components/env/unlock-dialog"
import { KeysRowsSkeleton } from "@/components/page-skeletons"
import { Button } from "@/components/ui/button"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import { copyText } from "@/lib/clipboard"
import {
  createEnvVar,
  deleteEnvVar,
  isWrongKey,
  revealEnvVar,
  updateEnvVar,
  type EnvVar,
  type EnvVarInput,
} from "@/lib/env-api"
import { lockProject, takeKey, useProjectUnlocked } from "@/lib/project-key-store"
import { useLiveResource } from "@/lib/realtime"
import type { Project } from "@/lib/session"
import { projectPageHref } from "@/lib/sections"
import { useCachedState } from "@/lib/queries/cached-state"
import { projectQueries } from "@/lib/queries/project-data"
import { TransitionLink } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/** A shown value hides itself again after this long, in case the tab is left open. */
const REVEAL_MS = 30_000

/**
 * The key for a call that needs one: the unlocked key, or an error that
 * sends the person back to the unlock prompt. A wrong key -- changed in
 * another tab -- locks this one.
 */
async function withKey<T>(hash: string, work: (key: string) => Promise<T>): Promise<T> {
  const key = takeKey(hash)
  if (!key) throw new Error("Locked. Unlock with the project key first.")
  try {
    return await work(key)
  } catch (error) {
    if (isWrongKey(error)) lockProject(hash)
    throw error
  }
}

/**
 * A project's environment variables, kept in its `.agent/env.val` with
 * their values encrypted under the project key.
 *
 * Three states. No project key yet: the section is off, and points at
 * Manage, where one is set up. Locked: the names, tags and links show, and
 * nothing else does. Unlocked with the project key: values can be shown,
 * copied, added, changed and removed. The list arrives without values;
 * showing or copying one fetches just that value.
 */
export function EnvWorkspace({ project }: { project: Project }) {
  const ws = useWorkspaceHash()
  // Cached: the names show at once on a return visit, then revalidate.
  const query = projectQueries.env(project.hash)
  const [env, setEnv, reloadEnv, loadState] = useCachedState(query.queryKey, query.queryFn, {
    persist: query.persist,
  })
  const unlocked = useProjectUnlocked(project.hash)
  const [error, setError] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<EnvVarDialogState>(null)
  const [deleting, setDeleting] = React.useState<EnvVar | null>(null)
  const [unlocking, setUnlocking] = React.useState(false)
  const [busy, setBusy] = React.useState(false)

  const reload = React.useCallback(() => void reloadEnv(), [reloadEnv])
  React.useEffect(() => {
    setError(loadState.error ? loadState.error.message : null)
  }, [loadState.error])
  // Added, changed or removed in another tab, or the key set up or changed.
  useLiveResource("keys", reload, project.id)

  const vars = env?.vars ?? null
  const setVars = (update: (current: EnvVar[]) => EnvVar[]) =>
    setEnv((current) => ({ configured: current?.configured ?? true, vars: update(current?.vars ?? []) }))

  async function save(input: Partial<EnvVarInput>) {
    setBusy(true)
    try {
      if (dialog?.mode === "edit") {
        const id = dialog.variable.id
        const updated = await withKey(project.hash, (key) => updateEnvVar(project.hash, key, id, input))
        setVars((current) => current.map((v) => (v.id === updated.id ? updated : v)))
      } else {
        const created = await withKey(project.hash, (key) => createEnvVar(project.hash, key, input as EnvVarInput))
        setVars((current) => [...current, created])
      }
      setDialog(null)
    } finally {
      setBusy(false)
    }
  }

  async function remove(variable: EnvVar) {
    await withKey(project.hash, (key) => deleteEnvVar(project.hash, key, variable.id))
    setVars((current) => current.filter((v) => v.id !== variable.id))
  }

  const manageHref = `${projectPageHref(ws, project.hash, "manage")}?tab=project-key`

  if (env && !env.configured) {
    return (
      <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm">
        <ShieldIcon className="size-8 opacity-50" />
        <p className="text-foreground font-medium">Set up a project key to enable environment variables</p>
        <p className="max-w-sm">
          Values are encrypted with the project key and kept in <code>.agent/env.val</code>. Nobody
          can read them without it, including the agents.
        </p>
        <Button size="sm" render={<TransitionLink href={manageHref} />} nativeButton={false}>
          <KeyRoundIcon data-icon="inline-start" />
          Set up a project key
        </Button>
      </div>
    )
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <VariableIcon className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">Environment Variables</span>
        {vars && (
          <span className="text-muted-foreground text-xs">
            · {vars.length} {vars.length === 1 ? "variable" : "variables"}
          </span>
        )}
        <div className="flex-1" />
        {env &&
          (unlocked ? (
            <>
              <Button size="sm" variant="ghost" onClick={() => lockProject(project.hash)}>
                <LockIcon data-icon="inline-start" />
                Lock
              </Button>
              <Button size="sm" onClick={() => setDialog({ mode: "create" })}>
                <PlusIcon data-icon="inline-start" />
                Add variable
              </Button>
            </>
          ) : (
            <Button size="sm" onClick={() => setUnlocking(true)}>
              <LockOpenIcon data-icon="inline-start" />
              Unlock
            </Button>
          ))}
      </div>

      {error && (
        <p role="alert" className="text-destructive border-b px-4 py-2 text-xs">
          {error}
        </p>
      )}

      {vars === null ? (
        <KeysRowsSkeleton />
      ) : vars.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm">
          <VariableIcon className="size-8 opacity-50" />
          <p className="max-w-sm">
            No environment variables yet. Save API keys and env values here, encrypted with the
            project key.
          </p>
          {unlocked ? (
            <Button variant="outline" size="sm" onClick={() => setDialog({ mode: "create" })}>
              <PlusIcon data-icon="inline-start" />
              Add the first variable
            </Button>
          ) : (
            <Button variant="outline" size="sm" onClick={() => setUnlocking(true)}>
              <LockOpenIcon data-icon="inline-start" />
              Unlock to add one
            </Button>
          )}
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>URL</TableHead>
                <TableHead className="w-0 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {vars.map((variable) => (
                <TableRow key={variable.id}>
                  <TableCell className="pl-4 font-mono text-xs font-medium">{variable.name}</TableCell>
                  <TableCell>
                    {unlocked ? (
                      <SecretCell projectHash={project.hash} varId={variable.id} version={variable.updatedAt} />
                    ) : (
                      <span className="text-muted-foreground inline-flex items-center gap-1 text-xs">
                        <LockIcon className="size-3" />
                        Locked
                      </span>
                    )}
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {variable.tags.map((tag) => (
                        <span
                          key={tag}
                          className="bg-muted text-muted-foreground rounded-md px-1.5 py-0.5 text-xs"
                        >
                          {tag}
                        </span>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="max-w-64">
                    {variable.url && (
                      <a
                        href={variable.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground inline-flex max-w-full items-center gap-1 text-xs underline-offset-4 hover:underline"
                        title={variable.url}
                      >
                        <span className="truncate">{displayUrl(variable.url)}</span>
                        <ExternalLinkIcon className="size-3 shrink-0" />
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="pr-4">
                    {unlocked && (
                      <div className="flex items-center justify-end gap-0.5">
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Edit ${variable.name}`}
                          title="Edit"
                          onClick={() => setDialog({ mode: "edit", variable })}
                        >
                          <PencilIcon />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon-sm"
                          aria-label={`Delete ${variable.name}`}
                          title="Delete"
                          onClick={() => setDeleting(variable)}
                        >
                          <Trash2Icon />
                        </Button>
                      </div>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <EnvVarDialog state={dialog} busy={busy} onClose={() => setDialog(null)} onSave={save} />
      <UnlockDialog projectHash={project.hash} open={unlocking} onOpenChange={setUnlocking} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "variable"}?`}
        description="The saved value is gone for good. If it cannot be generated again where it was issued, copy it somewhere first."
        onConfirm={async () => {
          if (deleting) await remove(deleting)
          setDeleting(null)
        }}
      />
    </div>
  )
}

/**
 * The Value column: dots until asked, then the value, with a copy button
 * that works either way.
 *
 * The value is fetched on the first show or copy and dropped when hidden, so
 * the page holds no plaintext it is not showing. `version` is the key's
 * `updatedAt`: a new value saved through the dialog discards the old one.
 * Locking unmounts the cell, and the value with it.
 */
function SecretCell({
  projectHash,
  varId,
  version,
}: {
  projectHash: string
  varId: string
  version: string
}) {
  const [value, setValue] = React.useState<string | null>(null)
  const [shown, setShown] = React.useState(false)
  const [loading, setLoading] = React.useState(false)
  const [copied, setCopied] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    setValue(null)
    setShown(false)
  }, [version])

  React.useEffect(() => {
    if (!shown) return
    const timer = setTimeout(() => {
      setShown(false)
      setValue(null)
    }, REVEAL_MS)
    return () => clearTimeout(timer)
  }, [shown])

  React.useEffect(() => {
    if (!copied) return
    const timer = setTimeout(() => setCopied(false), 1500)
    return () => clearTimeout(timer)
  }, [copied])

  async function fetchValue(): Promise<string | null> {
    if (value !== null) return value
    setLoading(true)
    try {
      const fetched = await withKey(projectHash, (key) => revealEnvVar(projectHash, key, varId))
      setError(null)
      return fetched
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      return null
    } finally {
      setLoading(false)
    }
  }

  async function toggle() {
    if (shown) {
      setShown(false)
      setValue(null)
      return
    }
    const fetched = await fetchValue()
    if (fetched === null) return
    setValue(fetched)
    setShown(true)
  }

  async function copy() {
    const fetched = await fetchValue()
    if (fetched === null) return
    if (await copyText(fetched)) setCopied(true)
    else setError("Could not copy to the clipboard.")
  }

  return (
    <div className="flex min-w-0 items-center gap-1">
      <code
        className="bg-muted/50 min-w-0 max-w-80 truncate rounded px-1.5 py-0.5 font-mono text-xs"
        title={error ?? undefined}
      >
        {shown && value !== null ? value : "••••••••••••••••"}
      </code>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={toggle}
        disabled={loading}
        aria-label={shown ? "Hide value" : "Show value"}
        title={shown ? "Hide" : "Show"}
      >
        {loading ? <Loader2Icon className="animate-spin" /> : shown ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={copy}
        disabled={loading}
        aria-label="Copy value"
        title={copied ? "Copied" : "Copy"}
      >
        {copied ? <CheckIcon className="text-success" /> : <CopyIcon />}
      </Button>
      {error && (
        <span role="alert" className="text-destructive truncate text-xs">
          {error}
        </span>
      )}
    </div>
  )
}

/** The URL without its scheme, for a narrow column. */
function displayUrl(url: string): string {
  return url.replace(/^https?:\/\//i, "").replace(/\/$/, "")
}
