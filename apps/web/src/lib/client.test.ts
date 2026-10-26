import { TERMINAL_INPUT_MAX } from "@ucch/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { parseServerFrame, terminalPieces, UcchClient } from "./client"

describe("terminalPieces", () => {
  it("sends a keystroke, or anything that fits, as it is", () => {
    expect(terminalPieces("a")).toEqual(["a"])
    expect(terminalPieces("")).toEqual([""])
    expect(terminalPieces("x".repeat(TERMINAL_INPUT_MAX))).toHaveLength(1)
  })

  it("splits a long paste into pieces a frame may carry, losing nothing", () => {
    const paste = "y".repeat(TERMINAL_INPUT_MAX * 2 + 5)
    const pieces = terminalPieces(paste)
    expect(pieces.map((p) => p.length)).toEqual([TERMINAL_INPUT_MAX, TERMINAL_INPUT_MAX, 5])
    expect(pieces.join("")).toBe(paste)
  })

  it("never cuts a character in two", () => {
    // "😀" is two UTF-16 units; four units from the start is between them.
    const pieces = terminalPieces("abc😀de", 4)
    expect(pieces).toEqual(["abc", "😀de"])
    expect(pieces.join("")).toBe("abc😀de")
  })
})

/** A socket that is open at once and keeps what it was sent. */
class FakeSocket {
  static OPEN = 1
  static last: FakeSocket | null = null
  readyState = 1
  url: string
  sent: Array<Record<string, unknown>> = []
  onmessage: ((message: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor(url: string) {
    this.url = url
    FakeSocket.last = this
  }
  send(text: string) {
    this.sent.push(JSON.parse(text) as Record<string, unknown>)
  }
  close() {}
}

const PROJECT = "33333333-3333-3333-3333-333333333333"

async function readyClient() {
  vi.stubEnv("NEXT_PUBLIC_WS_ORIGIN", "http://127.0.0.1:1")
  vi.stubGlobal("WebSocket", FakeSocket)
  vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ticket: "t" })))
  const client = new UcchClient()
  await client.connect()
  const socket = FakeSocket.last!
  socket.onmessage!({
    data: JSON.stringify({
      kind: "ready",
      userId: "11111111-1111-1111-1111-111111111111",
      scopes: ["read"],
      serverVersion: "test",
    }),
  })
  // What is sent from here on, as `kind topic-flags`.
  const sent = () =>
    socket.sent.map((frame) => {
      const topic = frame.topic as { quiet?: boolean; files?: boolean; tree?: string } | undefined
      if (!topic) return `${frame.kind as string} ${frame.id as string}`
      return `${frame.kind as string} ${frame.id as string}${topic.quiet ? " quiet" : ""}${topic.files ? " files" : ""}${topic.tree ? ` tree=${topic.tree}` : ""}`
    })
  return { client, socket, sent }
}

describe("UcchClient.holdFiles", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("turns files on for the first view and off after the last, keeping one subscription", async () => {
    const { client, sent } = await readyClient()
    void client.subscribe({ name: "project", projectId: PROJECT, quiet: true })
    const releaseA = client.holdFiles(PROJECT)
    const releaseB = client.holdFiles(PROJECT)
    // A plain quiet subscribe while files are held asks for nothing new.
    void client.subscribe({ name: "project", projectId: PROJECT, quiet: true })
    releaseA()
    releaseA()
    expect(sent()).toEqual(["subscribe 0 quiet", "unsubscribe 0", "subscribe 1 quiet files"])
    releaseB()
    expect(sent().slice(3)).toEqual(["unsubscribe 1", "subscribe 2 quiet"])
  })

  it("subscribes with files straight away when nothing is subscribed yet", async () => {
    const { client, sent } = await readyClient()
    const release = client.holdFiles(PROJECT)
    void client.subscribe({ name: "project", projectId: PROJECT, quiet: true })
    expect(sent()).toEqual(["subscribe 0 quiet files"])
    release()
    expect(sent()).toEqual(["subscribe 0 quiet files", "unsubscribe 0", "subscribe 1 quiet"])
  })

  it("keeps a loud subscription loud", async () => {
    const { client, sent } = await readyClient()
    void client.subscribe({ name: "project", projectId: PROJECT })
    const release = client.holdFiles(PROJECT)
    release()
    expect(sent()).toEqual(["subscribe 0", "unsubscribe 0", "subscribe 1 files", "unsubscribe 1", "subscribe 2"])
  })

  it("watches a session's worktree, the latest view's tree when two disagree", async () => {
    const { client, sent } = await readyClient()
    const releaseSession = client.holdFiles(PROJECT, "abc123")
    const releaseCheckout = client.holdFiles(PROJECT)
    expect(sent()).toEqual(["subscribe 0 quiet files tree=abc123", "unsubscribe 0", "subscribe 1 quiet files"])
    releaseCheckout()
    expect(sent().slice(3)).toEqual(["unsubscribe 1", "subscribe 2 quiet files tree=abc123"])
    releaseSession()
    expect(sent().slice(5)).toEqual(["unsubscribe 2"])
  })
})

