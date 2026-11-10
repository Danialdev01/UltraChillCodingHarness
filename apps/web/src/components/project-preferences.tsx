"use client"

import * as React from "react"
import { GitMergeIcon, GlobeIcon, Loader2Icon, MonitorPlayIcon, RulerIcon, SaveIcon, ShieldCheckIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { TaskAutomationSettings } from "@/components/tasks/task-automation-settings"
import { DEFAULT_DOC_WIDTH, DOC_WIDTHS, readDocWidth, watchDocWidth, writeDocWidth } from "@/lib/doc-width"
import { fetchGitBranches } from "@/lib/git-api"
import { setPreviewPort } from "@/lib/preview-api"
import { fetchOmpTrust, setOmpTrust, type OmpTrustState } from "@/lib/omp-trust-api"
import { fetchPublicSite, setPublicSite, type PublicSiteState } from "@/lib/public-api"
import { qk } from "@/lib/query-keys"
import type { Project } from "@/lib/session"
import { useInvalidate } from "@/lib/use-invalidate"
import { cn } from "@/lib/utils"
import { SettingsSection } from "@/components/layout/settings-section"

/**
 * The project's own settings, on the manage page's Preferences tab: the
 * base branch sessions fork from and settle into, which
 * port the live preview serves, whether the read-only public site is on,
 * whether OMP may run the repository's own tooling config, how the Tasks
 * board runs, and how wide the documentation's pages read.
 * Both are the same settings the preview dialog and the notes settings edit;
 * this is one place to find them together.
 */
export function ProjectPreferences({ project }: { project: Project }) {
  return (
    <div className="flex flex-col gap-4">
      {project.workspaceKind !== "session" && <GitSettings project={project} />}
      <PreviewPortSetting project={project} />
      <PublicSiteSetting hash={project.hash} />
      <OmpTrustSetting hash={project.hash} />
      <TaskAutomationSettings hash={project.hash} />
      <DocWidthSetting />
    </div>
  )
}

const selectClass = cn(
  "border-input bg-background h-8 w-full max-w-72 rounded-lg border px-2.5 text-sm outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50",
  "dark:bg-input/30",
)

/** Saves the project's git settings; the server checks the branch exists. */
async function saveGitSettings(
  hash: string,
  body: { baseBranch?: string; autoPushBase?: boolean; deleteBranchOnSettle?: boolean },
): Promise<void> {
  const response = await fetch(`/api/projects/${hash}`, {
    method: "PATCH",
    credentials: "include",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  })
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string }
    throw new Error(error.error ?? "Could not save the git settings.")
  }
}

/**
 * The base branch: what every new session forks `ucch/{hash}` from, and what
 * settling merges it into. Starts as the remote's default branch; any
 * branch the repository has, locally or on origin, can be picked. Beside
 * it, whether the base is pushed after a settle and whether the session's
 * branch is kept.
 */
