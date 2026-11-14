"use client"

import { useEffect, useRef, useState, useSyncExternalStore } from "react"

import type { ChatMessage, MessagePart, SubagentRun, ToolPart } from "@/lib/chat-messages"
import { agentOf, descriptionOf, isShellCall, isSubagentCall, promptOf, summariseInput } from "@/lib/chat-messages"

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
  /**
   * The provider of the turn that made the call: the harness a run without
   * a `provider` of its own ran inside. Absent on a turn that names none.
   */
  harness?: string
  run: Pick<
    SubagentRun,
    | "id"
    | "agent"
    | "description"
    | "model"
    | "status"
    | "summary"
    | "toolCalls"
    | "durationMs"
    | "costUsd"
    | "provider"
    | "childHash"
    | "resumeHandle"
    | "result"
    | "steps"
    | "recentTools"
    | "recentOutput"
  > & {
    /** The full prompt the call gave it, for the detail view and search. */
    prompt: string | null
  }
}

/** One entry's identity across renders: a call can carry several runs. */
export function lineageKey(entry: LineageEntry): string {
  return `${entry.callId}:${entry.run.id}`
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
      const harness = message.provider ? { harness: message.provider } : {}
      if (runs.length === 0) {
        out.push({
          callId: call.id,
          ...harness,
          run: {
            id: call.id,
            agent: agentOf(call.input) ?? "subagent",
            description: descriptionOf(call.input),
            model: null,
            summary: null,
            status: call.result === null ? "running" : call.isError ? "failed" : "completed",
            toolCalls: null,
            durationMs: call.durationMs,
            costUsd: null,
            result: call.result,
            steps: [],
            prompt: promptOf(call.input),
          },
        })
        continue
      }
      // Copied: the parser updates runs in place, and a stored reference
      // would always compare equal to its own newer self.
      for (const run of runs)
        out.push({
          callId: call.id,
          ...harness,
          run: {
            id: run.id,
            agent: run.agent,
            description: run.description,
            model: run.model,
            summary: run.summary,
            status: run.status,
            toolCalls: run.toolCalls,
            durationMs: run.durationMs,
            costUsd: run.costUsd,
            result: run.result,
            prompt: promptOf(call.input, { id: run.id, description: run.description }) ?? run.description,
            // Copied too, call by call: a result lands on the call in place.
            steps: run.steps.map((step) => ({ ...step })),
            ...(run.recentTools ? { recentTools: run.recentTools } : {}),
            ...(run.recentOutput ? { recentOutput: run.recentOutput } : {}),
            ...(run.provider ? { provider: run.provider } : {}),
            ...(run.childHash ? { childHash: run.childHash } : {}),
            ...(run.resumeHandle ? { resumeHandle: run.resumeHandle } : {}),
          },
        })
    }
  }
  return out
}

/**
 * How long a subagent that has finished stays among the running ones before
 * it folds into Done: long enough to see it come back, and click it.
 */
export const SUBAGENT_LINGER_MS = 30_000

/**
 * The card's two lists: who is out (and who came back in the last
 * `SUBAGENT_LINGER_MS`), and everyone done before that, newest first.
 * `finishedAt` is when each was first seen finished, 0 for "before this
 * page knew of it".
 */
export function partitionLineage(
  entries: readonly LineageEntry[],
  finishedAt: ReadonlyMap<string, number>,
  now: number,
): { active: LineageEntry[]; done: LineageEntry[] } {
  const active: LineageEntry[] = []
  const done: LineageEntry[] = []
  for (const entry of entries) {
    if (entry.run.status === "running") {
      active.push(entry)
      continue
    }
    const at = finishedAt.get(lineageKey(entry)) ?? 0
    if (at > 0 && now - at < SUBAGENT_LINGER_MS) active.push(entry)
    else done.push(entry)
  }
  return { active, done: done.reverse() }
}

/**
 * When each entry was first seen finished, and a clock that ticks when the
 * next one is due to fold into Done. What was already finished the first
 * time the hook saw the list -- a reload, a visit -- is dated 0, so it is
 * in Done from the start rather than lingering as if it had just come back.
 */
export function useLineagePartition(entries: readonly LineageEntry[]): {
  active: LineageEntry[]
  done: LineageEntry[]
  /** Finished and still lingering among the active ones. */
  lingering: (entry: LineageEntry) => boolean
} {
  const finishedAt = useRef(new Map<string, number>())
  const seeded = useRef(false)
  const [now, setNow] = useState(() => Date.now())

  // Recorded during render, so a run's first finished frame already lingers.
  const map = finishedAt.current
  const stamp = Date.now()
  for (const entry of entries) {
    const key = lineageKey(entry)
    if (entry.run.status === "running") map.delete(key)
    else if (!map.has(key)) map.set(key, seeded.current ? stamp : 0)
  }
  // The first list with anything in it is history; after that, news. An
  // empty list (no chat mounted yet, or a thread switch clearing it) is not.
  if (entries.length > 0) seeded.current = true
  const clock = Math.max(now, stamp)

  // Next fold: one timer, for whoever is due soonest.
  let next = Infinity
  for (const at of map.values()) if (at > 0 && clock - at < SUBAGENT_LINGER_MS) next = Math.min(next, at + SUBAGENT_LINGER_MS)
  useEffect(() => {
    if (next === Infinity) return
    const timer = window.setTimeout(() => setNow(Date.now()), Math.max(0, next - Date.now()) + 50)
    return () => window.clearTimeout(timer)
  }, [next])

  const { active, done } = partitionLineage(entries, map, clock)
  return {
    active,
    done,
    lingering: (entry) => entry.run.status !== "running" && (map.get(lineageKey(entry)) ?? 0) > 0,
  }
}

