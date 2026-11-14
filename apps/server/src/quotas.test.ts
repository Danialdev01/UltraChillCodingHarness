import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { cliWindows, openRouterWindows } from "./quotas.js";

describe("CLI usage readings", () => {
  it("labels the windows and clamps them to the bar", () => {
    expect(cliWindows([
      { id: "session", usedPercent: 130, resetsAt: "2026-09-14T05:00:00.313Z", minutes: 300 },
      { id: "weekly", usedPercent: 49, resetsAt: null },
    ])).toEqual([
      { id: "session", label: "Session (5h)", usedPercent: 100, resetsAt: "2026-09-14T05:00:00.313Z" },
      { id: "weekly", label: "Weekly", usedPercent: 49, resetsAt: null },
    ]);
    expect(cliWindows([{ id: "session", usedPercent: 1, resetsAt: null, minutes: 60 }])[0]?.label).toBe("Session (1h)");
  });
});

describe("OpenRouter spend", () => {
  const base = { label: null, usageUsd: 3, limitUsd: null, limitRemainingUsd: null, freeTier: false, credits: null };

  it("prefers the key's own cap", () => {
    expect(
      openRouterWindows({ ...base, limitUsd: 10, limitRemainingUsd: 7, credits: { totalUsd: 100, usedUsd: 50 } }),
    ).toEqual([{ id: "spend", label: "Key limit", usedPercent: 30, resetsAt: null, detail: "$3.00 of $10.00" }]);
  });

  it("falls back to the balance, and says when there is neither", () => {
    expect(openRouterWindows({ ...base, credits: { totalUsd: 20, usedUsd: 25 } })).toEqual([
      { id: "spend", label: "Credits", usedPercent: 100, resetsAt: null, detail: "$20.00 of $20.00" },
    ]);
    expect(openRouterWindows(base)).toEqual([
      { id: "spend", label: "Spend", usedPercent: 0, resetsAt: null, detail: "$3.00 spent; no limit on this key" },
    ]);
  });
});

// The compliance rule (Claude Code legal and compliance): the harness never
// reads a CLI's sign-in, and never calls a vendor with its token.
it("never reads a CLI's credentials or calls a vendor's usage endpoint", async () => {
  const source = await readFile(join(import.meta.dirname, "quotas.ts"), "utf8");
  for (const forbidden of [".credentials.json", "auth.json", "api.anthropic.com", "chatgpt.com", "accessToken", "access_token"]) {
    expect(source).not.toContain(forbidden);
  }
});
