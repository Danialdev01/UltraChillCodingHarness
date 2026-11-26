"use client"

import * as React from "react"
import { COUNCIL_MAX, COUNCIL_MAX_ROUNDS, COUNCIL_MIN, SAME_MODEL } from "@ucch/protocol/plain"
import { UsersIcon } from "lucide-react"

import { SettingsSection } from "@/components/layout/settings-section"
import { Button } from "@/components/ui/button"
import { Field, FieldDescription, FieldLabel } from "@/components/ui/field"
import { Input } from "@/components/ui/input"
import { Skeleton } from "@/components/ui/skeleton"
import {
  fetchDeliberationSettings,
  setDeliberationSettings,
  type DeliberationPatch,
  type DeliberationSettingsState,
} from "@/lib/deliberation-api"
import { cn } from "@/lib/utils"

const selectClass = cn(
  "border-input bg-background h-8 w-full max-w-72 rounded-lg border px-2.5 text-sm outline-none",
  "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring disabled:opacity-50",
  "dark:bg-input/30",
)

const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i)

/**
 * What `@reviewer` and `@council` do in this project when a message names
 * no model (plan4 §4.4): the request's "same model or best model" rule,
 * kept on the server so every device sends the same thing.
 */
export function DeliberationSettings({ hash }: { hash: string }) {
  const [state, setState] = React.useState<DeliberationSettingsState | null>(null)
  const [pending, setPending] = React.useState(false)
  const [error, setError] = React.useState<string | null>(null)
  /** The model field while "a specific model" is chosen and not yet saved. */
  const [custom, setCustom] = React.useState<string | null>(null)

  React.useEffect(() => {
    fetchDeliberationSettings(hash).then(setState, (e) => setError(e instanceof Error ? e.message : "Could not load."))
  }, [hash])

  const change = async (patch: DeliberationPatch) => {
    setPending(true)
    setError(null)
    try {
      setState(await setDeliberationSettings(hash, patch))
      if (patch.reviewerModel !== undefined) setCustom(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not save the Reviewer and Council settings.")
    } finally {
      setPending(false)
    }
  }

  const reviewerChoice = !state ? "auto" : custom !== null ? "model" : state.reviewerModel === "auto" || state.reviewerModel === SAME_MODEL ? state.reviewerModel : "model"
  const disabled = pending || !state?.canChange

  return (
    <SettingsSection
      icon={UsersIcon}
      title="Reviewer and Council"
      description={
        <>
          What <span className="font-mono">@reviewer</span> and <span className="font-mono">@council</span> use when a message names no
          model. A message that names models always wins.
        </>
      }
      bare
    >
      <div className="mt-4 flex max-w-xl flex-col gap-4" data-testid="deliberation-settings">
        {!state && !error && (
          <>
            <Skeleton className="h-8 w-72" />
            <Skeleton className="h-8 w-40" />
            <Skeleton className="h-8 w-40" />
          </>
        )}
        {state && (
          <>
            <Field>
              <FieldLabel htmlFor="deliberation-reviewer">Reviewer model</FieldLabel>
              <select
                id="deliberation-reviewer"
                value={reviewerChoice}
                disabled={disabled}
                onChange={(e) => {
                  const value = e.target.value
                  if (value === "model") setCustom(state.reviewerModel === "auto" || state.reviewerModel === SAME_MODEL ? "" : state.reviewerModel)
                  else void change({ reviewerModel: value })
                }}
                className={selectClass}
              >
                <option value="auto">Auto: the best model from another vendor</option>
                <option value={SAME_MODEL}>Same as the session</option>
                <option value="model">A specific model</option>
              </select>
              {reviewerChoice === "model" && (
                <form
                  className="flex max-w-72 items-center gap-2"
                  onSubmit={(e) => {
                    e.preventDefault()
                    const model = (custom ?? state.reviewerModel).trim()
                    if (model) void change({ reviewerModel: model })
                  }}
                >
                  <Input
                    aria-label="Reviewer model id"
                    placeholder="gpt-5, claude-opus-5-5, …"
                    value={custom ?? state.reviewerModel}
                    disabled={disabled}
                    onChange={(e) => setCustom(e.target.value)}
                    className="h-8 font-mono"
                  />
                  <Button type="submit" size="sm" disabled={disabled || !(custom ?? state.reviewerModel).trim() || custom === null}>
                    Save
                  </Button>
                </form>
              )}
            </Field>
            <Field>
              <FieldLabel htmlFor="deliberation-size">Council size</FieldLabel>
              <select
                id="deliberation-size"
                value={state.councilSize}
                disabled={disabled}
                onChange={(e) => void change({ councilSize: Number(e.target.value) })}
                className={cn(selectClass, "max-w-40")}
              >
                {range(COUNCIL_MIN, COUNCIL_MAX).map((n) => (
                  <option key={n} value={n}>
                    {n} members
                  </option>
                ))}
              </select>
            </Field>
            <Field>
              <FieldLabel htmlFor="deliberation-rounds">Council rounds</FieldLabel>
              <select
                id="deliberation-rounds"
                value={state.councilRounds}
                disabled={disabled}
                onChange={(e) => void change({ councilRounds: Number(e.target.value) })}
                className={cn(selectClass, "max-w-40")}
              >
                {range(0, COUNCIL_MAX_ROUNDS).map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? "Opening answers only" : `${n} ${n === 1 ? "round" : "rounds"} of discussion`}
                  </option>
                ))}
              </select>
              <FieldDescription>Rounds after the members&apos; opening answers; the council stops early once nobody changes position.</FieldDescription>
            </Field>
            {!state.canChange && <FieldDescription>Only a workspace admin can change these.</FieldDescription>}
          </>
        )}
        {error && (
          <p role="alert" className="text-destructive text-xs">
            {error}
          </p>
        )}
      </div>
    </SettingsSection>
  )
}
