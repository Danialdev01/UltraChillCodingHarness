"use client"

import * as React from "react"
import { ArrowRightLeftIcon, BotIcon, BrainIcon, GitForkIcon, KeyRoundIcon, Loader2Icon, PlugIcon, TrashIcon } from "lucide-react"
import type { CredentialPolicy, CredentialSource, ProviderId } from "@ucch/protocol"

import { ProviderSettings } from "@/components/provider-settings"
import { Outcome, useOutcome } from "@/components/settings-outcome"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { NativeSelect } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { readCredentialChoice, storeCredentialChoice } from "@/lib/credential-choice"
import type { Workspace } from "@/lib/session"
import {
  fetchHarnessSettings,
  setAgentSettings,
  setCredentialPolicy,
  setWorkspaceCredential,
  type WorkspaceHarnessSettings as HarnessSettings,
} from "@/lib/workspace-api"
import { cn } from "@/lib/utils"

const POLICIES: { id: CredentialPolicy; title: string; blurb: string }[] = [
  {
    id: "member",
    title: "Each member's own subscription",
    blurb: "Turns run on the Claude Code, Codex or OpenRouter login of whoever started the session.",
  },
  {
    id: "workspace",
    title: "The workspace's dedicated subscription",
    blurb: "Every member's turns run on the credentials below. Members need no login of their own.",
  },
  {
    id: "either",
    title: "Let members choose",
    blurb: "Whoever starts a session picks their own subscription or the workspace's.",
  },
]

/**
 * Whose harness subscription the workspace's agents run on, and -- for the
 * dedicated one -- the credentials themselves: an OpenRouter key, a Claude
 * token or CLI login, a Codex login. Members can see what is configured;
 * only an owner or admin can change it.
 */
export function WorkspaceHarnessSettings({
  workspace,
  projects,
}: {
  workspace: Workspace
  projects: { id: string; name: string }[]
}) {
  const manages = workspace.permissions.includes("credentials.manage")
  const [settings, setSettings] = React.useState<HarnessSettings | null>(null)
  const [loadError, setLoadError] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetchHarnessSettings(workspace.id).then(setSettings, (e: unknown) =>
      setLoadError(e instanceof Error ? e.message : String(e)),
    )
  }, [workspace.id])

  return (
    <div className="flex flex-col gap-4">
      <PolicySection
        workspaceId={workspace.id}
        settings={settings}
        loadError={loadError}
        manages={manages}
        onChange={setSettings}
      />
      {settings?.credentialPolicy === "either" && <MyChoice workspaceId={workspace.id} />}
      {settings && (
        <AutoHandoffSection workspaceId={workspace.id} settings={settings} manages={manages} onChange={setSettings} />
      )}
      {settings && (
        <IsolatedFanOutSection workspaceId={workspace.id} settings={settings} manages={manages} onChange={setSettings} />
      )}
      {settings && (
        <MemorySection workspaceId={workspace.id} settings={settings} manages={manages} onChange={setSettings} />
      )}
      {settings && (
        <OmpBridgeSection workspaceId={workspace.id} settings={settings} manages={manages} onChange={setSettings} />
      )}
      {settings && settings.credentialPolicy !== "member" && (
        <>
          <OpenRouterSection workspaceId={workspace.id} settings={settings} manages={manages} onChange={setSettings} />
          <ProviderSettings projects={projects} workspaceId={workspace.id} readOnly={!manages} />
        </>
      )}
    </div>
  )
}

