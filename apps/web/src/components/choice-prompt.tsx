"use client"

import * as React from "react"
import { ArrowRightLeftIcon, Loader2Icon, XIcon } from "lucide-react"

import { HarnessIcon } from "@/components/harness-icon"
import { ModelSelect, useModels } from "@/components/model-picker"
import { Button } from "@/components/ui/button"
import type { ChoicePrompt } from "@/lib/chat-messages"

/**
 * A question from the server with fixed answers, above the composer: today,
 * which harness carries on after a usage limit stopped this session's turn
 * (`harness_limit`) or one of its subagents (`subagent_limit`).
 *
 * Each option is a button. One that runs an OpenRouter model asks for the
 * model first, from the catalogue. The card goes when the answer is recorded
 * (`agent.choice_resolved`), from this tab or another; "Not now" dismisses
 * it, which for a subagent ends that subagent as failed.
 */
export function ChoicePromptCard({
  choice,
  onReply,
}: {
  choice: ChoicePrompt
  onReply: (requestId: string, optionId: string, model?: string) => Promise<void>
}) {
  const [busy, setBusy] = React.useState<string | null>(null)
  const [error, setError] = React.useState<string | null>(null)
  /** The option waiting on a model pick, and the model picked so far. */
  const [picking, setPicking] = React.useState<string | null>(null)
  const [model, setModel] = React.useState("")
  const { models, defaultModel } = useModels()

  const reply = async (optionId: string, chosen?: string) => {
    if (busy) return
    setBusy(optionId)
    setError(null)
    try {
      await onReply(choice.requestId, optionId, chosen)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(null)
    }
    // On success the card leaves the state and this unmounts.
  }

  const pick = (optionId: string, pickModel: boolean | undefined) => {
    if (!pickModel) return void reply(optionId)
    setPicking(optionId)
    if (!model && defaultModel) setModel(defaultModel)
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
            onClick={() => pick(option.id, option.pickModel)}
          >
            {busy === option.id ? (
              <Loader2Icon className="animate-spin" />
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
          title={choice.kind === "subagent_limit" ? "Stop the subagent; its parent is told it could not finish" : "Leave the session where it is"}
        >
          <XIcon />
          Not now
        </Button>
      </div>

      {picking && (
        <div className="flex flex-col gap-1.5 @md:flex-row @md:items-center">
          <span className="text-muted-foreground shrink-0">OpenRouter model:</span>
          <div className="min-w-0 flex-1">
            <ModelSelect models={models} value={model} onChange={setModel} disabled={busy !== null} />
          </div>
          <Button
            type="button"
            size="sm"
            className="h-7 shrink-0 text-xs"
            disabled={busy !== null || !model}
            onClick={() => void reply(picking, model)}
          >
            {busy === picking ? <Loader2Icon className="animate-spin" /> : null}
            Continue
          </Button>
        </div>
      )}

      {error && <p className="text-destructive">{error}</p>}
    </div>
  )
}
