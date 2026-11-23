import type { ProviderId, TokenUsage } from "./events.js";
import { CHARS_PER_TOKEN } from "./tokens.js";

/**
 * How full a session's context may get before UCCH's own runtimes fold it.
 *
 * Past this share of the window OMP (its overlay's compaction threshold)
 * and the native loop (its compactor) compact mid-turn and carry on. The
 * vendors' CLIs are not set to it any more: Claude Code and Codex compact at
 * their own defaults (`claudeCompactThreshold`, `codexCompactThreshold`),
 * because every compaction leaves the prompt cache cold, and compacting less
 * often at a later point is the cheaper of the two. The server keeps them
 * from overflowing instead: it compacts in the same session between turns
 * past `CONTEXT_FORCE_RATIO`, before a turn that would not fit
 * (`overWindow`), and while the cache is still warm (`idleCompactAt`).
 */
export const CONTEXT_HANDOVER_RATIO = 0.55;

/**
 * The server's line for a Claude Code or Codex session: one that ends a turn
 * past it is compacted in its own session before the next message
 * (`thread.compact`, the CLI's own `/compact`), quietly. A handover to a new
 * session is the fallback only, when that compaction cannot run.
 */
export const CONTEXT_FORCE_RATIO = 0.75;

/** The token count a runtime that follows UCCH's line compacts at, for a window. */
export function compactAtTokens(windowTokens: number): number {
  return Math.floor(windowTokens * CONTEXT_HANDOVER_RATIO);
}

/**
 * What Claude Code keeps free for the summary: it compacts at the window
 * less this (t3code's `claudeAutoCompactThreshold`, and Claude Code 2.1.330's
 * own "effective window minus the summary buffer").
 */
export const CLAUDE_AUTOCOMPACT_BUFFER_TOKENS = 33_000;

/** Where Claude Code compacts on its own, for a window. */
export function claudeCompactThreshold(windowTokens: number): number {
  return Math.max(0, windowTokens - CLAUDE_AUTOCOMPACT_BUFFER_TOKENS);
}

/**
 * Where Codex compacts on its own when nothing overrides
 * `model_auto_compact_token_limit`: nine tenths of the model's window.
 */
export function codexCompactThreshold(windowTokens: number): number {
  return Math.floor(windowTokens * 0.9);
}

/**
 * The context window a CLI harness's model works in, before the CLI has said.
 *
 * Claude Code reports the real window itself (`modelUsage[].contextWindow`
 * on each turn's result), and Codex its rollout's `model_context_window`;
 * either wins once it arrives. This is the guess for a model that has not
 * run yet. Every current Claude model -- the 4.6 generation on, and the
 * bare `opus` / `sonnet` / `haiku` aliases, which the CLI resolves to the
 * newest -- has a 1M window; the older dated models are 200k unless the
 * alias asks for 1M (`[1m]`). Codex: 272k of input, a fallback only. Null
 * for a harness that reports its own (OMP) or whose models come from a
 * catalogue (the native loop).
 */
export function cliContextWindow(provider: ProviderId | string | null | undefined, model?: string | null): number | null {
  if (provider === "claude") return claudeContextWindow(model);
  if (provider === "codex") return 272_000;
  return null;
}

function claudeContextWindow(model: string | null | undefined): number {
  const id = (model ?? "").trim().toLowerCase();
  if (id.includes("[1m]")) return 1_000_000;
  // Claude 3 and earlier, by either naming: `claude-3-5-haiku`, `claude-2.1`.
  if (/claude-(?:[0-3](?:\b|[-.])|instant)/.test(id)) return 200_000;
  // `claude-opus-4-1`, `claude-sonnet-4-20250514`, `claude-haiku-4-5`: the
  // version is the numbers after the family, a dated snapshot's 8 digits
  // are not part of it. 1M became the default with 4.6 (Haiku: with 5).
  const named = /(opus|sonnet|haiku)-(\d+)(?:[-.](\d{1,2})(?!\d))?/.exec(id);
  if (named) {
    const major = Number(named[2]);
    const minor = Number(named[3] ?? 0);
    if (major < 4) return 200_000;
    if (major === 4 && (named[1] === "haiku" || minor < 6)) return 200_000;
  }
  return 1_000_000;
}

