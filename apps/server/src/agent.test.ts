import { describe, expect, it } from "vitest";
import { resolveModel, resolveProvider } from "./agent.js";

describe("resolveModel", () => {
  const SERVER = "anthropic/claude-sonnet-5";
  const ACCOUNT = "openai/gpt-5";

  it("uses what the turn asked for, over both defaults", () => {
    expect(resolveModel("x-ai/grok-4", ACCOUNT, SERVER)).toBe("x-ai/grok-4");
  });

  it("falls back to the account's default from Settings", () => {
    // A turn that names no model -- another client, or one the harness starts.
    expect(resolveModel(undefined, ACCOUNT, SERVER)).toBe(ACCOUNT);
  });

  it("falls back to the server's default when the account has chosen none", () => {
    expect(resolveModel(undefined, null, SERVER)).toBe(SERVER);
  });

  it("treats an empty choice as no choice", () => {
    // A cleared field arrives as "", and a turn billed to the model id "" fails
    // at OpenRouter with an error nobody can place.
    expect(resolveModel("", ACCOUNT, SERVER)).toBe(ACCOUNT);
    expect(resolveModel("   ", "", SERVER)).toBe(SERVER);
    expect(resolveModel(undefined, "  ", SERVER)).toBe(SERVER);
  });

  it("trims a model id rather than sending one with spaces on it", () => {
    expect(resolveModel(" openai/gpt-5 ", null, SERVER)).toBe("openai/gpt-5");
  });
});

describe("resolveProvider", () => {
  it("keeps a bound thread on its provider whatever was asked", () => {
    expect(resolveProvider("codex", "claude", "native")).toBe("claude");
    expect(resolveProvider(undefined, "codex", "claude")).toBe("codex");
  });

  it("takes the turn's request over the account default", () => {
    expect(resolveProvider("codex", null, "claude")).toBe("codex");
  });

  it("falls back to the account default, then the native loop", () => {
    expect(resolveProvider(undefined, null, "claude")).toBe("claude");
    expect(resolveProvider(undefined, null, null)).toBe("native");
  });

  it("ignores a value it does not know", () => {
    // A column written by a future version, or a hand-edited row.
    expect(resolveProvider(undefined, "gemini", null)).toBe("native");
  });
});
