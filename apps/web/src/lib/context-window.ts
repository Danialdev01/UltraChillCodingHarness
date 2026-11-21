/**
 * How full the model's context window is.
 *
 * The number itself is the provider's own reading of its last model call
 * (`context.usage`); this decides how to say it. Kept pure
 * because the thresholds are a judgement worth stating once and testing,
 * rather than three magic numbers inside a className.
 */

import { CONTEXT_FORCE_RATIO, CONTEXT_HANDOVER_RATIO } from "@ucch/protocol/plain";

/**
 * Where OMP and the native loop fold their context mid-turn
 * (`CONTEXT_HANDOVER_RATIO`). Claude Code and Codex compact at their own
 * defaults, which their readings report (`thresholdTokens`).
 */
export const HANDOVER_RATIO = CONTEXT_HANDOVER_RATIO;

/**
 * Where the session is folded next, as a share of the window: the line the
 * provider reported, or the server's own (`CONTEXT_FORCE_RATIO`, where it
 * compacts a Claude Code or Codex session between turns) when that comes
 * first or nothing was reported. The ring is red from there, and amber as
 * it nears.
 */
export function compactionLine(thresholdRatio: number | null): number {
  return Math.min(thresholdRatio ?? CONTEXT_FORCE_RATIO, CONTEXT_FORCE_RATIO);
}

/** Amber from this share of the way to the line. */
export const WARN_SHARE = 0.8;
/** The line when nothing is reported. */
export const FULL_RATIO = CONTEXT_FORCE_RATIO;
export const WARN_RATIO = FULL_RATIO * WARN_SHARE;

export type ContextTone = "idle" | "normal" | "warn" | "full";

export interface ContextUsage {
  /** Tokens in the conversation, or null before anything has been measured. */
  tokens: number | null;
  /** The model's window, or null when the catalogue does not say. */
  limit: number | null;
  /** 0-1, or null when either number is missing. */
  ratio: number | null;
  tone: ContextTone;
  /** What the bar reads out, e.g. "12.4k / 200k". */
  label: string;
  /**
   * Where the provider compacts, as a share of the window (0-1), or null
   * when it did not say or there is no window to place it in.
   */
  thresholdRatio: number | null;
}

/**
 * A token count in the units the composer has room for.
 *
 * One decimal, and only while it says something: "12.4k" is more precise
 * than "12k", but "12.0k" is the same number wearing a false precision.
 */
export function formatContextTokens(tokens: number): string {
  if (tokens < 1000) return String(Math.max(0, Math.round(tokens)));

  const trim = (value: number) => value.toFixed(1).replace(/\.0$/, "");
  const thousands = tokens / 1000;
  if (thousands < 1000) return `${thousands < 100 ? trim(thousands) : Math.round(thousands)}k`;
  return `${trim(thousands / 1000)}M`;
}

/**
 * The state of the context meter.
 *
 * Both inputs can be missing and they mean different things, so neither is
 * defaulted away: no tokens means no turn has completed yet, and no limit
 * means the catalogue does not publish a window for this model. Either way
 * the meter shows what it does know rather than inventing the rest.
 */
export function contextUsage(tokens: number | null, limit: number | null, threshold: number | null = null): ContextUsage {
  const thresholdRatio = limit && limit > 0 && threshold && threshold > 0 ? Math.min(1, threshold / limit) : null;
  if (tokens === null || tokens <= 0) {
    return {
      tokens,
      limit,
      ratio: null,
      tone: "idle",
      label: limit ? `0 / ${formatContextTokens(limit)}` : "no turns yet",
      thresholdRatio,
    };
  }

  if (!limit || limit <= 0) {
    return { tokens, limit: null, ratio: null, tone: "normal", label: formatContextTokens(tokens), thresholdRatio: null };
  }

  // Capped at 1: a provider counting a little differently from the published
  // window should overflow the bar's colour, never its width.
  const ratio = Math.min(1, tokens / limit);
  const line = compactionLine(thresholdRatio);
  return {
    tokens,
    limit,
    ratio,
    tone: ratio >= line ? "full" : ratio >= line * WARN_SHARE ? "warn" : "normal",
    label: `${formatContextTokens(tokens)} / ${formatContextTokens(limit)}`,
    thresholdRatio,
  };
}

/** The percentage, for the tooltip. Rounded up so a used window never reads 0%. */
export function contextPercent(ratio: number): number {
  return Math.min(100, Math.max(1, Math.ceil(ratio * 100)));
}

/**
 * How long the session's prompt cache stays warm, for the tooltip
 * ("cache warm · 12m left"), or null when it has run out or nobody knows.
 */
export function cacheWarmLabel(cacheExpiresAt: string | null | undefined, nowMs: number): string | null {
  if (!cacheExpiresAt) return null;
  const left = Date.parse(cacheExpiresAt) - nowMs;
  if (!Number.isFinite(left) || left <= 0) return null;
  const minutes = Math.ceil(left / 60_000);
  return `cache warm · ${minutes >= 60 ? `${Math.floor(minutes / 60)}h ${minutes % 60}m` : `${minutes}m`} left`;
}