describe("UcchClient.hold", () => {
  const THREAD = "44444444-4444-4444-4444-444444444444"
  const thread = { name: "thread", threadId: THREAD } as const
  const at = "2026-01-01T00:00:00.000Z"
  const replay = (subscriptionId: string, seqs: number[]) =>
    JSON.stringify({
      kind: "replay",
      subscriptionId,
      events: seqs.map((seq) => ({ seq, at, projectId: PROJECT, event: { type: "user.message", threadId: THREAD, text: `m${seq}` } })),
      done: true,
    })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("subscribes once however many views hold a topic, and ends it after the last", async () => {
    const { client, sent } = await readyClient()
    const a = client.hold({ name: "terminal", terminalId: "t" })
    const b = client.hold({ name: "terminal", terminalId: "t" })
    a.release()
    a.release()
    expect(sent()).toEqual(["subscribe 0"])
    b.release()
    expect(sent()).toEqual(["subscribe 0", "unsubscribe 0"])
  })

  it("goes back to quiet when the view that wanted it loud lets go", async () => {
    const { client, sent } = await readyClient()
    void client.subscribe({ name: "project", projectId: PROJECT, quiet: true })
    const loud = client.hold({ name: "project", projectId: PROJECT })
    expect(sent()).toEqual(["subscribe 0 quiet", "unsubscribe 0", "subscribe 1"])
    loud.release()
    expect(sent().slice(3)).toEqual(["unsubscribe 1", "subscribe 2 quiet"])
  })

  it("hands each view holding a thread its replay, the second one too", async () => {
    const { client, socket, sent } = await readyClient()
    const heard: number[] = []
    client.onEvent(({ seq }) => heard.push(seq ?? -1))
    const first: number[] = []
    const second: number[] = []
    const a = client.hold(thread, ({ seq }) => first.push(seq ?? -1))
    socket.onmessage!({ data: replay("0", [0, 1, 2]) })
    socket.onmessage!({
      data: JSON.stringify({ kind: "push", subscriptionId: "0", seq: null, event: { type: "agent.text_delta", threadId: THREAD, turnId: THREAD, text: "x" } }),
    })
    // A second view on the same thread asks the server for the replay again.
    client.hold(thread, ({ seq }) => second.push(seq ?? -1))
    expect(sent()).toEqual(["subscribe 0", "unsubscribe 0", "subscribe 1"])
    socket.onmessage!({ data: replay("1", [0, 1, 2]) })
    expect(first).toEqual([0, 1, 2, -1, 0, 1, 2])
    expect(second).toEqual([0, 1, 2])
    // The rest of the tab heard each event once.
    expect(heard).toEqual([0, 1, 2, -1])
    a.release()
    expect(sent()).toHaveLength(3)
  })
})

describe("parseServerFrame", () => {
  const THREAD = "44444444-4444-4444-4444-444444444444"
  const delta = { type: "agent.text_delta", threadId: THREAD, turnId: THREAD, text: "x" }

  it("reads each kind of frame the server sends", () => {
    const frames = [
      { kind: "push", subscriptionId: "1", seq: null, event: delta },
      { kind: "push", subscriptionId: "1", seq: 4, at: "2026-01-01T00:00:00.000Z", event: delta },
      { kind: "ack", id: "2", events: [{ id: "9", seq: 3, projectId: THREAD, threadId: THREAD, createdAt: "x", event: delta }] },
      { kind: "error", id: null, code: "invalid", message: "no" },
      { kind: "ready", userId: THREAD, scopes: ["read"], serverVersion: "1", buildId: "b" },
      { kind: "replay", subscriptionId: "1", events: [{ seq: 5, at: "2026-01-01T00:00:00.000Z", projectId: THREAD, event: delta }], done: true },
      { kind: "revoked", subscriptionId: "1" },
      { kind: "pong", id: "3", serverTime: "2026-01-01T00:00:00.000Z" },
    ]
    for (const frame of frames) expect(parseServerFrame(JSON.stringify(frame))).toEqual(frame)
  })

  it("refuses what it could not use", () => {
    for (const raw of [
      "not json",
      "null",
      "[]",
      JSON.stringify({ kind: "push", subscriptionId: 1, seq: null, event: delta }),
      JSON.stringify({ kind: "push", subscriptionId: "1", seq: "4", event: delta }),
      JSON.stringify({ kind: "push", subscriptionId: "1", seq: null, event: { text: "no type" } }),
      JSON.stringify({ kind: "ack", id: "2", events: [{ seq: 1 }] }),
      JSON.stringify({ kind: "replay", subscriptionId: "1", events: [{ seq: null, event: delta }], done: true }),
      JSON.stringify({ kind: "ready", userId: THREAD }),
      JSON.stringify({ kind: "surprise" }),
    ]) {
      expect(parseServerFrame(raw)).toBeNull()
    }
  })
})

