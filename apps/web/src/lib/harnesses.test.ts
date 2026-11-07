import { describe, expect, it } from "vitest"

import { claudeModelLabel, codexModelLabel, getHarness, harnessIdOf, sessionModelLabel, UNKNOWN_HARNESS } from "./harnesses"

describe("getHarness", () => {
  it("maps each provider a thread can be bound to", () => {
    expect(getHarness("claude").name).toBe("Claude Code")
    expect(getHarness("codex").name).toBe("Codex")
    // The native loop and OMP are both UCCH's own agent.
    expect(getHarness("native").id).toBe("ucch")
    expect(getHarness("omp").id).toBe("ucch")
    expect(getHarness("ucch").name).toBe("UCCH Agent")
  })

  it("falls back to a generic agent for anything else", () => {
    expect(getHarness("gemini")).toBe(UNKNOWN_HARNESS)
    expect(getHarness(null)).toBe(UNKNOWN_HARNESS)
    expect(getHarness("")).toBe(UNKNOWN_HARNESS)
    // Not tricked by Object.prototype.
    expect(getHarness("constructor")).toBe(UNKNOWN_HARNESS)
    expect(harnessIdOf("toString")).toBeNull()
  })
})

describe("model labels", () => {
  it("reads Claude ids and aliases", () => {
    expect(claudeModelLabel("claude-opus-5-5")).toBe("Opus 5.5")
    expect(claudeModelLabel("claude-sonnet-4-5-20250929")).toBe("Sonnet 4.5")
    expect(claudeModelLabel("anthropic/claude-haiku-4.5")).toBe("Haiku 4.5")
    expect(claudeModelLabel("opus")).toBe("Opus")
    expect(claudeModelLabel("sonnet[1m]")).toBe("Sonnet")
    expect(claudeModelLabel("something-else")).toBe("something-else")
  })

  it("reads Codex ids", () => {
    expect(codexModelLabel("gpt-5-codex")).toBe("GPT-5 Codex")
    expect(codexModelLabel("gpt-5.1-codex-mini")).toBe("GPT-5.1 Codex Mini")
    expect(codexModelLabel("o3")).toBe("o3")
  })

  it("names a session's model with its harness", () => {
    expect(sessionModelLabel("claude", "claude-opus-5-5")).toBe("Opus 5.5")
    expect(sessionModelLabel("omp", "openrouter/qwen/qwen3-coder")).toBe("UCCH Agent · qwen3-coder")
    expect(sessionModelLabel("native", "x/y", new Map([["x/y", "Qwen3 Coder"]]))).toBe("UCCH Agent · Qwen3 Coder")
    expect(sessionModelLabel("codex", null)).toBe("Codex")
    expect(sessionModelLabel(null, null)).toBe("Agent")
  })
})
