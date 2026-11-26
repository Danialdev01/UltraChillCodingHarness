"use client"

import * as React from "react"
import {
  FRAMEWORK_IDS,
  FRAMEWORK_LABELS,
  FRAMEWORK_PROFILES,
  FRAMEWORK_STACK,
  RUNTIME_LABELS,
  choiceAvailable,
  frameworkSummary,
  planFramework,
  resolveFrameworkOptions,
  type FrameworkId,
  type FrameworkOption,
  type FrameworkOptions,
  type FrameworksResponse,
} from "@ucch/protocol/plain"
import { useQuery } from "@tanstack/react-query"
import { CircleHelpIcon, WandSparklesIcon } from "lucide-react"

import { Callout, FOCUS, HELPER, LABEL, PopoverSelect } from "@/components/form-dialog"
import { ProjectStackIcon } from "@/components/project-stack-icon"
import { Skeleton } from "@/components/ui/skeleton"
import { Switch } from "@/components/ui/switch"
import { fetchFrameworks } from "@/lib/frameworks-api"
import { cn } from "@/lib/utils"

/** What the picker holds: a profile, "other" (auto-detect, nothing written), or nothing chosen yet. */
export type FrameworkPick = FrameworkId | "other" | null

/** Where the project's code comes from: options marked `emptyOnly` (templates, editions) show only for a start from nothing. */
export type FrameworkSource = "empty" | "repo"

/** `/api/frameworks`, shared by the dialog and the Environment tab; cached for the session. */
export function useFrameworkServer(): { server: FrameworksResponse | null; error: string | null } {
  const { data, error } = useQuery({ queryKey: ["frameworks"], queryFn: fetchFrameworks, staleTime: 10 * 60_000 })
  return { server: data ?? null, error: error ? error.message : null }
}

/**
 * Six tiles: the five profiles and "Other / auto-detect" (plan3 §4.1). The
 * same radio-tile pattern as the New Repo tab's host choice.
 */
export function FrameworkPicker({
  value,
  onChange,
  disabled,
  labelledBy,
  allowOther = true,
}: {
  value: FrameworkPick
  onChange: (value: FrameworkPick) => void
  disabled?: boolean
  labelledBy: string
  allowOther?: boolean
}) {
  const tiles: { id: FrameworkId | "other"; label: string; blurb: string }[] = [
    ...FRAMEWORK_IDS.map((id) => ({ id, label: FRAMEWORK_LABELS[id], blurb: FRAMEWORK_PROFILES[id].blurb })),
    ...(allowOther ? [{ id: "other" as const, label: "Other", blurb: "Detect it from the code" }] : []),
  ]
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="grid grid-cols-2 gap-1.5 sm:grid-cols-3" data-testid="framework-picker">
      {tiles.map((tile) => {
        const checked = tile.id === value
        return (
          <button
            key={tile.id}
            type="button"
            role="radio"
            aria-checked={checked}
            disabled={disabled}
            onClick={() => onChange(checked && tile.id !== "other" ? null : tile.id)}
            data-framework={tile.id}
            className={cn(
              "flex min-w-0 items-center gap-2 rounded-[8px] border border-(--fd-border) bg-(--fd-field) px-2.5 py-2 text-left transition-[border-color,box-shadow,background-color] disabled:cursor-not-allowed disabled:opacity-60",
              FOCUS,
              checked ? "border-(--fd-accent) bg-(--fd-accent-tint) ring-[3px] ring-(--fd-ring-soft)" : "enabled:hover:border-(--fd-border-hover)",
            )}
          >
            <span className="flex size-4 shrink-0 items-center justify-center [&_svg]:size-4 [&_img]:size-4">
              {tile.id === "other" ? (
                <CircleHelpIcon className="text-(--fd-icon-dim)" aria-hidden />
              ) : (
                <ProjectStackIcon stack={FRAMEWORK_STACK[tile.id]} />
              )}
            </span>
            <span className="flex min-w-0 flex-col">
              <span className="truncate text-[12px] font-medium text-(--fd-text)">{tile.label}</span>
              <span className="truncate text-[10.5px] text-(--fd-text-faint)">{tile.blurb}</span>
            </span>
          </button>
        )
      })}
    </div>
  )
}