describe("UcchClient history", () => {
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it("hands tokens to listeners and keeps them out of the history", async () => {
    const { client, socket } = await readyClient()
    const heard: string[] = []
    client.onEvent(({ event }) => heard.push(event.type))
    const THREAD = "44444444-4444-4444-4444-444444444444"
    for (const type of ["agent.text_delta", "agent.thinking_delta"]) {
      socket.onmessage!({
        data: JSON.stringify({ kind: "push", subscriptionId: "1", seq: null, event: { type, threadId: THREAD, turnId: THREAD, text: "x" } }),
      })
    }
    socket.onmessage!({
      data: JSON.stringify({ kind: "push", subscriptionId: "1", seq: 0, event: { type: "user.message", threadId: THREAD, text: "hi" } }),
    })
    expect(heard).toEqual(["agent.text_delta", "agent.thinking_delta", "user.message"])
    expect(client.events.map((row) => row.event.type)).toEqual(["user.message"])
  })

  it("tells its change listeners once a frame", async () => {
    vi.useFakeTimers()
    try {
      const { client, socket } = await readyClient()
      const changed = vi.fn()
      client.subscribeToChanges(changed)
      const THREAD = "44444444-4444-4444-4444-444444444444"
      for (let seq = 0; seq < 20; seq++) {
        socket.onmessage!({
          data: JSON.stringify({ kind: "push", subscriptionId: "1", seq, event: { type: "user.message", threadId: THREAD, text: "hi" } }),
        })
      }
      expect(changed).not.toHaveBeenCalled()
      await vi.advanceTimersByTimeAsync(100)
      expect(changed).toHaveBeenCalledTimes(1)
      expect(client.events).toHaveLength(20)
    } finally {
      vi.useRealTimers()
    }
  })

  it("asks for replays in batches, and keeps one as it would the pushes", async () => {
    vi.useFakeTimers()
    try {
      const { client, socket, sent } = await readyClient()
      expect(new URL(socket.url).searchParams.get("caps")).toBe("replay1")
      const THREAD = "44444444-4444-4444-4444-444444444444"
      void client.subscribe({ name: "thread", threadId: THREAD })
      const heard: number[] = []
      client.onEvent(({ seq }) => heard.push(seq ?? -1))
      const changed = vi.fn()
      client.subscribeToChanges(changed)
      const at = "2026-01-01T00:00:00.000Z"
      const events = [0, 1, 2].map((seq) => ({ seq, at, projectId: PROJECT, event: { type: "user.message", threadId: THREAD, text: `m${seq}` } }))
      socket.onmessage!({ data: JSON.stringify({ kind: "replay", subscriptionId: "0", events: events.slice(0, 2), done: false }) })
      socket.onmessage!({ data: JSON.stringify({ kind: "replay", subscriptionId: "0", events: events.slice(1), done: true }) })
      expect(heard).toEqual([0, 1, 2])
      expect(client.events.map((row) => [row.seq, row.receivedAt, row.projectId])).toEqual([
        [0, Date.parse(at), PROJECT],
        [1, Date.parse(at), PROJECT],
        [2, Date.parse(at), PROJECT],
      ])
      await vi.advanceTimersByTimeAsync(100)
      expect(changed).toHaveBeenCalledTimes(1)
      // Back from a drop, it resumes after the last event the replay held.
      socket.onmessage!({
        data: JSON.stringify({ kind: "ready", userId: "11111111-1111-1111-1111-111111111111", scopes: ["read"], serverVersion: "test" }),
      })
      expect(sent()).toEqual(["subscribe 0", "subscribe 1"])
      expect(socket.sent[1]).toMatchObject({ sinceSeq: 2 })
    } finally {
      vi.useRealTimers()
    }
  })
})