function GitSettings({ project }: { project: Project }) {
  const invalidate = useInvalidate()
  const [branches, setBranches] = React.useState<string[] | null>(null)
  const [saved, setSaved] = React.useState({
    baseBranch: project.defaultBranch ?? "",
    autoPushBase: project.autoPushBase ?? false,
    deleteBranchOnSettle: project.deleteBranchOnSettle ?? true,
  })
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    let cancelled = false
    fetchGitBranches(project.hash).then(
      (list) => {
        if (cancelled) return
        // Remote branches by their own name: `origin/x` is offered as `x`.
        const names = [
          ...list.local.map((b) => b.name),
          ...list.remote.map((b) => b.name.replace(/^origin\//, "")),
        ].filter((name) => name && name !== "HEAD" && !name.startsWith("ucch/"))
        setBranches([...new Set(names)])
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
  }, [project.hash])

  const change = async (next: Partial<typeof saved>) => {
    setPending(true)
    setError(null)
    try {
      await saveGitSettings(project.hash, next)
      setSaved((s) => ({ ...s, ...next }))
      invalidate(qk.project(project.hash), qk.projects.all, qk.sessions.all, qk.bootstrap())
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the git settings.")
    } finally {
      setPending(false)
    }
  }

  const options = branches && saved.baseBranch && !branches.includes(saved.baseBranch)
    ? [saved.baseBranch, ...branches]
    : (branches ?? [])

  return (
    <SettingsSection
      icon={GitMergeIcon}
      title="Git"
      description={
        <>
          Each session works on its own branch, <span className="font-mono">ucch/…</span>, in a worktree of this
          project&apos;s repository. It is forked from the base branch, and settling it merges it back into the base.
        </>
      }
      bare
    >
      <div className="mt-4 flex max-w-xl flex-col gap-4">
        <Field>
          <FieldLabel htmlFor="project-base-branch">Base branch</FieldLabel>
          {branches === null ? (
            <Skeleton className="h-8 w-72" />
          ) : (
            <select
              id="project-base-branch"
              value={saved.baseBranch}
              disabled={pending || options.length === 0}
              onChange={(e) => void change({ baseBranch: e.target.value })}
              className={selectClass}
            >
              {options.map((name) => (
                <option key={name} value={name}>
                  {name}
                  {branches.includes(name) ? "" : " (missing)"}
                </option>
              ))}
            </select>
          )}
          <FieldDescription>
            New sessions fork from it and settling merges into it. Sessions already open keep the branch they
            started from, but settle into this one.
          </FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="project-auto-push">After a session is merged</FieldLabel>
          <select
            id="project-auto-push"
            value={saved.autoPushBase ? "push" : "local"}
            disabled={pending}
            onChange={(e) => void change({ autoPushBase: e.target.value === "push" })}
            className={selectClass}
          >
            <option value="local">Keep the merge local</option>
            <option value="push">Push {saved.baseBranch || "the base"} to origin</option>
          </select>
          <FieldDescription>A normal push of the base branch: never forced.</FieldDescription>
        </Field>
        <Field>
          <FieldLabel htmlFor="project-delete-branch">Session branch after merging</FieldLabel>
          <select
            id="project-delete-branch"
            value={saved.deleteBranchOnSettle ? "delete" : "keep"}
            disabled={pending}
            onChange={(e) => void change({ deleteBranchOnSettle: e.target.value === "delete" })}
            className={selectClass}
          >
            <option value="delete">Delete it — its commits are in the base</option>
            <option value="keep">Keep it</option>
          </select>
        </Field>
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}

function PreviewPortSetting({ project }: { project: Project }) {
  const [saved, setSaved] = React.useState<{ port: number | null; url: string | null }>({
    port: project.previewPort ?? null,
    url: project.previewUrl ?? null,
  })
  const [value, setValue] = React.useState(saved.port === null ? "" : String(saved.port))
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  // Saved somewhere else -- another tab, another member -- and the project's
  // live copy has it: show theirs, keeping an edit of this form's own.
  const livePort = project.previewPort ?? null
  const liveUrl = project.previewUrl ?? null
  React.useEffect(() => {
    if (livePort === saved.port && liveUrl === saved.url) return
    if (value.trim() === (saved.port === null ? "" : String(saved.port))) setValue(livePort === null ? "" : String(livePort))
    setSaved({ port: livePort, url: liveUrl })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [livePort, liveUrl])

  const trimmed = value.trim()
  const port = trimmed === "" ? null : Number(trimmed)
  const valid = port === null || (Number.isInteger(port) && port >= 1024 && port <= 65535)
  const changed = port !== saved.port

  const save = async () => {
    if (!valid || !changed) return
    setPending(true)
    setError(null)
    try {
      const next = await setPreviewPort(project.hash, port)
      setSaved({ port: next.previewPort ?? null, url: next.previewUrl ?? null })
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the preview port.")
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsSection icon={MonitorPlayIcon} title="Live preview" description={<>The port your dev server listens on inside the project. The preview address serves whatever is
        running there.</>} bare>
      <form
        className="mt-4 max-w-xl"
        onSubmit={(e) => {
          e.preventDefault()
          void save()
        }}
      >
        <Field>
          <FieldLabel htmlFor="preview-port">Port</FieldLabel>
          <div className="flex gap-2">
            <Input
              id="preview-port"
              inputMode="numeric"
              value={value}
              onChange={(e) => setValue(e.target.value.replace(/[^0-9]/g, ""))}
              placeholder="e.g. 5173"
              className="max-w-40"
              aria-invalid={!valid || undefined}
              disabled={pending}
            />
            <Button type="submit" disabled={!valid || !changed || pending}>
              {pending ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
              Save
            </Button>
          </div>
          <FieldDescription>
            {!valid
              ? "Use a port from 1024 to 65535."
              : saved.url
                ? <>Served at <span className="font-mono break-all">{saved.url}</span>. Clear the field to turn it off.</>
                : "No port set, so there is no preview yet."}
          </FieldDescription>
          {error && (
            <p role="alert" className="text-destructive text-xs">
              {error}
            </p>
          )}
        </Field>
      </form>
    </SettingsSection>
  )
}

function PublicSiteSetting({ hash }: { hash: string }) {
  const [state, setState] = React.useState<PublicSiteState | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetchPublicSite(hash).then(setState, (e) => setError(e instanceof Error ? e.message : "Could not load."))
  }, [hash])

  const change = async (enabled: boolean) => {
    if (!state || enabled === state.enabled) return
    setPending(true)
    setError(null)
    try {
      setState(await setPublicSite(hash, enabled))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not update the public site.")
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsSection icon={GlobeIcon} title="Public site" description={<>A read-only site for this project: visitors can read its notes, timeline and documents, see the
        commit history and browse files, and change nothing.</>} bare>
      <div className="mt-4 max-w-xl">
        {!state && !error && <Skeleton className="h-8 w-72" />}
        {state && (
          <Field>
            <FieldLabel htmlFor="project-visibility">Visibility</FieldLabel>
            <select
              id="project-visibility"
              value={state.enabled ? "public" : "private"}
              disabled={pending}
              onChange={(e) => void change(e.target.value === "public")}
              className={cn(
                "border-input bg-background h-8 w-full max-w-72 rounded-lg border px-2.5 text-sm outline-none",
                "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50",
                "dark:bg-input/30",
              )}
            >
              <option value="private">Private — only you</option>
              <option value="public">Public — anyone with the link</option>
            </select>
            {state.url && (
              <FieldDescription>
                {state.enabled ? "Live at " : "Off. When turned on it is at "}
                <a
                  href={state.url}
                  target="_blank"
                  rel="noreferrer"
                  className="text-ucch-active font-mono break-all underline underline-offset-2"
                >
                  {state.url}
                </a>
              </FieldDescription>
            )}
          </Field>
        )}
        {error && (
          <p role="alert" className="text-destructive mt-2 text-xs">
            {error}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}

/**
 * Whether the project is trusted for OMP (solution §0.3). A cloned
 * repository's `lsp.json` and `dap.json` name commands OMP would run as the
 * server, so they are ignored until a workspace admin says they have read
 * them. Everyone else sees the setting, and why it is not theirs to change.
 */
function OmpTrustSetting({ hash }: { hash: string }) {
  const [state, setState] = React.useState<OmpTrustState | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetchOmpTrust(hash).then(setState, (e) => setError(e instanceof Error ? e.message : "Could not load."))
  }, [hash])

  const change = async (trusted: boolean) => {
    if (!state || trusted === state.trusted) return
    setPending(true)
    setError(null)
    try {
      setState(await setOmpTrust(hash, trusted))
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not change whether the project is trusted.")
    } finally {
      setPending(false)
    }
  }

  return (
    <SettingsSection icon={ShieldCheckIcon} title="Trusted repository" description={<>A trusted project gives the Custom agent and the OMP tools language servers and a debugger, and
        lets the repository&apos;s own <span className="font-mono">lsp.json</span> and{" "}
        <span className="font-mono">dap.json</span> choose them. Those files name programs that run on
        this server, so only trust a repository whose files you have read.</>} bare>
      <div className="mt-4 max-w-xl">
        {!state && !error && <Skeleton className="h-8 w-72" />}
        {state && (
          <Field>
            <FieldLabel htmlFor="project-omp-trust">Trust</FieldLabel>
            <select
              id="project-omp-trust"
              value={state.trusted ? "trusted" : "untrusted"}
              disabled={pending || !state.canChange}
              onChange={(e) => void change(e.target.value === "trusted")}
              className={cn(
                "border-input bg-background h-8 w-full max-w-72 rounded-lg border px-2.5 text-sm outline-none",
                "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50",
                "dark:bg-input/30",
              )}
            >
              <option value="untrusted">Untrusted — no language servers or debugger</option>
              <option value="trusted">Trusted — its own tooling config runs</option>
            </select>
            {!state.canChange && <FieldDescription>Only a workspace admin can change this.</FieldDescription>}
          </Field>
        )}
        {error && (
          <p role="alert" className="text-destructive mt-2 text-xs">
            {error}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}

/**
 * How wide a documentation page reads. A browser preference like the font
 * sizes, not a project setting: it is about the screen in front of you, so it
 * is kept in `localStorage` and an open page follows it at once. Read after
 * mount, so the first paint matches what the server produced.
 */
function DocWidthSetting() {
  const [width, setWidth] = React.useState(DEFAULT_DOC_WIDTH)

  React.useEffect(() => {
    setWidth(readDocWidth())
    return watchDocWidth(setWidth)
  }, [])

  return (
    <SettingsSection icon={RulerIcon} title="Documentation width" description="How wide a page of the documentation reads. Applies to this browser only." bare>
      <div
        role="radiogroup"
        aria-label="Documentation width"
        className="bg-muted/40 mt-4 inline-flex items-center gap-0.5 rounded-lg border p-0.5"
      >
        {DOC_WIDTHS.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={width === id}
            onClick={() => setWidth(writeDocWidth(id))}
            className={cn(
              "flex h-7 items-center rounded-md px-2.5 text-xs transition-colors",
              width === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>
      {/* The page's column inside a stand-in for the screen, so each choice
          shows what it does before it is used. */}
      <div aria-hidden className="mt-4 max-w-xl rounded-md border p-3">
        <div
          className="bg-muted/60 mx-auto flex flex-col gap-1.5 rounded-sm p-2 transition-[max-width] duration-200"
          style={{ maxWidth: { narrow: "40%", default: "55%", wide: "75%", full: "100%" }[width] }}
        >
          <div className="bg-muted-foreground/40 h-2 w-2/5 rounded-full" />
          <div className="bg-muted-foreground/25 h-1.5 w-full rounded-full" />
          <div className="bg-muted-foreground/25 h-1.5 w-11/12 rounded-full" />
          <div className="bg-muted-foreground/25 h-1.5 w-3/5 rounded-full" />
        </div>
      </div>
    </SettingsSection>
  )
}
