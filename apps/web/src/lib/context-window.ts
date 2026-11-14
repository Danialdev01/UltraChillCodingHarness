/**
 * How full the model's context window is.
 *
 * The number itself comes from the last completed turn's usage, which is what
 * the provider actually charged for; this decides how to say it. Kept pure
 * because the thresholds are a judgement worth stating once and testing,
 * rather than three magic numbers inside a className.
 */

import { CONTEXT_HANDOVER_RATIO } from "@ucch/protocol/plain";

/**
 * Where a session hands over (`CONTEXT_HANDOVER_RATIO`): the server makes
 * one by itself once a turn ends past it, so the ring should never read
 * much above it.
 */
export const HANDOVER_RATIO = CONTEXT_HANDOVER_RATIO;

/**
 * Where the ring changes colour: amber as the handover line nears, red at
 * it -- the next turn's end hands over.
 */
export const WARN_RATIO = 0.45;
export const FULL_RATIO = HANDOVER_RATIO;

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
  return {
    tokens,
    limit,
    ratio,
    tone: ratio >= FULL_RATIO ? "full" : ratio >= WARN_RATIO ? "warn" : "normal",
    label: `${formatContextTokens(tokens)} / ${formatContextTokens(limit)}`,
    thresholdRatio,
  };
}

/** The percentage, for the tooltip. Rounded up so a used window never reads 0%. */
export function contextPercent(ratio: number): number {
  return Math.min(100, Math.max(1, Math.ceil(ratio * 100)));
}
