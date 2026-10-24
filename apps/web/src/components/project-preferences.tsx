"use client"

import * as React from "react"
import { GlobeIcon, Loader2Icon, MonitorPlayIcon, RulerIcon, SaveIcon } from "lucide-react"

import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import { TaskAutomationSettings } from "@/components/tasks/task-automation-settings"
import { DEFAULT_DOC_WIDTH, DOC_WIDTHS, readDocWidth, watchDocWidth, writeDocWidth } from "@/lib/doc-width"
import { setPreviewPort } from "@/lib/preview-api"
import { fetchPublicSite, setPublicSite, type PublicSiteState } from "@/lib/public-api"
import type { Project } from "@/lib/session"
import { cn } from "@/lib/utils"

/**
 * The project's own settings, on the manage page's Preferences tab: which
 * port the live preview serves, whether the read-only public site is on, how
 * the Tasks board runs, and how wide the documentation's pages read.
 * Both are the same settings the preview dialog and the notes settings edit;
 * this is one place to find them together.
 */
export function ProjectPreferences({ project }: { project: Project }) {
  return (
    <div className="flex flex-col gap-4">
      <PreviewPortSetting project={project} />
      <PublicSiteSetting hash={project.hash} />
      <TaskAutomationSettings hash={project.hash} />
      <DocWidthSetting />
    </div>
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
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <MonitorPlayIcon className="text-muted-foreground size-4" />
        Live preview
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        The port your dev server listens on inside the project. The preview address serves whatever is
        running there.
      </p>
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
    </section>
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
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <GlobeIcon className="text-muted-foreground size-4" />
        Public site
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        A read-only site for this project: visitors can read its notes, timeline and documents, see the
        commit history and browse files, and change nothing.
      </p>
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
    </section>
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
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <RulerIcon className="text-muted-foreground size-4" />
        Documentation width
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        How wide a page of the documentation reads. Applies to this browser only.
      </p>
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
    </section>
  )
}
