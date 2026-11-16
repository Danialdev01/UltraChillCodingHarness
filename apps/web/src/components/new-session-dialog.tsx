"use client"

import * as React from "react"
import { CpuIcon, FolderIcon, GitBranchIcon, GitForkIcon } from "lucide-react"

import { FOCUS, FormDialog, FormDialogFooter, FormField, PopoverSelect } from "@/components/form-dialog"
import { HarnessIcon } from "@/components/harness-icon"
import { BranchPicker } from "@/components/new-project-dialog"
import { useProviders } from "@/components/provider-picker"
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
        // The project's base branch (Project Settings), not whatever the
        // checkout happens to be on.
        const base = project.defaultBranch
        setBranch(base && names.includes(base) ? base : (list.current ?? names[0] ?? ""))
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
  }, [open, project.hash, project.defaultBranch])

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

  const ready = Boolean(branch && client)
  const anyBlocked = Boolean(cards) && HARNESS_CHOICES.some((id) => !cards![id] || providerBlocker(cards![id]))

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
        <FormDialogFooter busy={pending} disabled={!ready} hint="Forks a new branch from the base" hintIcon={GitForkIcon}>
          {pending ? "Starting…" : "Start session"}
        </FormDialogFooter>
      }
    >
      {projects && projects.length > 1 && (
        <FormField label="Project" labelId="new-session-project-label">
          <PopoverSelect
            value={project.id}
            options={projects.map((p) => ({ value: p.id, label: p.name }))}
            onChange={setProjectId}
            heading="Projects"
            icon={FolderIcon}
            disabled={pending}
            labelledBy="new-session-project-label"
            searchable={projects.length > 8}
          />
        </FormField>
      )}

      <FormField
        label="Harness"
        labelId="new-session-harness-label"
        aside={
          anyBlocked && (
            <TransitionLink
              href={settingsPageHref("providers")}
              className={cn("rounded-[4px] text-[11px] text-(--fd-text-muted) hover:text-(--fd-text)", FOCUS)}
            >
              Set up in Settings
            </TransitionLink>
          )
        }
      >
        <HarnessCards cards={cards} value={provider} onChange={setProvider} disabled={pending} />
      </FormField>

      {models.length > 0 && (
        <FormField label="Model" labelId="new-session-model-label">
          <PopoverSelect
            value={model}
            options={models.map((m) => ({ value: m.id, label: m.name }))}
            onChange={setModel}
            heading="Models"
            icon={CpuIcon}
            disabled={pending}
            labelledBy="new-session-model-label"
            searchable={models.length > 8}
          />
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
 * The harness to start on, as cards side by side in the new project dialog's
 * source-card style: each with its mark and whether it is ready. One that is
 * not says why rather than being left out.
 *
 * A radio group: arrow keys move the choice and the focus together among the
 * ready ones, with only the checked card in the tab order.
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
  const refs = React.useRef<Partial<Record<ProviderId, HTMLButtonElement | null>>>({})
  const rows = HARNESS_CHOICES.map((id) => {
    const card = cards?.[id]
    const blocker = card ? providerBlocker(card) : cards ? "Not available on this server" : null
    return { id, card, blocker, ready: Boolean(card) && !blocker }
  })
  const usable = rows.filter((row) => row.ready).map((row) => row.id)
  // With nothing checked yet, the first usable card is the one Tab reaches.
  const tabStop = value && usable.includes(value) ? value : usable[0]

  function onKeyDown(event: React.KeyboardEvent) {
    const step = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key]
    if (!step || usable.length < 2 || disabled) return
    event.preventDefault()
    const at = Math.max(0, usable.indexOf(tabStop!))
    const next = usable[(at + step + usable.length) % usable.length]!
    onChange(next)
    refs.current[next]?.focus()
  }

  return (
    <div
      role="radiogroup"
      aria-labelledby="new-session-harness-label"
      className="grid gap-1.5"
      style={{ gridTemplateColumns: `repeat(${HARNESS_CHOICES.length}, minmax(0, 1fr))` }}
      onKeyDown={onKeyDown}
    >
      {rows.map(({ id, card, blocker, ready }) => {
        const checked = value === id
        const dim = cards !== null && !ready
        return (
          <button
            key={id}
            ref={(node) => {
              refs.current[id] = node
            }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={id === tabStop ? 0 : -1}
            disabled={disabled || !ready}
            onClick={() => onChange(id)}
            title={dim ? (blocker ?? undefined) : undefined}
            className={cn(
              "flex min-w-0 flex-col items-start gap-[3px] rounded-[8px] border px-2.5 py-2 text-left transition-[border-color,box-shadow,background-color] disabled:cursor-not-allowed",
              FOCUS,
              checked
                ? "border-(--fd-accent) bg-(--fd-accent-tint) ring-[3px] ring-(--fd-ring-soft)"
                : "border-(--fd-border) bg-(--fd-field) enabled:hover:border-(--fd-border-hover)",
              dim && "border-dashed bg-(--fd-field-muted)",
            )}
          >
            <span className="flex min-w-0 max-w-full items-center gap-1.5">
              <span className={cn("shrink-0", dim && "opacity-50")}>
                <HarnessIcon harness={id} size={14} />
              </span>
              <span className={cn("truncate text-[12px] font-medium", dim ? "text-(--fd-text-muted)" : "text-(--fd-text)")}>
                {getHarness(id).name}
              </span>
            </span>
            {cards === null ? (
              <Skeleton className="my-[2px] h-2.5 w-20" />
            ) : (
              <span className="max-w-full truncate text-[11px] text-(--fd-text-muted)">
                {ready ? readyLabel(card!) : blocker}
              </span>
            )}
          </button>
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