// -- Readings ----------------------------------------------------------------

/**
 * How much a reading can be trusted (t3code: "unknown, not zero"):
 * `complete` -- measured from the session's last model call; `partial` --
 * measured, with a part missing (no window, say); `unavailable` -- not
 * measured at all. An unavailable reading never shows as 0 and never
 * triggers a compaction or a handover.
 */
export type ReadingStatus = "complete" | "partial" | "unavailable";

/**
 * A session's latest context reading, as the server keeps it
 * (`threads.context_reading`) and serves it with the thread.
 */
export interface ContextReading {
  /** Tokens in the context after the last model call; null when unavailable. */
  usedTokens: number | null;
  /** The model's window, or null when nothing says. */
  windowTokens: number | null;
  /** Where the session compacts on its own, or null when nothing does or nothing said. */
  compactThreshold: number | null;
  /** When the prompt cache the session last wrote or read runs out, ISO; absent when unknown. */
  cacheExpiresAt?: string | null;
  /** That cache's lifetime, for a later reading that only reads from it. */
  cacheTtlMs?: number | null;
  /** Of `usedTokens`, how many the last call read from the cache. */
  cachedTokens?: number | null;
  /** The first call of the turn: the share of its input read from the cache, 0-1. */
  cacheHitRatio?: number | null;
  status: ReadingStatus;
  harness: ProviderId | null;
  model: string | null;
  /** When it was taken, ISO. */
  at: string;
  /** The turn it was taken in; absent for one taken between turns (a compaction). */
  turnId?: string | null;
}

/**
 * How full the context is after one model call: everything it was sent --
 * the fresh input and the cached prefix it read or wrote -- plus what it
 * wrote. Per call, never a sum over a turn's calls, which counts the same
 * history once for every call. `inputTokens` is uncached input
 * (`TokenUsage`), so the four parts never overlap.
 */
export function occupancy(lastCall: TokenUsage): number {
  return lastCall.inputTokens + lastCall.cacheReadInputTokens + lastCall.cacheCreationInputTokens + lastCall.outputTokens;
}

/**
 * The share of a call's input it read from the cache, 0-1, or null for a
 * call with no input at all.
 */
export function cacheHitRatio(call: TokenUsage): number | null {
  const total = call.inputTokens + call.cacheReadInputTokens + call.cacheCreationInputTokens;
  return total > 0 ? call.cacheReadInputTokens / total : null;
}

/**
 * Whether a reading is past the server's line (`CONTEXT_FORCE_RATIO`).
 * Unknown windows and unavailable readings never are.
 */
export function needsHandover(usedTokens: number | null | undefined, windowTokens: number | null | undefined): boolean {
  if (!usedTokens || !windowTokens || windowTokens <= 0) return false;
  return usedTokens / windowTokens >= CONTEXT_FORCE_RATIO;
}

/** `needsHandover` for a whole reading: nothing for one that was not measured. */
export function readingNeedsCompaction(reading: Pick<ContextReading, "usedTokens" | "windowTokens" | "status"> | null | undefined): boolean {
  if (!reading || reading.status === "unavailable") return false;
  return needsHandover(reading.usedTokens, reading.windowTokens);
}

/**
 * What a Claude Code or Codex session was started with, kept for its life
 * (`threads.session_prefix`, plan2 §2.3-2.5). Every resumed turn hands the
 * CLI the same appended system prompt and the same tools, so the cached
 * prefix -- tools, system prompt, history -- stays byte for byte the same;
 * what changes goes in the message instead.
 */
export interface SessionPrefix {
  provider: "claude" | "codex";
  /** The session this was built for; null until the CLI names it on the first turn. */
  sessionId: string | null;
  /** The instructions the session was handed (`--append-system-prompt`, or Codex's first message). */
  text: string;
  /** sha256 of `text`, hex: logged with every turn, and on a cache miss. */
  sha256: string;
  /** The project knowledge the session last saw (in `text`, or a later delta), for the next delta. */
  knowledge: string | null;
  knowledgeSha256: string | null;
  /** What the prompt was built for: a change of model starts a new prefix (its cache is cold anyway). */
  model: string | null;
  effort: string | null;
  /** The bridge's tool set, decided once at the session's start. */
  tools: { omp: boolean; subagents: boolean; messaging: boolean; widgets: boolean; browser?: boolean };
  /**
   * The bridge the text was written for: null when none opened (no bundle,
   * nothing to carry), `omp` when OMP's tools were on it. A turn that opens
   * a different one cannot keep the text, whose guides name its tools.
   */
  bridge?: { omp: boolean } | null;
  /**
   * Codex dropped the instructions with its history when it compacted
   * (plan2 §2.5): the next turn hands them over again, once.
   */
  resend?: boolean;
}

