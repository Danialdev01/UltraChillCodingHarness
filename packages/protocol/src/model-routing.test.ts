import { describe, expect, it } from "vitest";
import { matchCatalogue, parseModelRequest, resolveHarness, type RoutingInput } from "./model-routing.js";

const catalogue = [
  { id: "anthropic/claude-opus-5.5", name: "Anthropic: Claude Opus 5.5" },
  { id: "anthropic/claude-opus-4.5", name: "Anthropic: Claude Opus 4.5" },
  { id: "openai/gpt-6-sol", name: "OpenAI: GPT-6 Sol" },
  { id: "moonshotai/kimi-k2", name: "MoonshotAI: Kimi K2" },
  { id: "moonshotai/kimi-k2:free", name: "MoonshotAI: Kimi K2 (free)" },
  { id: "google/gemini-3-pro", name: "Google: Gemini 3 Pro" },
  { id: "google/gemini-3-pro-preview", name: "Google: Gemini 3 Pro Preview" },
  { id: "qwen/qwen3-coder", name: "Qwen: Qwen3 Coder" },
  { id: "qwen/qwen3-coder-plus", name: "Qwen: Qwen3 Coder Plus" },
  { id: "mistral/devstral-a", name: "Devstral A" },
  { id: "mistral/devstral-b", name: "Devstral B" },
];

function input(overrides: Partial<RoutingInput> = {}): RoutingInput {
  return {
    harnesses: [
      { provider: "claude", usable: true },
      { provider: "codex", usable: true },
      { provider: "omp", usable: true },
    ],
    catalogue,
    parent: { provider: "claude", model: "claude-sonnet-5-5" },
    customProvider: "omp",
    ...overrides,
  };
}

describe("parseModelRequest", () => {
  it("reads the user's examples", () => {
    expect(parseModelRequest("opus 5.5")).toMatchObject({ family: "claude", cliModel: "claude-opus-5-5" });
    expect(parseModelRequest("gpt6 sol")).toMatchObject({ family: "openai", cliModel: "gpt-6-sol" });
  });

  it("keeps OpenAI's dots and Claude's aliases", () => {
    expect(parseModelRequest("GPT 5.1 Codex").cliModel).toBe("gpt-5.1-codex");
    expect(parseModelRequest("opus").cliModel).toBe("opus");
    expect(parseModelRequest("Claude Sonnet 5.5").cliModel).toBe("claude-sonnet-5-5");
    expect(parseModelRequest("anthropic/claude-opus-5.5").cliModel).toBe("claude-opus-5-5");
    expect(parseModelRequest("o4-mini")).toMatchObject({ family: "openai", cliModel: "o4-mini" });
  });

  it("calls anything else other", () => {
    expect(parseModelRequest("kimi k2").family).toBe("other");
    expect(parseModelRequest("gemini 3 pro").family).toBe("other");
  });
});

describe("resolveHarness", () => {
  it("inherits the parent's harness and model when none is named", () => {
    expect(resolveHarness(undefined, input())).toMatchObject({
      ok: true,
      provider: "claude",
      model: "claude-sonnet-5-5",
      via: "inherit",
    });
    expect(resolveHarness("  ", input())).toMatchObject({ via: "inherit" });
  });

  it("puts Claude models on Claude Code and OpenAI models on Codex", () => {
    expect(resolveHarness("opus 5.5", input())).toMatchObject({ ok: true, provider: "claude", model: "claude-opus-5-5" });
    expect(resolveHarness("gpt6 sol", input())).toMatchObject({ ok: true, provider: "codex", model: "gpt-6-sol" });
  });

  it("falls back to OpenRouter when the vendor's CLI is not signed in", () => {
    const routed = resolveHarness(
      "opus 5.5",
      input({ harnesses: [{ provider: "claude", usable: false }, { provider: "omp", usable: true }] }),
    );
    expect(routed).toMatchObject({ ok: true, provider: "omp", model: "anthropic/claude-opus-5.5", via: "openrouter" });
  });

  it("finds other models in the catalogue, preferring the untagged one", () => {
    expect(resolveHarness("kimi k2", input())).toMatchObject({ ok: true, provider: "omp", model: "moonshotai/kimi-k2" });
    expect(resolveHarness("gemini 3 pro", input())).toMatchObject({ ok: true, model: "google/gemini-3-pro" });
    expect(resolveHarness("qwen3 coder", input())).toMatchObject({ ok: true, model: "qwen/qwen3-coder" });
    expect(resolveHarness("moonshotai/kimi-k2:free", input())).toMatchObject({ ok: true, model: "moonshotai/kimi-k2:free" });
  });

  it("runs OpenRouter models on the native loop without OMP", () => {
    const routed = resolveHarness(
      "kimi k2",
      input({ customProvider: "native", harnesses: [{ provider: "native", usable: true }] }),
    );
    expect(routed).toMatchObject({ ok: true, provider: "native" });
  });

  it("asks for a choice when two models fit equally", () => {
    const routed = resolveHarness("devstral", input());
    expect(routed.ok).toBe(false);
    if (!routed.ok) expect(routed.candidates).toEqual(["mistral/devstral-a", "mistral/devstral-b"]);
  });

  it("says why when nothing can run it", () => {
    expect(resolveHarness("nonexistent thing", input())).toMatchObject({ ok: false, candidates: [] });
    const nothing = resolveHarness("kimi k2", input({ harnesses: [] }));
    expect(nothing).toMatchObject({ ok: false });
  });
});

describe("matchCatalogue", () => {
  it("does not match an older version", () => {
    const matches = matchCatalogue(parseModelRequest("opus 5.5"), catalogue);
    expect(matches.map(({ model }) => model.id)).toEqual(["anthropic/claude-opus-5.5"]);
  });
});
