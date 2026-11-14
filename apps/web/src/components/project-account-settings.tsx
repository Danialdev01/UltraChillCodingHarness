"use client"

import * as React from "react"
import { UserRoundCogIcon } from "lucide-react"

import { useAccounts } from "@/components/provider-picker"
import { Skeleton } from "@/components/ui/skeleton"
import {
  accountStatus,
  fetchProjectAccounts,
  saveProjectDefaultAccount,
  saveProjectRequiredContext,
  type AccountContext,
  type AccountProvider,
  type ProjectAccounts,
} from "@/lib/providers-api"
import type { Project } from "@/lib/session"
import { SettingsSection } from "@/components/layout/settings-section"

const PROVIDERS: { id: AccountProvider; label: string }[] = [
  { id: "claude", label: "Claude Code" },
  { id: "codex", label: "Codex" },
]

/**
 * Which subscription account this project's sessions run on: your own
 * default per provider (a new session starts there; the session header can
 * move it), and -- set by a workspace admin -- the one context it accepts,
 * so a work project never quietly bills a personal plan.
 */
export function ProjectAccountSettings({ project }: { project: Project }) {
  const { accounts } = useAccounts()
  const [settings, setSettings] = React.useState<ProjectAccounts | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  const [saving, setSaving] = React.useState(false)

  React.useEffect(() => {
    let live = true
    fetchProjectAccounts(project.hash).then(
      (value) => live && setSettings(value),
      (e: unknown) => live && setError(e instanceof Error ? e.message : "Could not load the project's accounts."),
    )
    return () => {
      live = false
    }
  }, [project.hash])

  async function save(run: () => Promise<void>, next: (current: ProjectAccounts) => ProjectAccounts) {
    setSaving(true)
    setError(null)
    try {
      await run()
      setSettings((current) => (current ? next(current) : current))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setSaving(false)
    }
  }

  const loaded = settings && accounts

  return (
    <div className="flex flex-col gap-4">
      <SettingsSection
        icon={UserRoundCogIcon}
        title="Subscription accounts"
        description={
          <>
            The Claude Code or Codex account your new sessions here start on. A running session can be moved to
            another account from the harness picker in its composer; the harness never moves it by itself.
          </>
        }
      >
        {!loaded ? (
          <div className="flex flex-col gap-3" aria-hidden>
            <Skeleton className="h-8 w-80" />
            <Skeleton className="h-8 w-80" />
            <Skeleton className="h-8 w-64" />
          </div>
        ) : (
          <div className="flex flex-col gap-3">
            {PROVIDERS.map((provider) => {
              const own = accounts.filter((a) => a.provider === provider.id)
              const chosen = settings.defaults[provider.id] ?? ""
              return (
                <label key={provider.id} className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="w-28">{provider.label}</span>
                  <select
                    value={chosen}
                    disabled={saving || own.length === 0}
                    onChange={(e) => {
                      const id = e.target.value || null
                      void save(
                        () => saveProjectDefaultAccount(project.hash, provider.id, id),
                        (current) => {
                          const defaults = { ...current.defaults }
                          if (id) defaults[provider.id] = id
                          else delete defaults[provider.id]
                          return { ...current, defaults }
                        },
                      )
                    }}
                    className="border-input bg-background h-8 min-w-56 rounded-md border px-2 text-sm"
                  >
                    <option value="">Default account</option>
                    {own
                      .filter((a) => !a.isDefault)
                      .map((a) => (
                        <option
                          key={a.id}
                          value={a.id}
                          disabled={Boolean(settings.requiredContext && a.context !== settings.requiredContext)}
                        >
                          {a.label} ({a.context}, {accountStatus(a).label.toLowerCase()})
                        </option>
                      ))}
                  </select>
                </label>
              )
            })}

            <label className="flex flex-wrap items-center gap-2 text-sm">
              <span className="w-28">Runs only on</span>
              <select
                value={settings.requiredContext ?? ""}
                disabled={saving || !settings.canManage}
                title={settings.canManage ? undefined : "Only a workspace admin can change this"}
                onChange={(e) => {
                  const context = (e.target.value || null) as AccountContext | null
                  void save(
                    () => saveProjectRequiredContext(project.hash, context),
                    (current) => ({ ...current, requiredContext: context }),
                  )
                }}
                className="border-input bg-background h-8 min-w-56 rounded-md border px-2 text-sm"
              >
                <option value="">Any account</option>
                <option value="work">Work accounts</option>
                <option value="personal">Personal accounts</option>
              </select>
            </label>
            <p className="text-muted-foreground max-w-prose text-xs">
              A turn on an account with the wrong tag fails with a message saying so, rather than billing it.
            </p>
          </div>
        )}
        {error && <p className="text-destructive mt-3 text-sm">{error}</p>}
      </SettingsSection>
    </div>
  )
}
