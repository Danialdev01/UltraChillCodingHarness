import { describe, expect, it } from "vitest";
import {
  CACHE_TTL_1H_MS,
  CACHE_TTL_5M_MS,
  cacheExpiry,
  cacheHitRatio,
  claudeCompactThreshold,
  cliContextWindow,
  codexCompactThreshold,
  handoffBudgetChars,
  handoffBudgetTokens,
  HANDOFF_CAP_BYTES,
  HANDOFF_CAP_TOKENS,
  idleCompactAt,
  idleCompactionSkip,
  occupancy,
  offerCompactOnResume,
  overWindow,
  readingNeedsCompaction,
  workReserveTokens,
  type ContextReading,
  type IdleCompactionState,
} from "./context-budget.js";

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

describe("occupancy (plan2 §1.2)", () => {
  it("is the last call's four parts, which never overlap", () => {
    // Claude Code 2.1.330's first call of a turn: almost all of it written to the cache.
    expect(occupancy({ inputTokens: 2, cacheCreationInputTokens: 20_333, cacheReadInputTokens: 0, outputTokens: 4 })).toBe(20_339);
    expect(occupancy({ inputTokens: 207, cacheCreationInputTokens: 0, cacheReadInputTokens: 15_360, outputTokens: 5 })).toBe(15_572);
  });

  it("reads the share of the input that came from the cache, and nothing for no input", () => {
    expect(cacheHitRatio({ inputTokens: 10, cacheReadInputTokens: 90, cacheCreationInputTokens: 0, outputTokens: 5 })).toBe(0.9);
    expect(cacheHitRatio({ inputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, outputTokens: 0 })).toBeNull();
  });
});

describe("where each CLI compacts on its own (plan2 §3.1)", () => {
  it("is the window less the summary buffer for Claude Code, nine tenths of it for Codex", () => {
    expect(claudeCompactThreshold(1_000_000)).toBe(967_000);
    expect(claudeCompactThreshold(200_000)).toBe(167_000);
    expect(codexCompactThreshold(475_000)).toBe(427_500);
  });

  it("compacts a measured session past three quarters of its window, never an unmeasured one", () => {
    const at = (usedTokens: number | null, status: ContextReading["status"] = "complete") => ({ usedTokens, windowTokens: 1_000_000, status });
    expect(readingNeedsCompaction(at(749_999))).toBe(false);
    expect(readingNeedsCompaction(at(750_000))).toBe(true);
    expect(readingNeedsCompaction(at(900_000, "unavailable"))).toBe(false);
    expect(readingNeedsCompaction(at(null))).toBe(false);
    expect(readingNeedsCompaction({ usedTokens: 900_000, windowTokens: null, status: "partial" })).toBe(false);
    expect(readingNeedsCompaction(null)).toBe(false);
  });
});

describe("cacheExpiry (plan2 §2.1)", () => {
  const start = Date.parse("2026-11-21T10:00:00Z");
  it.each([
    ["an hour's write", { creation1h: 20_333, creation5m: 0, cacheRead: 0 }, CACHE_TTL_1H_MS],
    ["both lifetimes: the hour wins", { creation1h: 10, creation5m: 10, cacheRead: 5 }, CACHE_TTL_1H_MS],
    ["five minutes' write", { creation1h: 0, creation5m: 500, cacheRead: 0 }, CACHE_TTL_5M_MS],
    ["a write with no split", { creation1h: 0, creation5m: 0, cacheRead: 0, creationTotal: 300 }, CACHE_TTL_5M_MS],
    ["a read, refreshed by the lifetime it was written with", { creation1h: 0, creation5m: 0, cacheRead: 9_000, previousTtlMs: CACHE_TTL_1H_MS }, CACHE_TTL_1H_MS],
  ])("%s", (_name, input, ttl) => {
    expect(cacheExpiry({ requestStartMs: start, ...input })).toEqual({ expiresAtMs: start + ttl, ttlMs: ttl });
  });

  it("does not know for a read whose lifetime is unknown, or a call that touched no cache", () => {
    expect(cacheExpiry({ requestStartMs: start, creation1h: 0, creation5m: 0, cacheRead: 9_000 })).toBeNull();
    expect(cacheExpiry({ requestStartMs: start, creation1h: 0, creation5m: 0, cacheRead: 0, previousTtlMs: CACHE_TTL_1H_MS })).toBeNull();
  });
});

describe("the handover budget (plan2 §3.5, after t3code's handoffBudget)", () => {
  it("keeps a quarter of the window for the work, at least 16k and at most half", () => {
    expect(workReserveTokens(1_000_000)).toBe(250_000);
    expect(workReserveTokens(40_000)).toBe(16_000);
    expect(workReserveTokens(20_000)).toBe(10_000);
  });

  it("caps what a brief or recap imports, and leaves room for the message, attachments and the work", () => {
    expect(handoffBudgetTokens({ windowTokens: 1_000_000 })).toBe(HANDOFF_CAP_TOKENS);
    expect(handoffBudgetTokens({ windowTokens: null })).toBe(HANDOFF_CAP_TOKENS);
    // 64k: 16k reserve, 30k message, two images (16k): 2k left.
    expect(handoffBudgetTokens({ windowTokens: 64_000, messageTokens: 30_000, images: 2 })).toBe(2_000);
    expect(handoffBudgetTokens({ windowTokens: 64_000, messageTokens: 60_000 })).toBe(0);
    expect(handoffBudgetTokens({ windowTokens: 64_000, nativeTokens: 40_000, files: 1 })).toBe(4_000);
  });

  it("counts characters by the shared estimate, held to the byte cap", () => {
    expect(handoffBudgetChars(1_000)).toBe(4_000);
    expect(handoffBudgetChars(HANDOFF_CAP_TOKENS * 2)).toBe(HANDOFF_CAP_BYTES);
  });
});

