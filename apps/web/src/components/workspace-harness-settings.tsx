"use client"

import * as React from "react"
import { BotIcon, KeyRoundIcon, Loader2Icon, TrashIcon } from "lucide-react"
import type { CredentialPolicy, CredentialSource } from "@ucch/protocol"

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