function PolicySection({
  workspaceId,
  settings,
  loadError,
  manages,
  onChange,
}: {
  workspaceId: string
  settings: HarnessSettings | null
  loadError: string | null
  manages: boolean
  onChange: (settings: HarnessSettings) => void
}) {
  const { busy, error, done, run } = useOutcome()
  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <BotIcon className="text-muted-foreground size-4" />
        Harness subscription
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Which Claude Code, Codex or OpenRouter account pays for this workspace&apos;s agent turns.
      </p>
      {loadError && <p className="text-destructive mt-4 text-sm">{loadError}</p>}
      {!settings && !loadError && (
        <div className="mt-4 flex flex-col gap-2">
          {POLICIES.map((p) => (
            <Skeleton key={p.id} className="h-14 w-full max-w-xl" />
          ))}
        </div>
      )}
      {settings && (
        <div role="radiogroup" className="mt-4 flex max-w-xl flex-col gap-2">
          {POLICIES.map((policy) => {
            const selected = settings.credentialPolicy === policy.id
            return (
              <button
                key={policy.id}
                type="button"
                role="radio"
                aria-checked={selected}
                disabled={!manages || busy}
                onClick={() =>
                  void run(async () => {
                    onChange(await setCredentialPolicy(workspaceId, policy.id))
                    return "Saved."
                  })
                }
                className={cn(
                  "rounded-lg border px-4 py-3 text-left transition-colors disabled:cursor-default",
                  selected ? "border-ucch-active bg-ucch-active/5" : "hover:bg-muted/50",
                  !manages && !selected && "text-muted-foreground",
                )}
              >
                <span className="text-sm font-medium">{policy.title}</span>
                <span className="text-muted-foreground mt-0.5 block text-xs">{policy.blurb}</span>
              </button>
            )
          })}
        </div>
      )}
      {!manages && settings && (
        <p className="text-muted-foreground mt-3 text-xs">Only an owner or admin can change this.</p>
      )}
      <Outcome error={error} done={done} />
    </section>
  )
}

function OpenRouterSection({
  workspaceId,
  settings,
  manages,
  onChange,
}: {
  workspaceId: string
  settings: HarnessSettings
  manages: boolean
  onChange: (settings: HarnessSettings) => void
}) {
  const [draft, setDraft] = React.useState("")
  const { busy, error, done, run } = useOutcome()
  const configured = settings.credentials.openrouter

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <KeyRoundIcon className="text-muted-foreground size-4" />
        Workspace OpenRouter key
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Used by the built-in loop for turns on the workspace&apos;s subscription. Stored encrypted and
        never shown again. {configured ? "A key is stored." : "No key is stored."}
      </p>
      {manages && (
        <form
          className="mt-4 flex max-w-xl flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault()
            void run(async () => {
              onChange(await setWorkspaceCredential(workspaceId, "openrouter", draft.trim()))
              setDraft("")
              return "Saved."
            })
          }}
        >
          <Input
            type="password"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            placeholder={configured ? "A key is stored; paste to replace" : "sk-or-…"}
            autoComplete="off"
            spellCheck={false}
            aria-label="Workspace OpenRouter key"
            className="min-w-64 flex-1 font-mono text-sm"
          />
          <Button type="submit" variant="outline" disabled={busy || !draft.trim()}>
            {busy && <Loader2Icon className="animate-spin" />}
            {configured ? "Replace key" : "Save key"}
          </Button>
          {configured && (
            <Button
              type="button"
              variant="outline"
              disabled={busy}
              onClick={() =>
                void run(async () => {
                  onChange(await setWorkspaceCredential(workspaceId, "openrouter", null))
                  return "Removed."
                })
              }
            >
              <TrashIcon />
              Remove
            </Button>
          )}
        </form>
      )}
      <Outcome error={error} done={done} />
    </section>
  )
}

/** Where a limited turn can go on: the agents with a session of their own. */
const FALLBACKS: { id: ProviderId; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
  { id: "omp", label: "Custom" },
]

/**
 * Automatic handoff on a usage limit (solution §5.4): a Claude Code or Codex
 * turn stopped by its plan's limit goes on in a new thread on the fallback,
 * in the same files, asked the same message. Once per thread.
 */