/** The choices an option offers on this server: its own, plus the version lines the server lists, minus what it cannot do. */
function choicesOf(option: FrameworkOption, server: FrameworksResponse | null) {
  const listed: { value: string; label: string; hint?: string }[] = (option.choices ?? [])
    .filter((c) => choiceAvailable(c, server))
    .map((c) => ({ value: c.value, label: c.label, ...(c.note ? { hint: c.note } : {}) }))
  const known = new Set(listed.map((c) => c.value))
  const extra =
    option.runtime && server?.lines[option.runtime]
      ? server.lines[option.runtime]!.filter((line) => !known.has(line)).map((line) => ({ value: line, label: line }))
      : []
  return [...listed, ...extra]
}

/**
 * A profile's toolchain options (plan3 §4.2): the same fields in the New
 * Project dialog and on the Environment tab, so the two never drift.
 * Version selects wait for the server's lines with a skeleton; a choice the
 * server cannot provide (mold, Native AOT without clang) is left out and
 * said so underneath.
 */
export function FrameworkOptionsFields({
  id,
  values,
  onChange,
  source,
  disabled,
  idPrefix = "framework",
}: {
  id: FrameworkId
  values: Record<string, unknown>
  onChange: (values: FrameworkOptions) => void
  source: FrameworkSource
  disabled?: boolean
  idPrefix?: string
}) {
  const { server } = useFrameworkServer()
  const { options } = resolveFrameworkOptions(id, values)
  const profile = FRAMEWORK_PROFILES[id]
  const shown = profile.options.filter((o) => !o.emptyOnly || source === "empty")
  const missing = profile.options.flatMap((o) => (o.choices ?? []).filter((c) => !choiceAvailable(c, server)).map((c) => c.label))
  const set = (key: string, value: string | boolean) => onChange({ ...options, [key]: value })

  return (
    <div className="flex flex-col gap-3" data-testid="framework-options">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {shown.map((option) => {
          const labelId = `${idPrefix}-${id}-${option.key}`
          if (option.kind === "toggle") {
            return (
              <div key={option.key} className="flex items-center justify-between gap-3 rounded-[8px] border border-(--fd-border-subtle) bg-(--fd-field-muted) px-2.5 py-2 sm:col-span-2">
                <span id={labelId} className={LABEL}>
                  {option.label}
                </span>
                <Switch checked={options[option.key] === true} onCheckedChange={(on) => set(option.key, on)} disabled={disabled} aria-labelledby={labelId} />
              </div>
            )
          }
          return (
            <div key={option.key} className="flex min-w-0 flex-col gap-1.5">
              <span id={labelId} className={LABEL}>
                {option.label}
              </span>
              {option.runtime && !server ? (
                <Skeleton className="h-[34px] rounded-[8px]" />
              ) : (
                <PopoverSelect
                  value={String(options[option.key])}
                  options={choicesOf(option, server)}
                  onChange={(value) => set(option.key, value)}
                  heading={option.label}
                  disabled={disabled}
                  labelledBy={labelId}
                />
              )}
              {option.description && <p className={HELPER}>{option.description}</p>}
            </div>
          )
        })}
      </div>
      {server && missing.length > 0 && (
        <p className={HELPER}>Not on this server, so not offered: {missing.join(", ")}.</p>
      )}
    </div>
  )
}

/** "Will set up: PHP latest · Node LTS · 9 command buttons · preview on :8000" (plan3 §4.3). */
export function FrameworkSummary({ id, values, fromRepo }: { id: FrameworkId; values: Record<string, unknown>; fromRepo: boolean }) {
  const plan = planFramework(id, values)
  const parts = frameworkSummary(plan, RUNTIME_LABELS)
  return (
    <Callout icon={WandSparklesIcon} accent>
      <span data-testid="framework-summary">
        <span className="font-medium text-(--fd-text)">Will set up: </span>
        {parts.join(" · ")}.{fromRepo && " The repository's own requirements win over these."}
      </span>
    </Callout>
  )
}
