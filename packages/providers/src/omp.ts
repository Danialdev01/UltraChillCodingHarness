import type { AgentPermissionMode, ReasoningEffort } from "@ucch/protocol";

/**
 * OMP (oh-my-pi) as a provider: `omp --mode rpc-ui`, one process per turn,
 * talked to over JSONL (`omp-rpc.ts`). Design: documentation/omp/solution.md
 * §3; what the pinned version actually does: spike-report.md.
 *
 * Three flags are load-bearing, and each was measured rather than assumed:
 *
 * **`--mode rpc-ui`, not `rpc`.** Only `rpc-ui` asks the host about a tool
 * call (an `extension_ui_request` "Allow tool: …"); plain `rpc` has no one
 * to ask, so the approval mode could never reach the person. The cost is
 * that `rpc-ui` runs shell commands without a PTY, which a turn with
 * `CI=1` and `TERM=dumb` does not miss.
 *
 * **`--no-extensions`, always.** UCCH clones anything, and a repository's
 * `.omp/hooks/` is code that would run as the server user. The flag also
 * stops user-scope hooks and makes custom agents unrunnable, so UCCH's own
 * guard comes in through `--hook`, the one path it leaves open (OM0.4).
 * `--no-rules` likewise keeps a repository's `.omp/RULES.md` out of the
 * prompt, and an untrusted project adds `--no-lsp`: its `lsp.json`, at the
 * root or in `.omp/`, names a command OMP would run.
 *
 * **`--config <overlay>`.** The overlay outranks project config only for
 * the keys it names, so it names every policy key, the whole approval
 * table included (§4). It is per run, written by the server and deleted
 * after the turn.
 */

/** What `--approval-mode` gets for each UCCH permission mode (solution §3.2). */
export function approvalFor(mode: AgentPermissionMode | undefined): "always-ask" | "write" | "yolo" {
  switch (mode) {
    case "strict":
      // Reads run; writes and commands ask.
      return "always-ask";
    case "allow_all":
      return "yolo";
    default:
      // Reads and writes run; commands, `eval`, `browser` and `task` ask.
      return "write";
  }
}

/** `--thinking` for an effort, or null for none: `off` leaves the model's default. */
export function thinkingFor(effort: ReasoningEffort | undefined): string | null {
  if (!effort || effort === "off") return null;
  // OMP's levels include every one UCCH has, under the same names.
  return effort;
}

export function ompArgv(input: {
  bin: string;
  /** The per-run overlay (solution §4). */
  overlayPath: string;
  /** `<subject>/omp/sessions/<projectId>`: where sessions live and `--resume` looks. */
  sessionDir: string;
  /** Absolute path of the subject's copy of the guard hook (§3.9). */
  guardHookPath: string;
  /** A project a person has marked trusted keeps its language servers. */
  trusted: boolean;
  /** `openrouter/<OpenRouter id>`. Absent, OMP uses the overlay's default role. */
  model?: string;
  effort?: ReasoningEffort;
  /** The OMP session id of the thread's previous turn. */
  resumeToken?: string;
  permissionMode?: AgentPermissionMode;
  /**
   * Added to OMP's system prompt: the project's knowledge and UCCH's own
   * section. Sent on resumed turns too, since a session keeps the
   * conversation, not the flags it was started with.
   */
  appendSystemPrompt?: string;
  /** A wall-clock limit, `--max-time` syntax (`45m`). */
  maxTime?: string;
}): string[] {
  const argv = [
    input.bin,
    "--mode",
    "rpc-ui",
    "--config",
    input.overlayPath,
    "--session-dir",
    input.sessionDir,
    "--approval-mode",
    approvalFor(input.permissionMode),
    "--no-extensions",
    "--no-rules",
    // A title costs a model call per session and UCCH names threads itself.
    "--no-title",
    "--hook",
    input.guardHookPath,
  ];
  if (!input.trusted) argv.push("--no-lsp");
  if (input.model) argv.push("--model", input.model);
  const thinking = thinkingFor(input.effort);
  if (thinking) argv.push("--thinking", thinking);
  // Works in RPC mode with --session-dir. An unknown id exits 1 before
  // `ready`, and the turn fails with OMP's "not found" (spike report, OM0.3).
  if (input.resumeToken) argv.push("--resume", input.resumeToken);
  if (input.appendSystemPrompt) {
    // OMP reads this flag as "text or file contents": a value naming a file
    // that exists is replaced by the file. Knowledge comes from the
    // repository, so a project whose knowledge is just `/etc/passwd` would
    // put that file in the prompt. A trailing newline makes it text, always
    // (measured with 18.14.1).
    const text = input.appendSystemPrompt;
    argv.push("--append-system-prompt", text.endsWith("\n") ? text : `${text}\n`);
  }
  if (input.maxTime) argv.push("--max-time", input.maxTime);
  return argv;
}
