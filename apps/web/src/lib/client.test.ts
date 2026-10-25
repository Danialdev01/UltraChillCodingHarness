import { TERMINAL_INPUT_MAX } from "@ucch/protocol"
import { afterEach, describe, expect, it, vi } from "vitest"

import { terminalPieces, UcchClient } from "./client"

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
  sent: Array<Record<string, unknown>> = []
  onmessage: ((message: { data: string }) => void) | null = null
  onclose: (() => void) | null = null
  onerror: (() => void) | null = null
  constructor() {
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
      const topic = frame.topic as { quiet?: boolean; files?: boolean } | undefined
      if (!topic) return `${frame.kind as string} ${frame.id as string}`
      return `${frame.kind as string} ${frame.id as string}${topic.quiet ? " quiet" : ""}${topic.files ? " files" : ""}`
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
})
