/**
 * OMP's tools and their approval tiers, and its sources for other agents'
 * configuration, shared by the server's per-turn
 * overlay (`apps/server/src/omp-overlay.ts`) and the bridge's per-call guard
 * (`packages/omp-bridge/src/guard.ts`).
 */

/** OMP's approval tiers ([approvals](https://omp.sh/docs/approvals)). */
export type OmpTier = "read" | "write" | "exec";

/**
 * Every tool 18.14.1 can register, with its tier from
 * [tools](https://omp.sh/docs/tools). The names are the binary's own
 * ("Built-in tools" and "Other registered tools" in its `--tools` error),
 * plus the `xd://` devices and the tools the docs list outside that error.
 * A tool with mixed tiers takes its highest. A tool the docs give no tier
 * is `exec`, which is OMP's own rule for an undeclared tool.
 *
 * Changing the pin means re-reading both sources (OM8.6).
 */
export const OMP_TOOL_TIERS: Readonly<Record<string, OmpTier>> = {
  read: "read",
  glob: "read",
  grep: "read",
  find: "read",
  ast_grep: "read",
  inspect_image: "read",
  web_search: "read",
  todo: "read",
  checkpoint: "read",
  rewind: "read",
  recall: "read",
  retain: "read",
  reflect: "read",
  memory_edit: "read",
  // Measured: runs unasked under always-ask (OM2.5).
  wait: "read",
  write: "write",
  edit: "write",
  ast_edit: "write",
  lsp: "write",
  learn: "write",
  manage_skill: "write",
  bash: "exec",
  eval: "exec",
  task: "exec",
  debug: "exec",
  ida: "exec",
  security_scan: "exec",
  context_notes: "exec",
  new_context: "exec",
  goal: "exec",
  init_experiment: "exec",
  run_experiment: "exec",
  log_experiment: "exec",
  update_notes: "exec",
  // Off below, and denied in every mode.
  ask: "read",
  github: "exec",
  browser: "exec",
  computer: "exec",
  generate_image: "write",
  tts: "write",
  hub: "exec",
  report_issue: "write",
};

/**
 * OMP's sources for other agents' configuration (18.14.1): their skills,
 * rules, commands and MCP servers. Each is opt-in, but Claude Code's is
 * opted in whenever `CLAUDE_CONFIG_DIR` is set, which the server sets for
 * every Claude Code it starts and an operator may have set for the server
 * itself. Both overlays list them all in `disabledProviders`, which OMP
 * checks before any opt-in (OM6.8, spike report "Measured later").
 */
export const OMP_FOREIGN_SOURCES = ["claude", "claude-plugins", "codex", "cursor", "gemini", "opencode", "windsurf", "github"] as const;
