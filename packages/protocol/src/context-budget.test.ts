import { describe, expect, it } from "vitest";
import { cliContextWindow } from "./context-budget.js";

describe("cliContextWindow", () => {
  it("gives current Claude models and the bare aliases a 1M window", () => {
    for (const model of ["opus", "sonnet", "haiku", "claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5", "claude-fable-5-2", "claude-opus-4-8", "claude-sonnet-4-6"]) {
      expect(cliContextWindow("claude", model), model).toBe(1_000_000);
    }
  });

  it("keeps the older models at 200k unless the alias asks for 1M", () => {
    for (const model of ["claude-haiku-4-5", "claude-sonnet-4-5-20250929", "claude-opus-4-1", "claude-sonnet-4-20250514", "claude-3-5-haiku-20241022"]) {
      expect(cliContextWindow("claude", model), model).toBe(200_000);
    }
    expect(cliContextWindow("claude", "claude-sonnet-4-5[1m]")).toBe(1_000_000);
  });

  it("knows Codex's window and leaves the rest to their own reports", () => {
    expect(cliContextWindow("codex", "gpt-6")).toBe(272_000);
    expect(cliContextWindow("omp", "anything")).toBeNull();
  });
});
