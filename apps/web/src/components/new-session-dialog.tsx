"use client"

import * as React from "react"
import { GitBranchIcon } from "lucide-react"

import { FormDialog, FormDialogFooter, FormField } from "@/components/form-dialog"
import { HarnessIcon } from "@/components/harness-icon"
import { BranchPicker } from "@/components/new-project-dialog"
import { useProviders } from "@/components/provider-picker"
import { NativeSelect } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { fetchGitBranches } from "@/lib/git-api"
import { getHarness } from "@/lib/harnesses"
import { readLastModel, readLastProvider, rememberLastModel, rememberLastProvider } from "@/lib/model-preference"
import { startProjectSession } from "@/lib/project-sessions"
import { providerBlocker, type ProviderCard, type ProviderId } from "@/lib/providers-api"
import { useRealtime, useToast } from "@/lib/realtime"
import { projectHref, settingsPageHref } from "@/lib/sections"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"
import { TransitionLink, useTransitionRouter } from "@/lib/view-transitions"
import { useWorkspaceHash } from "@/lib/workspace-context"

/** The harnesses a new session can start on, in the order the picker shows them. */
const HARNESS_CHOICES: ProviderId[] = ["claude", "codex", "native"]

/** Where the chat keeps the model a project last used with a harness (`project-chat.tsx`). */
const modelKey = (projectId: string, provider: ProviderId) => (provider === "native" ? projectId : `${projectId}:${provider}`)

/**
 * Starts a session in a project, forked from the branch picked here.
 *
 * Every session gets a branch and a worktree of its own (`ucch/{hash}`), so
 * picking the same base for two is fine: they run side by side, each on its
 * own copy. The project's current branch is picked to begin with.
 */
export function NewSessionDialog({
  project: initialProject,
  projects,
  open,
  onOpenChange,
}: {
  project: Project
  /** The workspace's projects, to pick another; absent, the session is in `project`. */
  projects?: readonly Project[]
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [projectId, setProjectId] = React.useState(initialProject.id)
  React.useEffect(() => {
    if (open) setProjectId(initialProject.id)
  }, [open, initialProject.id])
  const project = projects?.find((p) => p.id === projectId) ?? initialProject
  const { cards } = useProviders()
  const [provider, setProvider] = React.useState<ProviderId | null>(null)
  const [model, setModel] = React.useState("")
  const { client } = useRealtime()
  const toast = useToast()
  const router = useTransitionRouter()
  const ws = useWorkspaceHash()
  const [branches, setBranches] = React.useState<string[] | null>(null)
  const [branch, setBranch] = React.useState("")
  const [error, setError] = React.useState<string | null>(null)
  const [pending, setPending] = React.useState(false)

  // Read afresh each time it opens: a branch made since is one to fork from.
  React.useEffect(() => {
    if (!open) return
    let cancelled = false
    setBranches(null)
    setBranch("")
    setError(null)
    fetchGitBranches(project.hash).then(
      (list) => {
        if (cancelled) return
        const names = [...list.local, ...list.remote].map((b) => b.name)
        setBranches(names)
        setBranch(list.current ?? names[0] ?? "")
      },
      (e: unknown) => {
        if (cancelled) return
        setBranches([])
        setError(e instanceof Error ? e.message : "Could not list the project's branches.")
      },
    )
    return () => {
      cancelled = true
    }
  }, [open, project.hash])

  // The harness this project was last used with, else the first one that
  // can take a turn; its model likewise.
  React.useEffect(() => {
    if (!open || !cards) return
    const last = readLastProvider(project.id) as ProviderId | null
    const usable = (id: ProviderId) => cards[id] && !providerBlocker(cards[id])
    const pick = last && HARNESS_CHOICES.includes(last) && usable(last) ? last : (HARNESS_CHOICES.find(usable) ?? null)
    setProvider(pick)
  }, [open, cards, project.id])
  const models = (provider && cards?.[provider]?.models) || []
  React.useEffect(() => {
    if (!provider) return setModel("")
    const remembered = readLastModel(modelKey(project.id, provider))
    setModel(remembered && models.some((m) => m.id === remembered) ? remembered : (models[0]?.id ?? ""))
    // `models` is read off `provider` and `cards`, which are the deps.
  }, [provider, cards, project.id])

  async function submit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!client || !branch || pending) return
    setPending(true)
    setError(null)
    try {
      await client.whenReady()
      // The chat opens on these until its first message binds the thread.
      if (provider) {
        rememberLastProvider(project.id, provider)
        if (model) rememberLastModel(modelKey(project.id, provider), model)
      }
      const session = await startProjectSession(client, project, { baseBranch: branch })
      onOpenChange(false)
      router.push(projectHref(ws, "project", project.hash, session.hash))
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(message)
      toast({ title: "Could not start a session", description: message, tone: "error" })
    } finally {
      setPending(false)
    }
  }

  return (
    <FormDialog
      open={open}
      onOpenChange={onOpenChange}
      busy={pending}
      icon={GitBranchIcon}
      title="New session"
      description={`A conversation of its own in ${project.name}, on its own branch and worktree, running alongside the others.`}
      onSubmit={(event) => void submit(event)}
      footer={
        <FormDialogFooter busy={pending} disabled={!branch || !client} hint="Forks a new branch from the base">
          Start session
        </FormDialogFooter>
      }
    >
      {projects && projects.length > 1 && (
        <FormField label="Project" htmlFor="new-session-project">
          <NativeSelect id="new-session-project" value={project.id} onChange={setProjectId} disabled={pending}>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      )}
      <FormField label="Harness" labelId="new-session-harness-label">
        <HarnessCards cards={cards} value={provider} onChange={setProvider} disabled={pending} />
      </FormField>
      {models.length > 0 && (
        <FormField label="Model" htmlFor="new-session-model">
          <NativeSelect id="new-session-model" value={model} onChange={setModel} disabled={pending}>
            {models.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
          </NativeSelect>
        </FormField>
      )}
      <FormField
        label="Base branch"
        labelId="new-session-branch-label"
        helper="The session gets a new branch of its own, forked from this one. Sessions can share a base."
        error={error}
      >
        <BranchPicker
          branches={branches ?? []}
          value={branch}
          onChange={setBranch}
          disabled={pending}
          loading={branches === null}
          placeholder="This project has no branches yet"
          labelledBy="new-session-branch-label"
        />
      </FormField>
    </FormDialog>
  )
}

