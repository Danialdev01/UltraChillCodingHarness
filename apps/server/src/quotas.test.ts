import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  openRouterWindows,
  parseClaudeUsage,
  parseCodexUsage,
  readClaudeAccessToken,
  readCodexTokens,
} from "./quotas.js";

describe("Claude usage", () => {
  it("reads the session and weekly windows as percents", () => {
    const windows = parseClaudeUsage({
      five_hour: { utilization: 47.0, resets_at: "2026-09-14T05:00:00.313171+00:00" },
      seven_day: { utilization: 49.0, resets_at: "2026-09-15T22:00:00+00:00" },
      seven_day_opus: null,
    });
    expect(windows).toEqual([
      { id: "session", label: "Session (5h)", usedPercent: 47, resetsAt: "2026-09-14T05:00:00.313Z" },
      { id: "weekly", label: "Weekly", usedPercent: 49, resetsAt: "2026-09-15T22:00:00.000Z" },
    ]);
  });

  it("clamps to the bar and tolerates a missing window", () => {
    expect(parseClaudeUsage({ five_hour: { utilization: 130 } })).toEqual([
      { id: "session", label: "Session (5h)", usedPercent: 100, resetsAt: null },
    ]);
    expect(parseClaudeUsage({ five_hour: null, seven_day: { utilization: -2 } })).toEqual([
      { id: "weekly", label: "Weekly", usedPercent: 0, resetsAt: null },
    ]);
    expect(parseClaudeUsage(null)).toEqual([]);
    expect(parseClaudeUsage({ five_hour: { utilization: "47" } })).toEqual([]);
  });
});

describe("Codex usage", () => {
  const now = Date.parse("2026-09-14T10:00:00Z");

  it("sorts the two windows by length and dates the reset from now", () => {
    const windows = parseCodexUsage(
      {
        rate_limit: {
          primary_window: { used_percent: 12, limit_window_seconds: 5 * 3600, reset_after_seconds: 3600 },
          secondary_window: { used_percent: 30, limit_window_seconds: 7 * 24 * 3600, reset_at: 1789000000 },
        },
      },
      now,
    );
    expect(windows).toEqual([
      { id: "session", label: "Session (5h)", usedPercent: 12, resetsAt: "2026-09-14T11:00:00.000Z" },
      { id: "weekly", label: "Weekly", usedPercent: 30, resetsAt: new Date(1789000000 * 1000).toISOString() },
    ]);
  });

  it("does not draw the same window twice, and nothing for no rate limit", () => {
    expect(
      parseCodexUsage(
        {
          rate_limit: {
            primary_window: { used_percent: 1, limit_window_seconds: 3600 },
            secondary_window: { used_percent: 2, limit_window_seconds: 7200 },
          },
        },
        now,
      ),
    ).toEqual([{ id: "session", label: "Session (1h)", usedPercent: 1, resetsAt: null }]);
    expect(parseCodexUsage({ rate_limit: null }, now)).toEqual([]);
    expect(parseCodexUsage({}, now)).toEqual([]);
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

describe("credential files", () => {
  it("reads only the token, and null for anything missing or malformed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "ucch-quota-"));
    expect(await readClaudeAccessToken(dir)).toBeNull();
    expect(await readCodexTokens(dir)).toBeNull();

    await writeFile(join(dir, ".credentials.json"), "{not json");
    expect(await readClaudeAccessToken(dir)).toBeNull();

    await writeFile(
      join(dir, ".credentials.json"),
      JSON.stringify({ claudeAiOauth: { accessToken: "sk-ant-oat01-x", refreshToken: "r" } }),
    );
    expect(await readClaudeAccessToken(dir)).toBe("sk-ant-oat01-x");

    await writeFile(join(dir, "auth.json"), JSON.stringify({ tokens: { access_token: "" } }));
    expect(await readCodexTokens(dir)).toBeNull();
    await writeFile(
      join(dir, "auth.json"),
      JSON.stringify({ tokens: { access_token: "eyJ", account_id: "acct_1" } }),
    );
    expect(await readCodexTokens(dir)).toEqual({ accessToken: "eyJ", accountId: "acct_1" });
  });
});
