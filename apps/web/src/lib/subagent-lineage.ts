"use client"

import { useSyncExternalStore } from "react"

import type { ChatMessage, SubagentRun, ToolPart } from "@/lib/chat-messages"
import { isSubagentCall } from "@/lib/chat-messages"

/**
 * The subagents of the conversation on screen, for the session card beside
 * it to list -- who was sent off, on what, and whether they are back.
 *
 * The chat owns the messages; the card is a sibling of it, not a child, so
 * the chat publishes what it already parsed here and the card reads it.
 * Nothing is fetched: one chat is mounted at a time (the dock is the same
 * instance), so one list is enough.
 */
export type LineageEntry = {
  /** The tool call the runs belong to: the card scrolls to it. */
  callId: string
  run: Pick<SubagentRun, "id" | "agent" | "description" | "status" | "toolCalls" | "durationMs" | "costUsd">
}

let entries: readonly LineageEntry[] = []
const listeners = new Set<() => void>()

export function publishLineage(next: readonly LineageEntry[]) {
  if (sameEntries(entries, next)) return
  entries = next
  for (const listener of listeners) listener()
}

export function useLineage(): readonly LineageEntry[] {
  return useSyncExternalStore(
    (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    () => entries,
    () => EMPTY,
  )
}

const EMPTY: readonly LineageEntry[] = []

/** Every subagent run in the thread, oldest first. */
export function lineageOf(messages: readonly ChatMessage[]): LineageEntry[] {
  const out: LineageEntry[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.kind !== "tool" || !(isSubagentCall(part.name) || part.subagents)) continue
      const call = part as ToolPart
      const runs = call.subagents ?? []
      if (runs.length === 0) {
        out.push({
          callId: call.id,
          run: {
            id: call.id,
            agent: "subagent",
            description: null,
            status: call.result === null ? "running" : call.isError ? "failed" : "completed",
            toolCalls: null,
            durationMs: call.durationMs,
            costUsd: null,
          },
        })
        continue
      }
      // Copied: the parser updates runs in place, and a stored reference
      // would always compare equal to its own newer self.
      for (const run of runs)
        out.push({
          callId: call.id,
          run: {
            id: run.id,
            agent: run.agent,
            description: run.description,
            status: run.status,
            toolCalls: run.toolCalls,
            durationMs: run.durationMs,
            costUsd: run.costUsd,
          },
        })
    }
  }
  return out
}

/** The DOM id of a subagent call's card in the thread. */
export function subagentAnchor(callId: string): string {
  return `subagent-${callId.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

function sameEntries(a: readonly LineageEntry[], b: readonly LineageEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i]!
    return (
      x.callId === y.callId &&
      x.run.id === y.run.id &&
      x.run.status === y.run.status &&
      x.run.description === y.run.description &&
      x.run.durationMs === y.run.durationMs &&
      x.run.toolCalls === y.run.toolCalls &&
      x.run.costUsd === y.run.costUsd
    )
  })
}
