import type { ProviderId } from "./events.js";

/**
 * How full a session's context may get before it is handed over.
 *
 * Past this share of the window the session's next step is a handover: a
 * brief of the work so far replaces the history, on the same harness. Well
 * short of the wall on purpose -- a model reasons worse in a crowded window
 * long before it runs out of one, and a handover between turns costs one
 * brief where one forced mid-turn costs the turn.
 */
export const CONTEXT_HANDOVER_RATIO = 0.55;

/**
 * The context window a CLI harness's model works in, where the CLI does not
 * say: Claude Code's models are 200k unless the alias asks for the 1M
 * window (`[1m]`), Codex's 272k of input. Null for a harness that reports
 * its own (OMP) or whose models come from a catalogue (the native loop).
 */
export function cliContextWindow(provider: ProviderId | string | null | undefined, model?: string | null): number | null {
  if (provider === "claude") return /\[1m\]/i.test(model ?? "") ? 1_000_000 : 200_000;
  if (provider === "codex") return 272_000;
  return null;
}

/** Whether a reading is past the handover line. Unknown windows never are. */
export function needsHandover(usedTokens: number | null | undefined, windowTokens: number | null | undefined): boolean {
  if (!usedTokens || !windowTokens || windowTokens <= 0) return false;
  return usedTokens / windowTokens >= CONTEXT_HANDOVER_RATIO;
}
