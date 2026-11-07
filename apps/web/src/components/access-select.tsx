"use client"

import * as React from "react"
import { CheckIcon, ChevronDownIcon, LockKeyholeIcon, LockKeyholeOpenIcon, ShieldIcon } from "lucide-react"
import type { AgentPermissionMode } from "@ucch/protocol"

import { PERMISSION_CHOICES } from "@/components/agent-permission-settings"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { useToast } from "@/lib/realtime"
import { cn } from "@/lib/utils"

const ICONS: Record<AgentPermissionMode, React.ComponentType<{ className?: string }>> = {
  strict: LockKeyholeIcon,
  normal: ShieldIcon,
  allow_all: LockKeyholeOpenIcon,
}

/**
 * How much the agent may do before it asks, chosen where you talk to it.
 *
 * The same account setting as Settings → General's "Agent permission" --
 * one value, two places to change it -- so a session about to do something
 * risky can be tightened without leaving the chat. Applies from the agent's
 * next action on.
 */
export function AccessSelect({ disabled }: { disabled?: boolean }) {
  const [mode, setMode] = React.useState<AgentPermissionMode | null>(null)
  const [busy, setBusy] = React.useState(false)
  const toast = useToast()

  React.useEffect(() => {
    let cancelled = false
    void fetch("/api/settings", { credentials: "include" })
      .then((response) => (response.ok ? response.json() : null))
      .then((body: { agentPermissionMode?: AgentPermissionMode } | null) => {
        if (!cancelled && body) setMode(body.agentPermissionMode ?? "normal")
      })
      .catch(() => {})
    return () => {
      cancelled = true
    }
  }, [])

  async function choose(next: AgentPermissionMode) {
    if (busy || next === mode) return
    const previous = mode
    setMode(next)
    setBusy(true)
    try {
      const response = await fetch("/api/settings/agent-permission-mode", {
        method: "PUT",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ mode: next }),
      })
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as { error?: string }
        throw new Error(body.error ?? "Could not change the permission mode.")
      }
    } catch (e) {
      setMode(previous)
      toast({ title: "Could not change access", description: e instanceof Error ? e.message : undefined, tone: "error" })
    } finally {
      setBusy(false)
    }
  }

  // Until it has loaded there is nothing true to show; the row keeps its
  // place with the icon alone.
  const current = PERMISSION_CHOICES.find((c) => c.id === mode)
  const Icon = mode ? ICONS[mode] : ShieldIcon

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        disabled={disabled || mode === null || busy}
        title={current ? `Access: ${current.label}. ${current.hint}` : "Access"}
        className={cn(
          "text-muted-foreground hover:text-foreground hover:bg-muted aria-expanded:bg-muted flex h-7 min-w-0 shrink items-center gap-1 rounded-md px-1.5 text-xs transition-colors disabled:opacity-60",
          mode === "allow_all" && "text-warning hover:text-warning",
        )}
      >
        <Icon className="size-3.5 shrink-0" />
        <span className="hidden truncate @md:inline">{current?.label ?? "Access"}</span>
        <ChevronDownIcon className="text-muted-foreground size-3 shrink-0" />
        <span className="sr-only">Change what the agent may do without asking</span>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" side="top" className="w-72">
        <DropdownMenuGroup>
          <DropdownMenuLabel>Access</DropdownMenuLabel>
          {PERMISSION_CHOICES.map((choice) => {
            const ChoiceIcon = ICONS[choice.id]
            return (
              <DropdownMenuItem
                key={choice.id}
                onClick={() => void choose(choice.id)}
                className="items-start py-1.5"
              >
                <ChoiceIcon className="mt-0.5" />
                <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span className="font-medium">{choice.label}</span>
                  <span className="text-muted-foreground text-xs leading-snug">{choice.hint}</span>
                </span>
                {choice.id === mode && <CheckIcon className="mt-0.5" />}
              </DropdownMenuItem>
            )
          })}
        </DropdownMenuGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
