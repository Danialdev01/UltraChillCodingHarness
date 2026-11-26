"use client"

import * as React from "react"
import { FRAMEWORK_LABELS, type FrameworkId, type FrameworkOptions } from "@ucch/protocol/plain"
import { BoxesIcon, WandSparklesIcon, XIcon } from "lucide-react"

import { FrameworkOptionsFields, FrameworkPicker, FrameworkSummary, type FrameworkPick } from "@/components/framework-options"
import { SettingsSection } from "@/components/layout/settings-section"
import { Button } from "@/components/ui/button"
import { Skeleton } from "@/components/ui/skeleton"
import { useCachedState } from "@/lib/queries/cached-state"
import { projectQueries } from "@/lib/queries/project-data"
import { useRealtime } from "@/lib/realtime"
import type { Project } from "@/lib/session"

/** Sends `project.framework_set`; the server applies it to `.agent/` and every page refetches. */
function useSetFramework(projectId: string) {
  const { client } = useRealtime()
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const send = async (framework: { id: FrameworkId; options: FrameworkOptions } | null): Promise<boolean> => {
    if (!client) return false
    setPending(true)
    setError(null)
    try {
      await client.dispatch({ type: "project.framework_set", projectId, framework })
      return true
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change the framework.")
      return false
    } finally {
      setPending(false)
    }
  }
  return { send, pending, error }
}

/**
 * The project's framework on the Environment tab (plan3 §4.5): the tile and
 * its options, the same fields as the New Project dialog. Saving re-applies
 * the profile additively: buttons and selections the old one wrote and
 * nobody edited follow the change; everything edited by hand stays.
 */
export function FrameworkSettings({ project }: { project: Project }) {
  const query = projectQueries.framework(project.hash)
  const [data, , refetch, { error }] = useCachedState(query.queryKey, query.queryFn, { persist: query.persist })
  const [pick, setPick] = React.useState<FrameworkPick>(null)
  const [options, setOptions] = React.useState<FrameworkOptions>({})
  const [dirty, setDirty] = React.useState(false)
  const { send, pending, error: sendError } = useSetFramework(project.id)

  // The saved choice, until someone starts changing it.
  React.useEffect(() => {
    if (!data || dirty) return
    setPick(data.framework)
    setOptions(data.options)
  }, [data, dirty])

  if (!data) {
    return error ? (
      <p role="alert" className="text-destructive text-sm">
        {error.message}
      </p>
    ) : (
      <FrameworkSettingsSkeleton />
    )
  }

  const chosen = pick && pick !== "other" ? pick : null
  const canChange = data.canChange && !pending

  return (
    <SettingsSection
      icon={BoxesIcon}
      title="Framework"
      description={
        <>
          What the project is built with: it picks the runtimes, adds command buttons, sets the preview port and tells the agents the
          framework&apos;s own commands. Kept in <code className="font-mono">.agent/framework.json</code>.
        </>
      }
      bare
    >
      <div className="form-dialog mt-4 flex max-w-2xl flex-col gap-3" data-testid="framework-settings">
        {data.error && (
          <p role="alert" className="text-destructive text-sm">
            {data.error}
          </p>
        )}
        <span id="framework-settings-label" className="sr-only">
          Framework
        </span>
        <FrameworkPicker
          value={chosen}
          allowOther={false}
          disabled={!canChange}
          labelledBy="framework-settings-label"
          onChange={(next) => {
            setDirty(true)
            setPick(next)
            if (next !== data.framework) setOptions({})
            else setOptions(data.options)
          }}
        />
        {chosen && (
          <>
            <FrameworkOptionsFields
              id={chosen}
              values={options}
              onChange={(next) => {
                setDirty(true)
                setOptions(next)
              }}
              source="repo"
              disabled={!canChange}
              idPrefix="framework-settings"
            />
            <FrameworkSummary id={chosen} values={options} fromRepo />
          </>
        )}
        {Object.keys(data.overrides).length > 0 && (
          <p className="text-muted-foreground text-xs">
            The repository decides: {Object.entries(data.overrides).map(([id, why]) => `${id} ${why}`).join("; ")}.
          </p>
        )}
        {data.canChange ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              size="sm"
              disabled={!dirty || !chosen || pending}
              onClick={async () => {
                if (!chosen) return
                if (await send({ id: chosen, options })) {
                  setDirty(false)
                  void refetch()
                }
              }}
            >
              {data.framework ? "Apply changes" : `Set up for ${chosen ? FRAMEWORK_LABELS[chosen] : "a framework"}`}
            </Button>
            {dirty && (
              <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDirty(false)}>
                Cancel
              </Button>
            )}
          </div>
        ) : (
          <p className="text-muted-foreground text-xs">Only members who can change the project can change its framework.</p>
        )}
        {sendError && (
          <p role="alert" className="text-destructive text-sm">
            {sendError}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}

export function FrameworkSettingsSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <Skeleton className="h-5 w-28" />
      <Skeleton className="h-4 w-96 max-w-full" />
      <div className="grid max-w-2xl grid-cols-2 gap-1.5 sm:grid-cols-3">
        {[0, 1, 2, 3, 4].map((i) => (
          <Skeleton key={i} className="h-[46px] rounded-[8px]" />
        ))}
      </div>
    </div>
  )
}

/**
 * "This looks like Laravel. Set it up?" (plan3 §3.7), on the project page
 * while the project has no framework.json and its stack matches a profile.
 * Accepting applies the profile at its defaults, with the repository's own
 * requirements winning; dismissing records that, so it is not asked again.
 */
export function FrameworkSuggestion({ project }: { project: Project }) {
  const query = projectQueries.framework(project.hash)
  const [data, setData] = useCachedState(query.queryKey, query.queryFn, { persist: query.persist })
  const { send, pending, error } = useSetFramework(project.id)
  if (!data?.suggested || !data.canChange) return null
  const suggested = data.suggested
  return (
    <div
      role="status"
      data-testid="framework-suggestion"
      className="bg-muted/50 flex flex-wrap items-center gap-2 border-b px-3 py-2 text-sm"
    >
      <WandSparklesIcon className="text-muted-foreground size-4 shrink-0" />
      <span className="min-w-0 grow">
        This looks like a {FRAMEWORK_LABELS[suggested]} project. Set up its runtime, command buttons and preview?
        {error && <span className="text-destructive"> {error}</span>}
      </span>
      <Button
        size="sm"
        disabled={pending}
        onClick={async () => {
          if (await send({ id: suggested, options: {} })) setData({ ...data, suggested: null, framework: suggested })
        }}
      >
        Optimize for {FRAMEWORK_LABELS[suggested]}
      </Button>
      <Button
        size="icon-sm"
        variant="ghost"
        aria-label="Not now, and do not ask again"
        disabled={pending}
        onClick={async () => {
          if (await send(null)) setData({ ...data, suggested: null, dismissed: true })
        }}
      >
        <XIcon />
      </Button>
    </div>
  )
}
