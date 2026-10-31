import { describe, expect, it } from "vitest";
import { limitFallback, readAgentSettings, WorkspaceAgentSettings } from "./agent-settings.js";

describe("readAgentSettings", () => {
  it("is the defaults for a row written before the column", () => {
    for (const stored of [null, undefined, {}, "nonsense"]) {
      expect(readAgentSettings(stored)).toEqual({
        autoHandoff: { enabled: false, fallbackProvider: null },
        isolatedFanOut: { enabled: false },
      });
    }
  });

  it("keeps the sections that parse and defaults the rest", () => {
    expect(readAgentSettings({ autoHandoff: { enabled: true, fallbackProvider: "codex" } })).toEqual({
      autoHandoff: { enabled: true, fallbackProvider: "codex" },
      isolatedFanOut: { enabled: false },
    });
    expect(readAgentSettings({ isolatedFanOut: { enabled: true } }).isolatedFanOut).toEqual({ enabled: true });
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
