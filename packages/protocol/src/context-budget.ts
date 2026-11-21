import type { ProviderId } from "./events.js";

/**
 * How full a session's context may get before it is folded.
 *
 * Past this share of the window a session compacts on its own, mid-turn,
 * the way the Claude Code CLI does: the work keeps running and nobody is
 * asked anything. Each harness does it with its own mechanism -- Claude
 * Code's auto-compact (`CLAUDE_AUTOCOMPACT_PCT_OVERRIDE`), Codex's
 * `model_auto_compact_token_limit`, OMP's compaction threshold, the native
 * loop's compactor -- all set here. Well short of the wall on purpose: a
 * model reasons worse in a crowded window long before it runs out of one.
 */
export const CONTEXT_HANDOVER_RATIO = 0.55;

/**
 * The fallback line (the Red zone): a CLI session that still ends a turn
 * past it -- its own compaction did not run, or did not fold enough -- is
 * handed over by the server between turns, quietly: a brief replaces the
 * history and the next message the person sends runs on it. Nothing is
 * sent on its own and nothing is shown.
 */
export const CONTEXT_FORCE_RATIO = 0.75;

/** The token count a CLI should compact itself at, for a window. */
export function compactAtTokens(windowTokens: number): number {
  return Math.floor(windowTokens * CONTEXT_HANDOVER_RATIO);
}

/**
 * The context window a CLI harness's model works in, before the CLI has said.
 *
 * Claude Code reports the real window itself (`modelUsage[].contextWindow`
 * on each turn's result), and that reading wins once it arrives; this is the
 * guess for a model that has not run yet. Every current Claude model -- the
 * 4.6 generation on, and the bare `opus` / `sonnet` / `haiku` aliases, which
 * the CLI resolves to the newest -- has a 1M window; the older dated
 * models are 200k unless the alias asks for 1M (`[1m]`). Codex: 272k of
 * input. Null for a harness that reports its own (OMP) or whose models come
 * from a catalogue (the native loop).
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

/**
 * Whether a reading is past the fallback line (`CONTEXT_FORCE_RATIO`), where
 * the server hands a session over between turns. Unknown windows never are.
 */
export function needsHandover(usedTokens: number | null | undefined, windowTokens: number | null | undefined): boolean {
  if (!usedTokens || !windowTokens || windowTokens <= 0) return false;
  return usedTokens / windowTokens >= CONTEXT_FORCE_RATIO;
}