function AutoHandoffSection({
  workspaceId,
  settings,
  manages,
  onChange,
}: {
  workspaceId: string
  settings: HarnessSettings
  manages: boolean
  onChange: (settings: HarnessSettings) => void
}) {
  const { busy, error, done, run } = useOutcome()
  const { enabled, fallbackProvider } = settings.agent.autoHandoff
  const save = (next: { enabled: boolean; fallbackProvider: ProviderId | null }) =>
    void run(async () => {
      onChange(await setAgentSettings(workspaceId, { autoHandoff: next }))
      return "Saved."
    })

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <ArrowRightLeftIcon className="text-muted-foreground size-4" />
        Hand off on a usage limit
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        When a Claude Code or Codex turn stops because its plan&apos;s usage limit is reached, carry the work on in a
        new thread on another agent, in the same files, with the message that was stopped. A brief of the thread is
        written first, on the OpenRouter key. A thread hands off at most once this way.
      </p>
      <div className="mt-4 flex max-w-xl flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={enabled}
            disabled={!manages || busy || (!enabled && !fallbackProvider)}
            onChange={(e) => save({ enabled: e.target.checked, fallbackProvider })}
            aria-label="Hand off on a usage limit"
          />
          On
        </label>
        <div className="w-48">
          <NativeSelect
            id="auto-handoff-fallback"
            value={fallbackProvider ?? ""}
            disabled={!manages || busy}
            onChange={(v) => {
              const next = FALLBACKS.find((f) => f.id === v)?.id ?? null
              save({ enabled: enabled && next !== null, fallbackProvider: next })
            }}
          >
            <option value="">Choose an agent…</option>
            {FALLBACKS.map((f) => (
              <option key={f.id} value={f.id}>
                {f.label}
              </option>
            ))}
          </NativeSelect>
        </div>
      </div>
      {!manages && <p className="text-muted-foreground mt-3 text-xs">Only an owner or admin can change this.</p>}
      <Outcome error={error} done={done} />
    </section>
  )
}

/**
 * Isolated fan-out edits (OMP OM5.5, solution §6.5): an OMP turn's workers
 * may each edit a copy of the files, their changes patched back when they
 * finish. Off by default -- a thread already has a worktree of its own.
 */
function IsolatedFanOutSection({
  workspaceId,
  settings,
  manages,
  onChange,
}: {
  workspaceId: string
  settings: HarnessSettings
  manages: boolean
  onChange: (settings: HarnessSettings) => void
}) {
  const { busy, error, done, run } = useOutcome()
  const { enabled } = settings.agent.isolatedFanOut
  const save = (next: boolean) =>
    void run(async () => {
      onChange(await setAgentSettings(workspaceId, { isolatedFanOut: { enabled: next } }))
      return "Saved."
    })

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <GitForkIcon className="text-muted-foreground size-4" />
        Isolated parallel edits
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Lets a Custom turn give each of its parallel workers its own copy of the files to edit. When a worker
        finishes, its changes are applied back to the thread&apos;s files as a patch. A worker whose changes clash
        with another&apos;s shows as failed, with its changes left out.
      </p>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!manages || busy}
          onChange={(e) => save(e.target.checked)}
          aria-label="Isolated parallel edits"
        />
        On
      </label>
      {!manages && <p className="text-muted-foreground mt-3 text-xs">Only an owner or admin can change this.</p>}
      <Outcome error={error} done={done} />
    </section>
  )
}

/**
 * mnemopi memory on Custom turns (OMP OM7.1, solution §7): one bank per
 * project, shared by its threads. `llmMode` says whether the bank may use
 * the fast model to extract and match facts, or full-text search only.
 * `retainCliTurns` (OM7.2) feeds Claude Code and Codex turns' answers in.
 */