// -- Prompt cache ------------------------------------------------------------

export const CACHE_TTL_5M_MS = 5 * 60_000;
export const CACHE_TTL_1H_MS = 60 * 60_000;

/**
 * When a call's prompt cache runs out (t3code's `promptCacheExpiresAt`):
 * the request's start, not its end, plus the lifetime of what it wrote --
 * an hour when any of it was written for an hour, else five minutes. A call
 * that only read from the cache refreshed it, so the expiry moves on by the
 * lifetime the cache was written with (`previousTtlMs`). Anything else --
 * no cache touched, or a read with no known lifetime -- is unknown.
 */
export function cacheExpiry(input: {
  requestStartMs: number;
  cacheRead: number;
  creation5m: number;
  creation1h: number;
  /** All the call wrote, for a CLI that does not split it by lifetime. */
  creationTotal?: number;
  previousTtlMs?: number | null;
}): { expiresAtMs: number; ttlMs: number } | null {
  const ttl =
    input.creation1h > 0
      ? CACHE_TTL_1H_MS
      : input.creation5m > 0 || (input.creationTotal ?? 0) > 0
        ? CACHE_TTL_5M_MS
        : input.cacheRead > 0 && input.previousTtlMs
          ? input.previousTtlMs
          : null;
  return ttl ? { expiresAtMs: input.requestStartMs + ttl, ttlMs: ttl } : null;
}

// -- Budgets -----------------------------------------------------------------

/** What an attached picture weighs in a budget (t3code's `handoffBudget`). */
export const IMAGE_ATTACHMENT_TOKENS = 8_000;
/** What any other attached file weighs. */
export const FILE_ATTACHMENT_TOKENS = 4_000;
/** The most history a handover imports: a brief or a recap. */
export const HANDOFF_CAP_TOKENS = 16_000;
export const HANDOFF_CAP_BYTES = 64 * 1024;

/** The room kept free for the work itself: a quarter of the window, at least 16k, at most half. */
export function workReserveTokens(windowTokens: number): number {
  return Math.min(Math.floor(windowTokens / 2), Math.max(16_000, Math.floor(windowTokens / 4)));
}

/** The weight of a message's attachments. */
export function attachmentTokens(attachments: { images?: number; files?: number }): number {
  return (attachments.images ?? 0) * IMAGE_ATTACHMENT_TOKENS + (attachments.files ?? 0) * FILE_ATTACHMENT_TOKENS;
}

/**
 * How many tokens of imported history a new session can take (t3code's
 * `handoffBudget`): `min(cap, window − native − message − attachments −
 * reserve)`, never below 0. Without a window, the cap.
 */
export function handoffBudgetTokens(input: {
  windowTokens: number | null | undefined;
  /** What the session already holds of its own (its system prompt, its history). */
  nativeTokens?: number;
  messageTokens?: number;
  images?: number;
  files?: number;
}): number {
  if (!input.windowTokens || input.windowTokens <= 0) return HANDOFF_CAP_TOKENS;
  const room =
    input.windowTokens -
    (input.nativeTokens ?? 0) -
    (input.messageTokens ?? 0) -
    attachmentTokens(input) -
    workReserveTokens(input.windowTokens);
  return Math.max(0, Math.min(HANDOFF_CAP_TOKENS, room));
}

/** `handoffBudgetTokens` in characters, by the shared estimate, held to the byte cap. */
export function handoffBudgetChars(tokens: number): number {
  return Math.min(HANDOFF_CAP_BYTES, tokens * CHARS_PER_TOKEN);
}

