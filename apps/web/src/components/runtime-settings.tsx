"use client"

import * as React from "react"
import { AlertTriangleIcon, ArrowUpCircleIcon, CheckCircle2Icon, DownloadIcon, Loader2Icon, Trash2Icon, LayersIcon } from "lucide-react"

import { SettingsSection } from "@/components/layout/settings-section"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { NativeSelect } from "@/components/ui/native-select"
import { Skeleton } from "@/components/ui/skeleton"
import { useCachedState } from "@/lib/queries/cached-state"
import { projectQueries } from "@/lib/queries/project-data"
import {
  installRuntime,
  selectRuntime,
  uninstallRuntime,
  type ProjectRuntimeStatus,
  type ProjectRuntimesResponse,
} from "@/lib/runtimes-api"
import type { Project } from "@/lib/session"

/**
 * The project's runtime versions, on the manage page's Runtimes tab: one
 * card per runtime (PHP today), each choosing what `.agent/runtimes.json`
 * says and showing what that resolves to on this server.
 *
 * While an install is downloading the card polls; otherwise it refetches on
 * the server's `resource.changed{runtimes}` like every other cached list.
 */
export function RuntimeSettings({ project }: { project: Project }) {
  const query = projectQueries.runtimes(project.hash)
  const [polling, setPolling] = React.useState(false)
  const [data, setData, , { error }] = useCachedState(query.queryKey, query.queryFn, {
    persist: query.persist,
    refetchInterval: polling ? 1000 : false,
  })
  const busy = Boolean(data?.runtimes.some((r) => r.installing.length > 0))
  React.useEffect(() => setPolling(busy), [busy])

  if (!data) {
    return error ? (
      <p role="alert" className="text-destructive text-sm">
        {error.message}
      </p>
    ) : (
      <RuntimeCardSkeleton />
    )
  }

  return (
    <div className="flex flex-col gap-4">
      {data.error && (
        <p role="alert" className="text-destructive text-sm">
          {data.error} -- the project uses the defaults until it is fixed or saved again here.
        </p>
      )}
      {data.runtimes.map((runtime) => (
        <RuntimeCard
          key={runtime.id}
          hash={project.hash}
          runtime={runtime}
          onResult={(next) => {
            setData(next)
            if (next.runtimes.some((r) => r.installing.length > 0)) setPolling(true)
          }}
        />
      ))}
    </div>
  )
}

function RuntimeCardSkeleton() {
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-4">
      <Skeleton className="h-5 w-24" />
      <Skeleton className="h-4 w-80 max-w-full" />
      <Skeleton className="h-8 w-72 max-w-full" />
    </div>
  )
}

/** Every `x.y` line among some versions, newest first. */
function linesOf(versions: string[]): string[] {
  const seen = new Set<string>()
  for (const v of versions) {
    const [major, minor] = v.split(".")
    if (major !== undefined && minor !== undefined) seen.add(`${major}.${minor}`)
  }
  return [...seen].sort((a, b) => {
    const [am = 0, an = 0] = a.split(".").map(Number)
    const [bm = 0, bn = 0] = b.split(".").map(Number)
    return bm - am || bn - an
  })
}

const isExact = (selection: string) => /^\d+\.\d+\.\d+$/.test(selection)

function describeSelection(selection: string): string {
  if (selection === "latest") return "Latest"
  if (selection === "system") return "Server's own"
  if (isExact(selection)) return `Pinned to ${selection}`
  return `${selection}.x`
}

