"use client"

import * as React from "react"
import { BotIcon, Loader2Icon, SaveIcon } from "lucide-react"
import { TASK_AUTO_RUN_USAGE_LIMIT } from "@ucch/protocol/plain"
import type { TaskSettings } from "@ucch/protocol"

import { ModelSelect, useModels } from "@/components/model-picker"
import { ProviderSelect, useProviders } from "@/components/provider-picker"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import type { ProviderId } from "@/lib/providers-api"
import { fetchTaskSettings, saveTaskSettings } from "@/lib/tasks-api"
import { cn } from "@/lib/utils"

const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"]

const selectClass = cn(
  "border-input bg-background h-8 w-full max-w-72 rounded-lg border px-2.5 text-sm outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50",
  "dark:bg-input/30",
)

function browserZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC"
  } catch {
    return "UTC"
  }
}

function zones(current: string): string[] {
  let all: string[] = []
  try {
    all = (Intl as unknown as { supportedValuesOf?: (k: string) => string[] }).supportedValuesOf?.("timeZone") ?? []
  } catch {
    all = []
  }
  return [...new Set([current, "UTC", ...all])]
}

/**
 * The Tasks board's settings, on the manage page's Preferences tab: which
 * agent carries the cards, and whether Idea cards move to Research by
 * themselves on a schedule.
 */