/**
 * Whether a turn about to start would not fit (plan2 §3.4): the session's
 * reading, the new message, its attachments and the work reserve, against
 * the window. False when the reading or the window is unknown.
 */
export function overWindow(input: {
  reading: Pick<ContextReading, "usedTokens" | "windowTokens" | "status"> | null | undefined;
  messageTokens: number;
  images?: number;
  files?: number;
}): boolean {
  const reading = input.reading;
  if (!reading || reading.status === "unavailable" || reading.usedTokens === null || !reading.windowTokens) return false;
  const needed =
    reading.usedTokens + input.messageTokens + attachmentTokens(input) + workReserveTokens(reading.windowTokens);
  return needed > reading.windowTokens;
}

// -- Idle compaction ---------------------------------------------------------

/** A session smaller than this is not worth compacting while it waits (t3code: 200k). */
export const IDLE_COMPACT_MIN_TOKENS = 200_000;
/** How long before the cache runs out an idle compaction starts, so it still reads from it. */
export const IDLE_COMPACT_LEAD_MS = 2 * 60_000;

/**
 * When an idle Claude Code session should compact itself (t3code's
 * `idleCompactionWindow`, adapted): a measured reading at or above
 * `max(200k, half the compaction line)`, with a known cache expiry, gets
 * `/compact` `leadMs` before that expiry -- the compaction's own call then
 * reads the history from the cache. Null when it should not, or when that
 * moment has already passed.
 */
export function idleCompactAt(
  reading: ContextReading | null | undefined,
  nowMs: number,
  leadMs: number = IDLE_COMPACT_LEAD_MS,
): number | null {
  if (!reading || reading.harness !== "claude" || reading.status === "unavailable" || reading.usedTokens === null) return null;
  const floor = Math.max(IDLE_COMPACT_MIN_TOKENS, reading.compactThreshold ? 0.5 * reading.compactThreshold : 0);
  if (reading.usedTokens < floor) return null;
  if (!reading.cacheExpiresAt) return null;
  const expires = Date.parse(reading.cacheExpiresAt);
  if (!Number.isFinite(expires)) return null;
  const at = expires - leadMs;
  return at > nowMs ? at : null;
}

/** A thread as the idle compaction's skip rules read it, when its moment comes. */
export interface IdleCompactionState {
  enabled: boolean;
  status: string;
  archived: boolean;
  /** Permission prompts or choice cards still open. */
  pendingRequests: boolean;
  /** Subagents or background tasks of its still running. */
  backgroundWork: boolean;
  /** Nothing happened since the last compaction: it would fold nothing. */
  lastWasCompaction: boolean;
  /** The harness or model the reading was taken on is not the thread's any more. */
  harnessChanged: boolean;
  /** A turn started after the reading the schedule was made from. */
  newerTurn: boolean;
}

/**
 * Why an idle compaction due now must not run (t3code's skip rules, the
 * ones that apply here), or null when it should.
 */
export function idleCompactionSkip(state: IdleCompactionState): string | null {
  if (!state.enabled) return "idle compaction is off";
  if (state.archived) return "the thread is archived";
  if (state.status !== "idle") return "the thread is busy or queued";
  if (state.pendingRequests) return "a request is waiting on the person";
  if (state.backgroundWork) return "background work is still running";
  if (state.lastWasCompaction) return "the session was just compacted";
  if (state.harnessChanged) return "the harness or model changed";
  if (state.newerTurn) return "a newer turn ran";
  return null;
}

/** A resumed session this old and this full is offered a compaction first (plan2 §3.7). */
export const RESUME_COMPACT_MIN_TOKENS = 200_000;

/**
 * Whether a Claude Code session about to be resumed should be offered a
 * compaction first: big, and idle past its cache's life, so the resume
 * would pay for the whole history again.
 */
export function offerCompactOnResume(reading: ContextReading | null | undefined, nowMs: number): boolean {
  if (!reading || reading.harness !== "claude" || reading.status === "unavailable" || reading.usedTokens === null) return false;
  if (reading.usedTokens < RESUME_COMPACT_MIN_TOKENS || !reading.cacheExpiresAt) return false;
  const expires = Date.parse(reading.cacheExpiresAt);
  return Number.isFinite(expires) && expires < nowMs;
}
