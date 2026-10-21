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
  PencilIcon,
  PlusIcon,
  Trash2Icon,
} from "lucide-react"

import { ConfirmDialog } from "@/components/confirm-dialog"
import { KeyDialog, type KeyDialogState } from "@/components/keys/key-dialog"
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
  createProjectKey,
  deleteProjectKey,
  revealProjectKey,
  updateProjectKey,
  type ProjectKey,
  type ProjectKeyInput,
} from "@/lib/keys-api"
import { useLiveResource } from "@/lib/realtime"
import type { Project } from "@/lib/session"
import { useCachedState } from "@/lib/queries/cached-state"
import { projectQueries } from "@/lib/queries/project-data"

/** A shown value hides itself again after this long, in case the tab is left open. */
const REVEAL_MS = 30_000

/**
 * A project's saved keys: API keys and env values a provider shows once and
 * never again, kept here so they can be handed back.
 *
 * The list arrives without values. Showing or copying one fetches just that
 * value, and a shown value is forgotten again when it is hidden.
 */
export function KeysWorkspace({ project }: { project: Project }) {
  // Cached: the keys show at once on a return visit, then revalidate.
  const query = projectQueries.keys(project.hash)
  const [keys, setKeys, reloadKeys, loadState] = useCachedState(query.queryKey, query.queryFn, {
    persist: query.persist,
  })
  const [error, setError] = React.useState<string | null>(null)
  const [dialog, setDialog] = React.useState<KeyDialogState>(null)
  const [deleting, setDeleting] = React.useState<ProjectKey | null>(null)
  const [busy, setBusy] = React.useState(false)

  const reload = React.useCallback(() => void reloadKeys(), [reloadKeys])
  React.useEffect(() => {
    setError(loadState.error ? loadState.error.message : null)
  }, [loadState.error])
  // Added, changed or removed in another tab.
  useLiveResource("keys", reload, project.id)

  async function save(input: Partial<ProjectKeyInput>) {
    setBusy(true)
    try {
      if (dialog?.mode === "edit") {
        const updated = await updateProjectKey(project.hash, dialog.key.id, input)
        setKeys((current) => (current ?? []).map((k) => (k.id === updated.id ? updated : k)))
      } else {
        const created = await createProjectKey(project.hash, input as ProjectKeyInput)
        setKeys((current) => [...(current ?? []), created])
      }
      setDialog(null)
    } finally {
      setBusy(false)
    }
  }

  async function remove(key: ProjectKey) {
    await deleteProjectKey(project.hash, key.id)
    setKeys((current) => (current ?? []).filter((k) => k.id !== key.id))
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b pr-2 pl-4">
        <KeyRoundIcon className="text-muted-foreground size-4" />
        <span className="text-sm font-medium">Keys</span>
        {keys && (
          <span className="text-muted-foreground text-xs">
            · {keys.length} {keys.length === 1 ? "key" : "keys"}
          </span>
        )}
        <div className="flex-1" />
        <Button size="sm" onClick={() => setDialog({ mode: "create" })} disabled={keys === null}>
          <PlusIcon data-icon="inline-start" />
          Add key
        </Button>
      </div>

      {error && (
        <p role="alert" className="text-destructive border-b px-4 py-2 text-xs">
          {error}
        </p>
      )}

      {keys === null ? <KeysRowsSkeleton /> : keys.length === 0 ? (
        <div className="text-muted-foreground flex flex-1 flex-col items-center justify-center gap-3 p-8 text-center text-sm">
          <KeyRoundIcon className="size-8 opacity-50" />
          <p className="max-w-sm">
            No keys yet. Save API keys and env values here that cannot be shown again where they
            were issued.
          </p>
          <Button variant="outline" size="sm" onClick={() => setDialog({ mode: "create" })}>
            <PlusIcon data-icon="inline-start" />
            Add the first key
          </Button>
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Name</TableHead>
                <TableHead>Password</TableHead>
                <TableHead>Tags</TableHead>
                <TableHead>URL</TableHead>
                <TableHead className="w-0 pr-4">
                  <span className="sr-only">Actions</span>
                </TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {keys.map((key) => (
                <TableRow key={key.id}>
                  <TableCell className="pl-4 font-medium">{key.name}</TableCell>
                  <TableCell>
                    <SecretCell projectHash={project.hash} keyId={key.id} version={key.updatedAt} />
                  </TableCell>
                  <TableCell>
                    <div className="flex flex-wrap gap-1">
                      {key.tags.map((tag) => (
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
                    {key.url && (
                      <a
                        href={key.url}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="text-muted-foreground hover:text-foreground inline-flex max-w-full items-center gap-1 text-xs underline-offset-4 hover:underline"
                        title={key.url}
                      >
                        <span className="truncate">{displayUrl(key.url)}</span>
                        <ExternalLinkIcon className="size-3 shrink-0" />
                      </a>
                    )}
                  </TableCell>
                  <TableCell className="pr-4">
                    <div className="flex items-center justify-end gap-0.5">
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Edit ${key.name}`}
                        title="Edit"
                        onClick={() => setDialog({ mode: "edit", key })}
                      >
                        <PencilIcon />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon-sm"
                        aria-label={`Delete ${key.name}`}
                        title="Delete"
                        onClick={() => setDeleting(key)}
                      >
                        <Trash2Icon />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      <KeyDialog state={dialog} busy={busy} onClose={() => setDialog(null)} onSave={save} />

      <ConfirmDialog
        open={deleting !== null}
        onOpenChange={(open) => !open && setDeleting(null)}
        title={`Delete ${deleting?.name ?? "key"}?`}
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
 * The Password column: dots until asked, then the value, with a copy button
 * that works either way.
 *
 * The value is fetched on the first show or copy and dropped when hidden, so
 * the page holds no plaintext it is not showing. `version` is the key's
 * `updatedAt`: a new value saved through the dialog discards the old one.
 */
function SecretCell({
  projectHash,
  keyId,
  version,
}: {
  projectHash: string
  keyId: string
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
      const fetched = await revealProjectKey(projectHash, keyId)
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
        aria-label={shown ? "Hide password" : "Show password"}
        title={shown ? "Hide" : "Show"}
      >
        {loading ? <Loader2Icon className="animate-spin" /> : shown ? <EyeOffIcon /> : <EyeIcon />}
      </Button>
      <Button
        variant="ghost"
        size="icon-xs"
        onClick={copy}
        disabled={loading}
        aria-label="Copy password"
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
