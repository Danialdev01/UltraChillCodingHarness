import { describe, expect, it } from "vitest";
import { limitFallback, readAgentSettings, WorkspaceAgentSettings } from "./agent-settings.js";

describe("readAgentSettings", () => {
  it("is the defaults for a row written before the column", () => {
    for (const stored of [null, undefined, {}, "nonsense"]) {
      expect(readAgentSettings(stored)).toEqual({
        autoHandoff: { enabled: false, fallbackProvider: null },
        isolatedFanOut: { enabled: false },
        ompBridge: { enabled: false },
        ompVerify: { enabled: false },
        memory: { enabled: false, llmMode: "smol", retainCliTurns: false },
        widgets: { enabled: true },
        idleCompaction: { enabled: true },
        terminals: { maxPerProject: 10 },
      });
    }
  });

  it("keeps the sections that parse and defaults the rest", () => {
    expect(readAgentSettings({ autoHandoff: { enabled: true, fallbackProvider: "codex" } })).toEqual({
      autoHandoff: { enabled: true, fallbackProvider: "codex" },
      isolatedFanOut: { enabled: false },
      ompBridge: { enabled: false },
      ompVerify: { enabled: false },
      memory: { enabled: false, llmMode: "smol", retainCliTurns: false },
      widgets: { enabled: true },
      idleCompaction: { enabled: true },
      terminals: { maxPerProject: 10 },
    });
    expect(readAgentSettings({ isolatedFanOut: { enabled: true } }).isolatedFanOut).toEqual({ enabled: true });
    expect(readAgentSettings({ ompBridge: { enabled: true } }).ompBridge).toEqual({ enabled: true });
    expect(readAgentSettings({ ompVerify: { enabled: true } }).ompVerify).toEqual({ enabled: true });
    expect(readAgentSettings({ widgets: { enabled: false } }).widgets).toEqual({ enabled: false });
    expect(readAgentSettings({ memory: { enabled: true } }).memory).toEqual({ enabled: true, llmMode: "smol", retainCliTurns: false });
    expect(readAgentSettings({ memory: { enabled: true, llmMode: "remote" } }).memory).toEqual({ enabled: false, llmMode: "smol", retainCliTurns: false });
    expect(readAgentSettings({ autoHandoff: { enabled: "yes", fallbackProvider: "gemini" } })).toEqual(
      WorkspaceAgentSettings.parse({}),
    );
  });
});

describe("limitFallback", () => {
  const on = (fallbackProvider: "claude" | "codex" | "omp" | null) =>
    readAgentSettings({ autoHandoff: { enabled: true, fallbackProvider } });

  it("names the fallback only when it is on, set, and someone else", () => {
    expect(limitFallback(on("codex"), "claude")).toBe("codex");
    expect(limitFallback(on("omp"), "codex")).toBe("omp");
    expect(limitFallback(on("claude"), "claude")).toBeNull();
    expect(limitFallback(on(null), "claude")).toBeNull();
    expect(limitFallback(readAgentSettings({ autoHandoff: { enabled: false, fallbackProvider: "codex" } }), "claude")).toBeNull();
  });
});

describe("idle compaction (plan2 §3.3)", () => {
  it("is on unless a workspace turns it off", () => {
    expect(readAgentSettings({}).idleCompaction).toEqual({ enabled: true });
    expect(readAgentSettings({ idleCompaction: { enabled: false } }).idleCompaction).toEqual({ enabled: false });
  });
});

describe("terminals per project", () => {
  it("is ten unless the workspace sets it, from 1 to 50", () => {
    expect(readAgentSettings({}).terminals).toEqual({ maxPerProject: 10 });
    expect(readAgentSettings({ terminals: { maxPerProject: 3 } }).terminals).toEqual({ maxPerProject: 3 });
    expect(readAgentSettings({ terminals: { maxPerProject: 50 } }).terminals).toEqual({ maxPerProject: 50 });
    for (const bad of [0, 51, 2.5, "4"]) {
      expect(readAgentSettings({ terminals: { maxPerProject: bad } }).terminals).toEqual({ maxPerProject: 10 });
    }
  });
});