/**
 * The harness to start on, as cards: each with its mark and whether it is
 * ready. One that is not says why and links to where that is fixed, rather
 * than being left out.
 */
function HarnessCards({
  cards,
  value,
  onChange,
  disabled,
}: {
  cards: Record<ProviderId, ProviderCard> | null
  value: ProviderId | null
  onChange: (id: ProviderId) => void
  disabled?: boolean
}) {
  return (
    <div role="radiogroup" aria-labelledby="new-session-harness-label" className="grid gap-1.5">
      {HARNESS_CHOICES.map((id) => {
        const card = cards?.[id]
        const blocker = card ? providerBlocker(card) : cards ? "Not available on this server" : null
        const ready = Boolean(card) && !blocker
        const checked = value === id
        return (
          <div
            key={id}
            className={cn(
              "flex items-center gap-2.5 rounded-lg border px-3 py-2",
              checked && "border-primary bg-primary/5",
              !ready && "bg-muted/40",
            )}
          >
            <button
              type="button"
              role="radio"
              aria-checked={checked}
              disabled={disabled || !ready}
              onClick={() => onChange(id)}
              className="focus-visible:ring-ring flex min-w-0 flex-1 items-center gap-2.5 rounded text-left outline-none focus-visible:ring-2 disabled:cursor-not-allowed"
            >
              <HarnessIcon harness={id} size={20} />
              <span className="flex min-w-0 flex-col">
                <span className="text-sm font-medium">{getHarness(id).name}</span>
                {cards === null ? (
                  <Skeleton className="mt-1 h-3 w-32" />
                ) : (
                  <span className="text-muted-foreground truncate text-xs">{ready ? readyLabel(card!) : blocker}</span>
                )}
              </span>
            </button>
            {cards !== null && !ready && (
              <TransitionLink href={settingsPageHref("providers")} className="text-primary shrink-0 text-xs underline-offset-2 hover:underline">
                Settings
              </TransitionLink>
            )}
          </div>
        )
      })}
    </div>
  )
}

function readyLabel(card: ProviderCard): string {
  if (card.id === "native") return "OpenRouter key connected"
  if (card.authMode === "subscription") return "Subscription connected"
  if (card.authMode === "api-key") return "API key connected"
  if (card.authMode === "token") return "Token connected"
  return "Ready"
}