describe("overWindow (plan2 §3.4)", () => {
  const reading = (usedTokens: number | null, status: ContextReading["status"] = "complete") => ({ usedTokens, windowTokens: 200_000, status });
  it("is over when the reading, the message, its attachments and the work reserve do not fit", () => {
    // 200k window: a 50k reserve.
    expect(overWindow({ reading: reading(140_000), messageTokens: 10_000 })).toBe(false);
    expect(overWindow({ reading: reading(140_000), messageTokens: 10_001 })).toBe(true);
    expect(overWindow({ reading: reading(140_000), messageTokens: 0, files: 2 })).toBe(false);
    expect(overWindow({ reading: reading(140_000), messageTokens: 0, images: 1, files: 1 })).toBe(true);
    expect(overWindow({ reading: reading(140_000), messageTokens: 0, images: 2 })).toBe(true);
  });

  it("is never over for a reading nobody has", () => {
    expect(overWindow({ reading: reading(190_000, "unavailable"), messageTokens: 10_000 })).toBe(false);
    expect(overWindow({ reading: reading(null), messageTokens: 1_000_000 })).toBe(false);
    expect(overWindow({ reading: null, messageTokens: 1_000_000 })).toBe(false);
  });
});

describe("idle compaction (plan2 §3.3, after t3code's IdleCompaction.test.ts)", () => {
  const now = Date.parse("2026-11-21T10:00:00Z");
  const reading = (over: Partial<ContextReading> = {}): ContextReading => ({
    usedTokens: 500_000,
    windowTokens: 1_000_000,
    compactThreshold: 967_000,
    cacheExpiresAt: "2026-11-21T10:30:00.000Z",
    status: "complete",
    harness: "claude",
    model: "claude-opus-5-5",
    at: "2026-11-21T09:30:00.000Z",
    ...over,
  });

  it.each<[string, Partial<ContextReading>, number | null]>([
    ["due two minutes before the cache runs out", {}, Date.parse("2026-11-21T10:28:00Z")],
    ["not below 200k, on a window whose half-line is lower", { usedTokens: 199_999, windowTokens: 200_000, compactThreshold: 167_000 }, null],
    ["at 200k on that window", { usedTokens: 200_000, windowTokens: 200_000, compactThreshold: 167_000 }, Date.parse("2026-11-21T10:28:00Z")],
    ["not below half the compaction line, when that is higher", { usedTokens: 450_000, compactThreshold: 967_000 }, null],
    ["at half the compaction line", { usedTokens: 483_500 }, Date.parse("2026-11-21T10:28:00Z")],
    ["not without a known expiry", { cacheExpiresAt: null }, null],
    ["not when the moment has passed", { cacheExpiresAt: "2026-11-21T10:01:00.000Z" }, null],
    ["not for Codex", { harness: "codex" }, null],
    ["not for an unavailable reading", { status: "unavailable" }, null],
  ])("%s", (_name, over, due) => {
    expect(idleCompactAt(reading(over), now)).toBe(due);
  });

  it("takes a lead of its own", () => {
    expect(idleCompactAt(reading(), now, 25 * 60_000)).toBe(Date.parse("2026-11-21T10:05:00Z"));
  });

  const ready: IdleCompactionState = {
    enabled: true,
    status: "idle",
    archived: false,
    pendingRequests: false,
    backgroundWork: false,
    lastWasCompaction: false,
    harnessChanged: false,
    newerTurn: false,
  };
  it.each<[string, Partial<IdleCompactionState>, string | null]>([
    ["runs on an idle thread", {}, null],
    ["skips when turned off", { enabled: false }, "idle compaction is off"],
    ["skips an archived thread", { archived: true }, "the thread is archived"],
    ["skips a busy thread", { status: "running" }, "the thread is busy or queued"],
    ["skips a queued thread", { status: "queued" }, "the thread is busy or queued"],
    ["skips while a question waits", { pendingRequests: true }, "a request is waiting on the person"],
    ["skips while subagents run", { backgroundWork: true }, "background work is still running"],
    ["skips right after a compaction", { lastWasCompaction: true }, "the session was just compacted"],
    ["skips when the harness changed", { harnessChanged: true }, "the harness or model changed"],
    ["skips when a newer turn ran", { newerTurn: true }, "a newer turn ran"],
  ])("%s", (_name, over, reason) => {
    expect(idleCompactionSkip({ ...ready, ...over })).toBe(reason);
  });
});

describe("offerCompactOnResume (plan2 §3.7)", () => {
  const now = Date.parse("2026-11-21T12:00:00Z");
  const reading = (over: Partial<ContextReading> = {}): ContextReading => ({
    usedTokens: 250_000,
    windowTokens: 1_000_000,
    compactThreshold: 967_000,
    cacheExpiresAt: "2026-11-21T10:30:00.000Z",
    status: "complete",
    harness: "claude",
    model: null,
    at: "2026-11-21T09:30:00.000Z",
    ...over,
  });
  it("offers it for a big Claude session whose cache has run out", () => {
    expect(offerCompactOnResume(reading(), now)).toBe(true);
  });
  it("does not for a warm cache, a small session, an unknown expiry or another harness", () => {
    expect(offerCompactOnResume(reading({ cacheExpiresAt: "2026-11-21T12:30:00.000Z" }), now)).toBe(false);
    expect(offerCompactOnResume(reading({ usedTokens: 199_999 }), now)).toBe(false);
    expect(offerCompactOnResume(reading({ cacheExpiresAt: null }), now)).toBe(false);
    expect(offerCompactOnResume(reading({ harness: "codex" }), now)).toBe(false);
  });
});
