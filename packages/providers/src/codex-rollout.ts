import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import type { TokenUsage } from "@ucch/protocol";

/**
 * What a Codex session's rollout file says about its context, from a byte
 * offset on: the CLI's own per-call reading, which `codex exec --json` does
 * not print.
 *
 * Checked against codex-cli 0.170.0 (`fixtures/codex-rollout.jsonl`, two
 * `exec` turns, a `/compact` sent as a message and an app-server
 * `thread/compact/start`):
 *
 * - `turn.completed.usage` on stdout is the **thread's running total**, not
 *   the turn's: the second turn of the fixture reports 31,116 input tokens,
 *   the first turn's 15,549 plus its own 15,567. Neither it nor a sum of it
 *   is how full the context is.
 * - Each model call writes an `event_msg` `token_count` whose
 *   `info.last_token_usage` is that call alone and `info.total_token_usage`
 *   the running total; `info.model_context_window` is the model's real
 *   window (475,000 for gpt-6.1-sol, not the 272k guess).
 * - Codex's `input_tokens` includes `cached_input_tokens`;
 *   `last_token_usage.total_tokens` is input plus output, the context's size.
 * - A compaction writes a top-level `compacted` line; the `token_count`
 *   after it has zeros for every part but `total_tokens`, the folded size.
 * - `codex exec resume <id> "/compact"` does **not** compact: the model
 *   just answers "Compacted." (the fixture's third turn). The app server's
 *   `thread/compact/start` does.
 */

export interface CodexTokenCount {
  input: number;
  cached: number;
  output: number;
  total: number;
}

export interface CodexRolloutReading {
  /** The last call's usage, or null when the read found no `token_count`. */
  last: CodexTokenCount | null;
  /**
   * The first call's usage in the read: on a resumed turn, how much of the
   * session came back from the prompt cache (plan2 §2.2). Absent on a
   * reading built before this field existed.
   */
  first?: CodexTokenCount | null;
  /** The running total at the last `token_count` read. */
  total: CodexTokenCount | null;
  /** The model's window, from the last `token_count` that named it. */
  windowTokens: number | null;
  /** A `compacted` line was read, and the size after it when a reading followed. */
  compactions: { tokensAfter: number | null }[];
}

function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function tokenCount(raw: unknown): CodexTokenCount | null {
  if (!raw || typeof raw !== "object") return null;
  const u = raw as Record<string, unknown>;
  const input = count(u.input_tokens);
  const output = count(u.output_tokens);
  return { input, cached: Math.min(input, count(u.cached_input_tokens)), output, total: count(u.total_tokens) || input + output };
}

/** Folds one rollout line into a reading. Lines that are not JSON, or not about tokens, change nothing. */
export function foldRolloutLine(reading: CodexRolloutReading, line: string): void {
  let record: { type?: unknown; payload?: { type?: unknown; info?: Record<string, unknown> | null } };
  try {
    record = JSON.parse(line);
  } catch {
    return;
  }
  if (record?.type === "compacted") {
    reading.compactions.push({ tokensAfter: null });
    return;
  }
  if (record?.type !== "event_msg" || record.payload?.type !== "token_count") return;
  const info = record.payload.info;
  if (!info) return;
  const last = tokenCount(info.last_token_usage);
  const total = tokenCount(info.total_token_usage);
  if (last) {
    if (!reading.first) reading.first = last;
    reading.last = last;
    const pending = reading.compactions.at(-1);
    if (pending && pending.tokensAfter === null) pending.tokensAfter = last.total;
  }
  if (total) reading.total = total;
  const window = count(info.model_context_window);
  if (window > 0) reading.windowTokens = window;
}

/**
 * Reads a rollout: what was written from `offset` (bytes) on -- this turn --
 * and the running total as it stood before it, for the turn's own usage.
 * Resolves empty for a file that cannot be read.
 */
export async function readCodexRollout(path: string, offset = 0): Promise<{ before: CodexTokenCount | null; reading: CodexRolloutReading }> {
  const earlier: CodexRolloutReading = { last: null, first: null, total: null, windowTokens: null, compactions: [] };
  const reading: CodexRolloutReading = { last: null, first: null, total: null, windowTokens: null, compactions: [] };
  const lines = createInterface({ input: createReadStream(path), crlfDelay: Infinity });
  let at = 0;
  try {
    for await (const line of lines) {
      foldRolloutLine(at < offset ? earlier : reading, line);
      at += Buffer.byteLength(line, "utf8") + 1;
    }
  } catch {
    // An unreadable rollout is a reading nobody has: unavailable, not an error.
  } finally {
    lines.close();
  }
  if (reading.windowTokens === null) reading.windowTokens = earlier.windowTokens;
  return { before: earlier.total, reading };
}

/** The last call's usage as `TokenUsage`: uncached input apart from the cached part. */
export function lastCallUsage(last: CodexTokenCount): TokenUsage {
  return {
    inputTokens: Math.max(0, last.input - last.cached),
    outputTokens: last.output,
    cacheReadInputTokens: last.cached,
    cacheCreationInputTokens: 0,
  };
}

/** A turn's usage: the running total after it less the one before it. */
export function turnUsage(after: CodexTokenCount, before: CodexTokenCount | null): TokenUsage {
  const d = (pick: (c: CodexTokenCount) => number) => Math.max(0, pick(after) - (before ? pick(before) : 0));
  const input = d((c) => c.input);
  const cached = Math.min(input, d((c) => c.cached));
  return { inputTokens: input - cached, outputTokens: d((c) => c.output), cacheReadInputTokens: cached, cacheCreationInputTokens: 0 };
}