export function TaskAutomationSettings({ hash }: { hash: string }) {
  const providers = useProviders()
  const { models } = useModels()
  const [saved, setSaved] = React.useState<TaskSettings | null>(null)
  const [provider, setProvider] = React.useState<ProviderId>("native")
  const [model, setModel] = React.useState("")
  const [enabled, setEnabled] = React.useState(false)
  const [days, setDays] = React.useState<number[]>([])
  const [time, setTime] = React.useState("02:00")
  const [timezone, setTimezone] = React.useState("UTC")
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  const [notice, setNotice] = React.useState<string | null>(null)

  const load = React.useCallback(
    (settings: TaskSettings, fallbackProvider: ProviderId | null) => {
      setSaved(settings)
      setProvider(settings.provider ?? fallbackProvider ?? "native")
      setModel(settings.model ?? "")
      setEnabled(settings.autoRun.enabled)
      setDays(settings.autoRun.days)
      setTime(settings.autoRun.time)
      // A board that has never been scheduled starts in the browser's zone.
      setTimezone(settings.autoRun.enabled || settings.provider ? settings.autoRun.timezone : browserZone())
    },
    [],
  )

  React.useEffect(() => {
    fetchTaskSettings(hash).then(
      (settings) => load(settings, null),
      (e: unknown) => setError(e instanceof Error ? e.message : "Could not load."),
    )
  }, [hash, load])

  // The account's default provider, once known, for a board that names none.
  React.useEffect(() => {
    if (saved && !saved.provider && providers.defaultProvider) setProvider(providers.defaultProvider)
  }, [saved, providers.defaultProvider])

  const card = providers.cards?.[provider]
  const cliModels = provider === "native" ? [] : (card?.models ?? [])

  const save = async () => {
    if (enabled && days.length === 0) return setError("Pick at least one day for Auto Run.")
    setPending(true)
    setError(null)
    setNotice(null)
    try {
      const next = await saveTaskSettings(hash, {
        provider,
        model: model.trim() || null,
        autoRun: { enabled, days, time, timezone },
      })
      load(next, provider)
      setNotice("Saved.")
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the task settings.")
    } finally {
      setPending(false)
    }
  }

  return (
    <section className="rounded-lg border p-6">
      <h2 className="flex items-center gap-2 text-sm font-medium">
        <BotIcon className="text-muted-foreground size-4" />
        Tasks automation
      </h2>
      <p className="text-muted-foreground mt-2 max-w-prose text-sm">
        The AI agent that carries cards on the Tasks board through Research, Ongoing and Verification, and
        whether Idea cards start on their own.
      </p>

      {!saved && !error && <Skeleton className="mt-4 h-24 w-full max-w-xl" />}
      {saved && (
        <form
          className="mt-4 grid max-w-xl gap-5"
          onSubmit={(e) => {
            e.preventDefault()
            void save()
          }}
        >
          <Field>
            <FieldLabel>Default AI agent</FieldLabel>
            <div className="flex flex-wrap items-center gap-2">
              <ProviderSelect
                providers={providers}
                value={provider}
                locked={null}
                disabled={pending}
                onChange={(id) => {
                  setProvider(id)
                  setModel("")
                }}
              />
              {provider === "native" ? (
                <div className="min-w-56 flex-1">
                  <ModelSelect models={models} value={model} onChange={setModel} disabled={pending} />
                </div>
              ) : (
                <select
                  aria-label="Model"
                  value={model}
                  disabled={pending}
                  onChange={(e) => setModel(e.target.value)}
                  className={selectClass}
                >
                  <option value="">The CLI&apos;s default model</option>
                  {cliModels.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.name}
                    </option>
                  ))}
                </select>
              )}
            </div>
            <FieldDescription>
              {provider === "native" && !model
                ? "No model picked: the account's default model from Settings is used."
                : "Every step of the pipeline runs on this agent, in chat threads you can open from the card."}
            </FieldDescription>
          </Field>

          <Field>
            <label className="flex items-center gap-2 text-sm font-medium">
              <input
                type="checkbox"
                checked={enabled}
                disabled={pending}
                onChange={(e) => setEnabled(e.target.checked)}
                className="size-4"
              />
              Auto Run Tasks
            </label>
            <FieldDescription>
              {enabled
                ? "On the days and time below, every card in Idea moves to Research and the AI takes it from there."
                : "Off: move a card from Idea to Research yourself. From Research on, the AI moves it."}
            </FieldDescription>
          </Field>

          {enabled && (
            <div className="grid gap-4 rounded-md border p-4">
              <Field>
                <FieldLabel>Days</FieldLabel>
                <div className="flex flex-wrap gap-1">
                  {WEEKDAYS.map((label, day) => {
                    const on = days.includes(day)
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={on}
                        disabled={pending}
                        onClick={() =>
                          setDays((current) =>
                            on ? current.filter((d) => d !== day) : [...current, day].sort((a, b) => a - b),
                          )
                        }
                        className={cn(
                          "h-8 w-11 rounded-md border text-xs",
                          on ? "bg-primary text-primary-foreground border-primary" : "hover:bg-muted",
                        )}
                      >
                        {label}
                      </button>
                    )
                  })}
                </div>
              </Field>
              <div className="flex flex-wrap gap-4">
                <Field className="w-32">
                  <FieldLabel htmlFor="task-autorun-time">Time</FieldLabel>
                  <Input
                    id="task-autorun-time"
                    type="time"
                    value={time}
                    disabled={pending}
                    onChange={(e) => setTime(e.target.value)}
                  />
                </Field>
                <Field className="min-w-56 flex-1">
                  <FieldLabel htmlFor="task-autorun-zone">Time zone</FieldLabel>
                  <select
                    id="task-autorun-zone"
                    value={timezone}
                    disabled={pending}
                    onChange={(e) => setTimezone(e.target.value)}
                    className={selectClass}
                  >
                    {zones(timezone).map((zone) => (
                      <option key={zone} value={zone}>
                        {zone}
                      </option>
                    ))}
                  </select>
                </Field>
              </div>
              <p className="text-muted-foreground text-xs">
                Skipped while {card?.label ?? provider}&apos;s subscription usage is at {TASK_AUTO_RUN_USAGE_LIMIT}% or
                more in any window, or cannot be read.
                {saved.autoRun.lastRunAt && (
                  <>
                    {" "}
                    Last scheduled run {new Date(saved.autoRun.lastRunAt).toLocaleString()}:{" "}
                    {saved.autoRun.lastOutcome ?? "—"}.
                  </>
                )}
              </p>
            </div>
          )}

          <div className="flex items-center gap-3">
            <Button type="submit" disabled={pending}>
              {pending ? <Loader2Icon className="animate-spin" /> : <SaveIcon />}
              Save
            </Button>
            {notice && <span className="text-muted-foreground text-xs">{notice}</span>}
          </div>
        </form>
      )}
      {error && (
        <p role="alert" className="text-destructive mt-2 text-xs">
          {error}
        </p>
      )}
    </section>
  )
}
