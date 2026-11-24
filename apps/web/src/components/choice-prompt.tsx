"use client"

import * as React from "react"
import { ArrowRightLeftIcon, ClockIcon, Loader2Icon, XIcon } from "lucide-react"

import { HarnessIcon } from "@/components/harness-icon"
import { ModelSelect, useModels, type ModelChoice } from "@/components/model-picker"
import { Button } from "@/components/ui/button"
import { ResumeTimeField } from "@/components/resume-card"
import type { ChoicePrompt } from "@/lib/chat-messages"
import { readLastModel } from "@/lib/model-preference"
import type { ProviderCard, ProviderId } from "@/lib/providers-api"
import { formatResume, suggestedResume } from "@/lib/resume-time"

/**
 * A question from the server with fixed answers, above the composer:
 * which harness carries on after a usage limit stopped this session's turn
 * (`harness_limit`) or one of its subagents (`subagent_limit`), or whether
 * to compact a big session whose prompt cache ran out before its message
 * goes (`resume_compact`, plan2 §3.7).
 *
 * Each option is a button. One that carries on elsewhere asks for the model
 * first, from that harness's list or OpenRouter's catalogue; one that waits
 * asks for the time. The card goes when the answer is recorded
 * (`agent.choice_resolved`), from this tab or another; "Not now" dismisses
 * it, which for a subagent ends that subagent as failed.
 */
export function ChoicePromptCard({
  choice,
  cards,
  projectId,
  onReply,
}: {
  choice: ChoicePrompt
  cards: Record<ProviderId, ProviderCard> | null
  /** Whose remembered models the lists open on. */
  projectId: string
  onReply: (requestId: string, optionId: string, picked: { model?: string; at?: string; provider?: ProviderId }) => Promise<void>
}) {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  /** The option waiting on a model or a time, and the model picked so far, if any. */
  const [picking, setPicking] = React.useState<string | null>(null)
  const [chosen, setChosen] = React.useState<string | null>(null)
  const openRouter = useModels()

  const picked = choice.options.find((option) => option.id === picking)
  const cli = picked?.provider === "claude" || picked?.provider === "codex" ? picked.provider : null
  const models: ModelChoice[] = cli
    ? (cards?.[cli]?.models ?? []).map((m) => ({
        id: m.id,
        name: m.name,
        provider: cards?.[cli]?.label ?? cli,
        contextLength: null,
        reasoning: false,
        images: true,
      }))
    : openRouter.models
  const remembered = cli ? readLastModel(`${projectId}:${cli}`) : null
  const model =
    chosen ?? (cli ? ((models.find((m) => m.id === remembered) ?? models[0])?.id ?? "") : (openRouter.defaultModel ?? ""))

  const reply = async (optionId: string, answer: { model?: string; at?: string } = {}) => {
    if (busy) return
    setBusy(optionId)
    setError(null)
    try {
      await onReply(choice.requestId, optionId, {
        ...answer,
        ...(picked?.provider ? { provider: picked.provider } : {}),
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
    // On success the card leaves the state and this unmounts.
  }

  const pick = (option: ChoicePrompt["options"][number]) => {
    if (!option.pickModel && !option.schedule) return void reply(option.id)
    setPicking(option.id)
    setChosen(null)
  }

  return (
    <div
      role="alertdialog"
      aria-label={choice.title}
      data-testid="choice-prompt"
      className="border-ucch-active/50 bg-ucch-active/5 flex flex-col gap-2 rounded-lg border px-3 py-2.5 text-xs"
    >
      <div className="flex items-start gap-2">
        <ArrowRightLeftIcon className="text-ucch-active mt-0.5 size-3.5 shrink-0" />
        <div className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium">{choice.title}</span>
          {choice.detail && <span className="text-muted-foreground">{choice.detail}</span>}
          {choice.resetsAt && <span className="text-muted-foreground">The limit resets at {formatResume(choice.resetsAt)}.</span>}
        </div>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {choice.options.map((option) => (
          <Button
            key={option.id}
            type="button"
            size="sm"
            variant={picking === option.id ? "secondary" : "outline"}
            className="h-7 gap-1.5 text-xs"
            disabled={busy !== null || Boolean(option.blocker)}
            title={option.blocker ?? option.detail}
            onClick={() => pick(option)}
          >
            {busy === option.id ? (
              <Loader2Icon className="animate-spin" />
            ) : option.schedule ? (
              <ClockIcon />
            ) : option.provider ? (
              <HarnessIcon harness={option.provider} size={14} />
            ) : null}
            {option.label}
            {option.blocker && <span className="text-muted-foreground">· {option.blocker}</span>}
          </Button>
        ))}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-7 gap-1 text-xs"
          disabled={busy !== null}
          onClick={() => void reply("dismiss")}
          title={
            choice.kind === "subagent_limit"
              ? "Stop the subagent; its parent is told it could not finish"
              : choice.kind === "resume_compact"
                ? "Send the message to the session as it is"
                : "Leave the session where it is"
          }
        >
          <XIcon />
          Not now
        </Button>
      </div>

      {picked?.schedule && (
        <ResumeTimeField
          initial={suggestedResume(choice.resetsAt)}
          busy={busy !== null}
          label="Continue then"
          onSubmit={(at) => void reply(picked.id, { at })}
        />
      )}

      {picked?.pickModel && (
        <div className="flex flex-col gap-1.5 @md:flex-row @md:items-center">
          <span className="text-muted-foreground shrink-0">{cli ? `${cards?.[cli]?.label ?? "Harness"} model:` : "OpenRouter model:"}</span>
          <div className="min-w-0 flex-1">
            <ModelSelect models={models} value={model} onChange={setChosen} disabled={busy !== null} />
          </div>
          <Button
            type="button"
            size="sm"
            className="h-7 shrink-0 text-xs"
            // A CLI whose list is empty runs on its own default.
            disabled={busy !== null || (!model && !(cli && cards))}
            onClick={() => void reply(picked.id, model ? { model } : {})}
          >
            {busy === picked.id ? <Loader2Icon className="animate-spin" /> : null}
            Continue
          </Button>
        </div>
      )}

      {error && <p className="text-destructive">{error}</p>}
    </div>
  )
}