/**
 * Where a subagent's own page is, in a project workspace (whose sessions
 * have addresses): a `ucch_agent` subagent's session, where its whole
 * transcript is and it can be talked to; a CLI's built-in one, which has no
 * session, the read-only view of it over its parent's (`?agent=`). Null
 * where there is no such page, and the thread's card is the place instead.
 */
export function subagentHref(
  entry: LineageEntry,
  where: { ws: string | null; projectHash: string | null; parentHash: string | null; kind: string },
): string | null {
  const { ws, projectHash, parentHash, kind } = where
  if (!ws || !projectHash || kind !== "project") return null
  if (entry.run.childHash) return `/${ws}/p/${projectHash}/${entry.run.childHash}`
  if (!parentHash) return null
  return `/${ws}/p/${projectHash}/${parentHash}?agent=${encodeURIComponent(lineageKey(entry))}`
}

/**
 * The harness a person's follow-up to a CLI's built-in subagent goes
 * through, from its page: Codex's workers, or a Claude Code agent its
 * parent can continue (it has a handle). Null for the rest -- a `ucch_agent`
 * one is talked to in its own session, and OMP cannot continue its own.
 */
export function followUpHarness(entry: LineageEntry): "codex" | "claude" | null {
  if (entry.run.childHash) return null
  const harness = entry.run.provider ?? entry.harness
  if (harness === "codex") return "codex"
  if (!entry.run.provider && entry.harness === "claude" && entry.run.resumeHandle) return "claude"
  return null
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
      x.harness === y.harness &&
      x.run.id === y.run.id &&
      x.run.status === y.run.status &&
      x.run.description === y.run.description &&
      x.run.model === y.run.model &&
      x.run.summary === y.run.summary &&
      x.run.durationMs === y.run.durationMs &&
      x.run.toolCalls === y.run.toolCalls &&
      x.run.costUsd === y.run.costUsd &&
      x.run.provider === y.run.provider &&
      x.run.childHash === y.run.childHash &&
      x.run.resumeHandle === y.run.resumeHandle &&
      sameSteps(x.run.steps, y.run.steps) &&
      sameLines(x.run.recentTools, y.run.recentTools) &&
      sameLines(x.run.recentOutput, y.run.recentOutput) &&
      x.run.result === y.run.result &&
      x.run.prompt === y.run.prompt
    )
  })
}

/**
 * The agent's shell commands that are running right now in the thread on
 * screen, for the card's terminal list. A finished command drops off.
 * Published by the chat for the same reason the lineage is.
 */
export type ShellEntry = {
  /** The tool call: the card scrolls to its row. */
  callId: string
  command: string
  /** "approval": paused on a permission prompt before it runs. */
  status: "running" | "approval"
}

let shells: readonly ShellEntry[] = []
const shellListeners = new Set<() => void>()
const NO_SHELLS: readonly ShellEntry[] = []

export function publishShellCalls(next: readonly ShellEntry[]) {
  if (sameShellEntries(shells, next)) return
  shells = next
  for (const listener of shellListeners) listener()
}

export function useShellCalls(): readonly ShellEntry[] {
  return useSyncExternalStore(
    (listener) => {
      shellListeners.add(listener)
      return () => shellListeners.delete(listener)
    },
    () => shells,
    () => NO_SHELLS,
  )
}

/** The thread's shell calls that have not finished, oldest first. */
export function shellCallsOf(messages: readonly ChatMessage[]): ShellEntry[] {
  const out: ShellEntry[] = []
  for (const message of messages) {
    if (message.role !== "assistant") continue
    for (const part of message.parts) {
      if (part.kind !== "tool" || !isShellCall(part.name)) continue
      const call = part as ToolPart
      if (call.result !== null) continue
      out.push({
        callId: call.id,
        command: summariseInput(call.input) || call.name,
        status: call.awaitingApproval ? "approval" : "running",
      })
    }
  }
  return out
}

/** The DOM id of a plain tool call's row in the thread. */
export function toolAnchor(callId: string): string {
  return `tool-${callId.replace(/[^a-zA-Z0-9_-]/g, "_")}`
}

function sameShellEntries(a: readonly ShellEntry[], b: readonly ShellEntry[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i]!
    return x.callId === y.callId && x.command === y.command && x.status === y.status
  })
}

function sameSteps(a: readonly MessagePart[], b: readonly MessagePart[]): boolean {
  if (a.length !== b.length) return false
  return a.every((x, i) => {
    const y = b[i]!
    if (x.kind === "tool" && y.kind === "tool") return x.id === y.id && x.result === y.result && x.isError === y.isError
    if (x.kind === "text" && y.kind === "text") return x.text === y.text
    return x.kind === y.kind
  })
}

function sameLines(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  if (a === b) return true
  if (!a || !b || a.length !== b.length) return false
  return a.every((line, i) => line === b[i])
}