function megabytes(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function RuntimeCard({
  hash,
  runtime,
  onResult,
}: {
  hash: string
  runtime: ProjectRuntimeStatus
  onResult: (next: ProjectRuntimesResponse) => void
}) {
  const [pending, setPending] = React.useState<string | null>(null)
  const [actionError, setActionError] = React.useState<string | null>(null)
  const label = runtime.label

  const act = async (key: string, run: () => Promise<ProjectRuntimesResponse>) => {
    setPending(key)
    setActionError(null)
    try {
      onResult(await run())
    } catch (e) {
      setActionError(e instanceof Error ? e.message : "Something went wrong.")
    } finally {
      setPending(null)
    }
  }

  const offered = runtime.available ?? []
  const lines = linesOf([...offered, ...runtime.installed])
  const newest = offered[0] ?? runtime.installed[0] ?? null
  const exactChoices = [...new Set([...runtime.installed, ...(isExact(runtime.selection) ? [runtime.selection] : [])])]
  const using = runtime.selection === "system" ? runtime.system : runtime.resolved
  const download = runtime.installing[0] ?? null

  return (
    <SettingsSection
      icon={LayersIcon}
      title={
        <>
          {label}
          <Badge tone={using ? "active" : "warning"}>{using ? `${label} ${using}` : "Not available"}</Badge>
        </>
      }
      description={
        <>
          The version this project&apos;s terminals, command buttons and agents run
          {runtime.id === "php" ? <> -- <code className="font-mono">composer</code> follows it</> : null}. Kept in{" "}
          <code className="font-mono">.agent/runtimes.json</code>, so it travels with the repository.
        </>
      }
      bare
    >
      <div className="mt-4 flex max-w-xl flex-col gap-4">
        <Field>
          <FieldLabel htmlFor={`runtime-${runtime.id}`}>Version</FieldLabel>
          <div className="flex flex-wrap items-center gap-2">
            <div className="w-72 max-w-full">
              <NativeSelect
                id={`runtime-${runtime.id}`}
                value={runtime.selection}
                disabled={pending !== null}
                onChange={(selection) => void act("select", () => selectRuntime(hash, runtime.id, selection))}
              >
                <option value="latest">Latest stable{newest ? ` (${newest})` : ""}</option>
                <optgroup label="Version line (gets patch updates)">
                  {lines.map((line) => {
                    const have = runtime.installed.find((v) => v.startsWith(`${line}.`))
                    return (
                      <option key={line} value={line}>
                        {label} {line}
                        {have ? ` -- ${have} installed` : ""}
                      </option>
                    )
                  })}
                </optgroup>
                {exactChoices.length > 0 && (
                  <optgroup label="Exact version (pinned)">
                    {exactChoices.map((v) => (
                      <option key={v} value={v}>
                        {label} {v} exactly
                      </option>
                    ))}
                  </optgroup>
                )}
                <option value="system">
                  Server&apos;s own{runtime.system ? ` (${runtime.system})` : " (none installed)"}
                </option>
              </NativeSelect>
            </div>
            {pending === "select" && <Loader2Icon className="text-muted-foreground size-4 animate-spin" />}
            {runtime.update && !download && (
              <Button
                size="sm"
                variant="outline"
                disabled={pending !== null}
                onClick={() => void act("update", () => installRuntime(hash, runtime.id))}
              >
                {pending === "update" ? <Loader2Icon className="animate-spin" /> : <ArrowUpCircleIcon />}
                Update to {runtime.update}
              </Button>
            )}
          </div>
          <FieldDescription>
            {describeSelection(runtime.selection)}
            {runtime.selection === "latest" && " follows the newest version installed on this server."}
            {!isExact(runtime.selection) && runtime.selection !== "latest" && runtime.selection !== "system" &&
              " uses the newest installed patch of that line."}
            {isExact(runtime.selection) && " stays on that version until you change it."}
            {runtime.selection === "system" && " uses whatever the server itself has installed."} Open terminals switch
            on their next command.
          </FieldDescription>
        </Field>

        {download ? (
          <div className="flex flex-col gap-1.5" aria-live="polite">
            <div className="flex items-center gap-2 text-sm">
              <Loader2Icon className="text-muted-foreground size-4 animate-spin" />
              Downloading {label} {download.version}
              <span className="text-muted-foreground tabular-nums">
                {megabytes(download.received)}
                {download.total ? ` of ${megabytes(download.total)}` : ""}
              </span>
            </div>
            <div className="bg-muted h-1.5 w-full max-w-xs overflow-hidden rounded-full">
              <div
                className="bg-primary h-full transition-[width]"
                style={{ width: download.total ? `${Math.min(100, (download.received / download.total) * 100)}%` : "15%" }}
              />
            </div>
          </div>
        ) : (
          runtime.missing && (
            <div className="flex flex-wrap items-center gap-2 text-sm">
              <AlertTriangleIcon className="text-warning size-4" />
              <span>
                {label} {runtime.missing} is not installed yet, so the project uses{" "}
                {runtime.system ? `the server's ${runtime.system}` : "nothing"} for now.
              </span>
              <Button
                size="sm"
                disabled={pending !== null}
                onClick={() => void act("install", () => installRuntime(hash, runtime.id, runtime.missing ?? undefined))}
              >
                {pending === "install" ? <Loader2Icon className="animate-spin" /> : <DownloadIcon />}
                Install {runtime.missing}
              </Button>
            </div>
          )
        )}

        {runtime.constraint && (
          <p className="flex items-center gap-1.5 text-sm">
            {runtime.satisfies === false ? (
              <AlertTriangleIcon className="text-warning size-4 shrink-0" />
            ) : (
              <CheckCircle2Icon className="text-success size-4 shrink-0" />
            )}
            <span>
              <code className="font-mono">composer.json</code> requires{" "}
              <code className="font-mono">{runtime.constraint}</code>
              {runtime.satisfies === false && using ? ` -- ${using} does not meet it.` : ""}
              {runtime.satisfies === null ? " (not checked)" : ""}
            </span>
          </p>
        )}

        {(actionError ?? runtime.lastError) && (
          <p role="alert" className="text-destructive text-sm">
            {actionError ?? runtime.lastError}
          </p>
        )}
        {runtime.availableError && (
          <p className="text-muted-foreground text-xs">
            Could not reach the download list ({runtime.availableError}); installed versions still work.
          </p>
        )}

        {runtime.installed.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-muted-foreground text-xs font-medium">Installed on this server (shared by every project)</p>
            <ul className="flex flex-wrap gap-1.5">
              {runtime.installed.map((version) => (
                <li key={version} className="flex items-center gap-1 rounded-md border py-0.5 pr-0.5 pl-2 text-xs">
                  <span className="tabular-nums">{version}</span>
                  {version === runtime.resolved ? (
                    <Badge tone="active">this project</Badge>
                  ) : (
                    <Button
                      size="icon-xs"
                      variant="ghost"
                      aria-label={`Remove ${label} ${version}`}
                      title="Remove (refused while any project uses it)"
                      disabled={pending !== null}
                      onClick={() => void act(`remove-${version}`, () => uninstallRuntime(hash, runtime.id, version))}
                    >
                      {pending === `remove-${version}` ? <Loader2Icon className="animate-spin" /> : <Trash2Icon />}
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </SettingsSection>
  )
}
