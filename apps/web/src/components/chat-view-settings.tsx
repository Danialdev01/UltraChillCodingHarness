"use client"

import * as React from "react"
import { SparklesIcon, SquareTerminalIcon } from "lucide-react"

import {
  DEFAULT_CHAT_VIEW_MODE,
  readChatViewMode,
  watchChatViewMode,
  writeChatViewMode,
  type ChatViewMode,
} from "@/lib/chat-view-mode"
import { cn } from "@/lib/utils"
import {
  DEFAULT_WIDGET_PROMPT_MODE,
  readWidgetPromptMode,
  watchWidgetPromptMode,
  writeWidgetPromptMode,
  type WidgetPromptMode,
} from "@/lib/widget-prompt-mode"
import { SettingsSection } from "@/components/layout/settings-section"

const CHOICES: { id: ChatViewMode; label: string; hint: string }[] = [
  {
    id: "default",
    label: "Default",
    hint: "Answers up front; the agent's thoughts and tool calls fold into one dropdown per turn.",
  },
  {
    id: "transcript",
    label: "Transcript",
    hint: "The CLI look, for debugging and following along: every step inline and in order, file edits as diffs, commands with their output and exit code.",
  },
]

/** Which layout the project chat uses for the agent's turns. Per browser, applied at once. */
export function ChatViewSettings() {
  const [choice, setChoice] = React.useState<ChatViewMode>(DEFAULT_CHAT_VIEW_MODE)

  React.useEffect(() => {
    setChoice(readChatViewMode())
    return watchChatViewMode(setChoice)
  }, [])

  function choose(value: ChatViewMode) {
    setChoice(value)
    writeChatViewMode(value)
  }

  const current = CHOICES.find((c) => c.id === choice)

  return (
    <SettingsSection
      icon={SquareTerminalIcon}
      title="Chat view"
      description={<>How the agent&apos;s work is shown in a project chat. Applies to this browser only.</>}
      bare
    >
      <div
        role="radiogroup"
        aria-label="Chat view"
        className="bg-muted/40 mt-4 inline-flex items-center gap-0.5 rounded-lg border p-0.5"
      >
        {CHOICES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={choice === id}
            onClick={() => choose(id)}
            className={cn(
              "h-7 rounded-md px-3 text-xs transition-colors",
              choice === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-muted-foreground mt-3 text-sm">{current?.hint}</p>
    </SettingsSection>
  )
}

const PROMPT_CHOICES: { id: WidgetPromptMode; label: string; hint: string }[] = [
  { id: "composer", label: "Put in composer", hint: "A widget's follow-up button fills in the composer; you read it and send it." },
  { id: "send", label: "Send at once", hint: "A widget's follow-up button sends its question straight away." },
]

/** What a widget's follow-up button (`sendPrompt`) does. Per browser. */
export function WidgetPromptSettings() {
  const [choice, setChoice] = React.useState<WidgetPromptMode>(DEFAULT_WIDGET_PROMPT_MODE)

  React.useEffect(() => {
    setChoice(readWidgetPromptMode())
    return watchWidgetPromptMode(setChoice)
  }, [])

  function choose(value: WidgetPromptMode) {
    setChoice(value)
    writeWidgetPromptMode(value)
  }

  return (
    <SettingsSection
      icon={SparklesIcon}
      title="Widget follow-ups"
      description={<>What happens when a button in a chat widget asks a follow-up question. Applies to this browser only.</>}
      bare
    >
      <div
        role="radiogroup"
        aria-label="Widget follow-ups"
        className="bg-muted/40 mt-4 inline-flex items-center gap-0.5 rounded-lg border p-0.5"
      >
        {PROMPT_CHOICES.map(({ id, label }) => (
          <button
            key={id}
            type="button"
            role="radio"
            aria-checked={choice === id}
            onClick={() => choose(id)}
            className={cn(
              "h-7 rounded-md px-3 text-xs transition-colors",
              choice === id
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            {label}
          </button>
        ))}
      </div>

      <p className="text-muted-foreground mt-3 text-sm">{PROMPT_CHOICES.find((c) => c.id === choice)?.hint}</p>
    </SettingsSection>
  )
}