function MemorySection({
  workspaceId,
  settings,
  manages,
  onChange,
}: {
  workspaceId: string
  settings: HarnessSettings
  manages: boolean
  onChange: (settings: HarnessSettings) => void
}) {
  const { busy, error, done, run } = useOutcome()
  const memory = settings.agent.memory
  const save = (next: typeof memory) =>
    void run(async () => {
      onChange(await setAgentSettings(workspaceId, { memory: next }))
      return "Saved."
    })

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <BrainIcon className="text-muted-foreground size-4" />
        Project memory
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Lets Custom turns remember what they learn about a project, such as its conventions, decisions and pitfalls,
        and recall it in later threads of the same project. Each project has its own memory, kept privately on the
        server rather than in the repository. Where it disagrees with the files or the request, those win.
      </p>
      <p className="text-warning mt-2 max-w-prose text-sm">
        Never ask an agent to remember secrets: memory is stored as plain text and recalled into later turns.
      </p>
      <div className="mt-4 flex max-w-xl flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={memory.enabled}
            disabled={!manages || busy}
            onChange={(e) => save({ ...memory, enabled: e.target.checked })}
            aria-label="Project memory"
          />
          On
        </label>
        <div className="w-72">
          <NativeSelect
            id="memory-llm-mode"
            value={memory.llmMode}
            disabled={!manages || busy}
            onChange={(v) => save({ ...memory, llmMode: v === "none" ? "none" : "smol" })}
          >
            <option value="smol">Use the fast model to sort facts</option>
            <option value="none">Text search only (no model calls)</option>
          </NativeSelect>
        </div>
      </div>
      <label className="mt-3 flex max-w-prose items-start gap-2 text-sm">
        <input
          type="checkbox"
          className="mt-1"
          checked={memory.retainCliTurns}
          disabled={!manages || busy || !memory.enabled}
          onChange={(e) => save({ ...memory, retainCliTurns: e.target.checked })}
          aria-label="Remember from Claude Code and Codex turns"
        />
        <span>
          Remember from Claude Code and Codex turns too. After each of their turns, the fast model reads the
          turn&apos;s final answer, never its tool output, and keeps any lasting fact. Billed to the OpenRouter key.
          With the OMP tools on, those turns can also search and add to the memory themselves.
        </span>
      </label>
      {!manages && <p className="text-muted-foreground mt-3 text-xs">Only an owner or admin can change this.</p>}
      <Outcome error={error} done={done} />
    </section>
  )
}

/**
 * The OMP bridge (OMP OM6.4–OM6.5, solution §10): Claude Code and Codex
 * turns are offered OMP's tools as an MCP server. Each call is billed to the OpenRouter key
 * the Custom provider uses; without one, turns run without the tools.
 */
function OmpBridgeSection({
  workspaceId,
  settings,
  manages,
  onChange,
}: {
  workspaceId: string
  settings: HarnessSettings
  manages: boolean
  onChange: (settings: HarnessSettings) => void
}) {
  const { busy, error, done, run } = useOutcome()
  const { enabled } = settings.agent.ompBridge
  const save = (next: boolean) =>
    void run(async () => {
      onChange(await setAgentSettings(workspaceId, { ompBridge: { enabled: next } }))
      return "Saved."
    })

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <PlugIcon className="text-muted-foreground size-4" />
        OMP tools for Claude Code &amp; Codex
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Gives Claude Code and Codex turns the Custom agent&apos;s tools: subagents that explore and report back, symbol-aware
        navigation and renames, codemods across many files, and a second-opinion review. Each call is billed to the
        OpenRouter key Custom turns use; with no key, turns run without these tools. In Claude Code under Normal
        permissions the read-only tools run unasked and the rest ask first. Codex runs them without asking, as it
        runs its own commands.
      </p>
      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={enabled}
          disabled={!manages || busy}
          onChange={(e) => save(e.target.checked)}
          aria-label="OMP tools for Claude Code and Codex"
        />
        On
      </label>
      {!manages && <p className="text-muted-foreground mt-3 text-xs">Only an owner or admin can change this.</p>}
      <Outcome error={error} done={done} />
    </section>
  )
}

/** Under `either`: which subscription the sessions you start here run on. */
function MyChoice({ workspaceId }: { workspaceId: string }) {
  const [choice, setChoice] = React.useState<CredentialSource>("member")
  React.useEffect(() => setChoice(readCredentialChoice(workspaceId) ?? "member"), [workspaceId])

  return (
    <section className="rounded-lg border p-6">
      <h2 className="text-sm font-medium">Your new sessions</h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        Which subscription the sessions you start in this workspace run on. Each one keeps the
        subscription it started with.
      </p>
      <div className="mt-4 max-w-xs">
        <NativeSelect
          id="credential-choice"
          value={choice}
          onChange={(v) => {
            const next = v === "workspace" ? "workspace" : "member"
            setChoice(next)
            storeCredentialChoice(workspaceId, next)
          }}
        >
          <option value="member">My own subscription</option>
          <option value="workspace">The workspace&apos;s subscription</option>
        </NativeSelect>
      </div>
    </section>
  )
}
