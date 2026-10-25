import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import type { DomainEvent } from "@ucch/protocol"

import type { ClientEvent } from "./client"
import { toMessages } from "./chat-messages"
import { HIDDEN_FALLBACK_MS } from "./next-frame"
import { ThreadStore } from "./thread-store"

const THREAD = "44444444-4444-4444-4444-444444444444"
const OTHER = "55555555-5555-5555-5555-555555555555"
const TURN = "66666666-6666-6666-6666-666666666666"
const usage = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }

const durable = (seq: number, event: DomainEvent): ClientEvent => ({ seq, event, receivedAt: seq })
const live = (event: DomainEvent): ClientEvent => ({ seq: null, event, receivedAt: 0 })
const text = (t: string, turnId = TURN) => live({ type: "agent.text_delta", threadId: THREAD, turnId, text: t })
const thinking = (t: string) => live({ type: "agent.thinking_delta", threadId: THREAD, turnId: TURN, text: t })
const user = (seq: number, t: string) => durable(seq, { type: "user.message", threadId: THREAD, text: t })
const started = (seq: number) => durable(seq, { type: "turn.started", threadId: THREAD, turnId: TURN })
const message = (seq: number, t: string) =>
  durable(seq, { type: "agent.message", threadId: THREAD, turnId: TURN, content: [{ type: "text", text: t }] } as DomainEvent)
const completed = (seq: number) =>
  durable(seq, { type: "agent.turn_completed", threadId: THREAD, turnId: TURN, stopReason: "end_turn", usage, costUsd: 0 })

/** Each row as `seq:type[:text]`. */
const shape = (rows: readonly ClientEvent[]) =>
  rows.map((row) => {
    const event = row.event as { type: string; text?: string }
    return `${row.seq ?? "-"}:${event.type}${event.text !== undefined && row.seq === null ? `:${event.text}` : ""}`
  })

describe("ThreadStore", () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it("keeps each durable event once, in order, and nothing of other threads", () => {
    const store = new ThreadStore(THREAD)
    store.push(user(0, "hi"))
    store.push(started(2))
    store.push(durable(1, { type: "context.injected", threadId: THREAD, source: "project_context", content: "y" }))
    store.push(user(0, "hi"))
    store.push(durable(3, { type: "user.message", threadId: OTHER, text: "elsewhere" }))
    store.push(live({ type: "composer.changed", threadId: THREAD } as unknown as DomainEvent))
    expect(shape(store.rows)).toEqual(["0:user.message", "1:context.injected", "2:turn.started"])
  })

  it("folds a stream into one run where it streamed, so it never floods the window", () => {
    const store = new ThreadStore(THREAD, { window: 4 })
    store.push(user(0, "my question"))
    store.push(started(1))
    for (let i = 0; i < 2_000; i++) store.push(text("x"))
    expect(store.rows).toHaveLength(3)
    expect(shape(store.rows)[0]).toBe("0:user.message")
    expect((store.rows[2]!.event as { text: string }).text).toHaveLength(2_000)
  })

  it("keeps thinking and text apart and in order, around durable events", () => {
    const store = new ThreadStore(THREAD)
    store.push(started(1))
    store.push(thinking("hmm"))
    store.push(thinking(" ok"))
    store.push(text("Let me"))
    store.push(text(" look."))
    store.push(message(2, "Let me look."))
    store.push(durable(3, { type: "agent.tool_use", threadId: THREAD, turnId: TURN, toolUseId: "a", name: "read", input: {} } as DomainEvent))
    store.push(text("Done"))
    expect(shape(store.rows)).toEqual([
      "1:turn.started",
      "-:agent.thinking_delta:hmm ok",
      "-:agent.text_delta:Let me look.",
      "2:agent.message",
      "3:agent.tool_use",
      "-:agent.text_delta:Done",
    ])
  })

  it("draws what the interleaved deltas drew", () => {
    const events = [
      user(0, "hi"),
      started(1),
      thinking("pondering"),
      text("Hel"),
      text("lo"),
      message(2, "Hello"),
      text("More"),
      completed(3),
    ]
    const store = new ThreadStore(THREAD)
    for (const row of events) store.push(row)
    expect(toMessages(store.rows)).toEqual(toMessages(events))
  })

  it("caps the durable window and lets runs go with the event they followed", () => {
    const store = new ThreadStore(THREAD, { window: 3 })
    store.push(started(0))
    store.push(text("early"))
    store.push(message(1, "early"))
    store.push(message(2, "b"))
    store.push(message(3, "c"))
    expect(shape(store.rows)).toEqual(["1:agent.message", "2:agent.message", "3:agent.message"])
    // Older than the whole window: not let back in.
    store.push(started(0))
    expect(store.rows).toHaveLength(3)
  })

  it("keeps finished turns' runs, and drops open ones on a resync", () => {
    const store = new ThreadStore(THREAD)
    store.push(started(1))
    store.push(thinking("kept"))
    store.push(completed(2))
    const other = "77777777-7777-7777-7777-777777777777"
    store.push(durable(3, { type: "turn.started", threadId: THREAD, turnId: other }))
    store.push(text("lost", other))
    store.reset()
    expect(shape(store.rows)).toEqual(["1:turn.started", "-:agent.thinking_delta:kept", "2:agent.turn_completed", "3:turn.started"])
  })

  it("says which layer changed", () => {
    const store = new ThreadStore(THREAD)
    store.push(started(1))
    const durableBefore = store.durableVersion
    store.push(text("a"))
    store.push(text("b"))
    expect(store.durableVersion).toBe(durableBefore)
    expect(store.liveVersion).toBe(2)
    store.push(completed(2))
    expect(store.durableVersion).toBe(durableBefore + 1)
  })

  it("keeps the same rows until something changes", () => {
    const store = new ThreadStore(THREAD)
    store.push(started(1))
    const rows = store.rows
    expect(store.rows).toBe(rows)
    store.push(text("a"))
    expect(store.rows).not.toBe(rows)
  })

  it("tells its listeners once a frame however much arrived", () => {
    const store = new ThreadStore(THREAD)
    const heard = vi.fn()
    store.subscribe(heard)
    store.push(started(1))
    for (let i = 0; i < 50; i++) store.push(text("x"))
    expect(heard).not.toHaveBeenCalled()
    vi.advanceTimersByTime(0)
    expect(heard).toHaveBeenCalledTimes(1)
    store.push(text("y"))
    vi.advanceTimersByTime(HIDDEN_FALLBACK_MS)
    expect(heard).toHaveBeenCalledTimes(2)
    store.dispose()
    store.push(text("z"))
    vi.advanceTimersByTime(HIDDEN_FALLBACK_MS)
    expect(heard).toHaveBeenCalledTimes(2)
  })
})
