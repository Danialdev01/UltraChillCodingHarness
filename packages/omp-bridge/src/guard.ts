import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OMP_FOREIGN_SOURCES, OMP_TOOL_TIERS } from "@ucch/providers";

/**
 * Each call's guard overlay: one more `--config`, passed last, so it ranks
 * above the server's bridge overlay, a developer's own and the cloned
 * repository's `.omp/config.yml` (solution §10.2).
 *
 * `--tools` is not enough on its own. It limits the session OMP starts,
 * not the subagents that session spawns: each of those gets its own
 * agent's tools (18.14.1, measured). Under `--approval-mode yolo`, an
 * `omp_task` on `reviewer` with `--tools read,grep,glob,task` gave the
 * reviewer `bash` and `web_search`, and its `bash` ran; `sonic` got
 * `bash`, `eval` and `web_search` besides the `edit` and `write` the call
 * names. So every tool of the pinned version that the call did not name
 * is denied here, and `deny` always wins over yolo and over every lower
 * overlay. The exceptions are the read-only tools a subagent needs to
 * work in the worktree (`SUBAGENT_READS`).
 *
 * Besides the tools, the guard turns off what a bridge with no UCCH
 * overlay -- one a developer added to their own Claude Code -- would
 * otherwise get from OMP's defaults: `dev.autoqa`, which mounts
 * `xd://report_issue` (reached through a `write` tool) and can send
 * reports to qa.omp.sh; `web_search`, unless the call names it; telemetry
 * export; and the repository's own skills, commands and MCP servers
 * (§0.3), the last of which are commands.
 *
 * And every other agent's configuration (`OMP_FOREIGN_SOURCES`). OMP reads
 * Claude Code's, Codex's, Cursor's and others' skills, rules and MCP
 * servers when they are opted in, and 18.14.1 opts Claude Code's in
 * whenever `CLAUDE_CONFIG_DIR` is set -- which it is for every Claude Code
 * the server starts. A bridge call then mounted the `mcp__omp_*` servers
 * of that Claude Code's own config as `xd://` devices: the bridge, inside
 * its own call, able to start calls of its own. `disabledProviders` is
 * checked before every opt-in, the variable included.
 */

/** Read-only tools a subagent may use whether or not the call names them. */
export const SUBAGENT_READS: ReadonlySet<string> = new Set([
  "read",
  "glob",
  "grep",
  "find",
  "ast_grep",
  "inspect_image",
  "todo",
  "wait",
  "checkpoint",
  "rewind",
]);

export function guardOverlay(tools: readonly string[]): Record<string, unknown> {
  const named = new Set(tools);
  const approval: Record<string, "deny"> = {};
  for (const name of Object.keys(OMP_TOOL_TIERS)) {
    if (!named.has(name) && !SUBAGENT_READS.has(name)) approval[name] = "deny";
  }
  return {
    tools: { approval },
    disabledProviders: [...OMP_FOREIGN_SOURCES],
    web_search: { enabled: named.has("web_search") },
    dev: { autoqa: false },
    telemetry: { otlpExportEnabled: false },
    skills: { enableClaudeProject: false, enablePiProject: false, enableAgentsProject: false },
    commands: { enableClaudeProject: false, enableOpencodeProject: false },
    mcp: { enableProjectConfig: false },
  };
}

/**
 * Writes the call's guard to a fresh 0700 directory under the temp dir
 * and returns its path and a disposer that removes it. JSON is YAML, and
 * OMP reads the file as YAML.
 */
export async function writeGuard(tools: readonly string[]): Promise<{ path: string; dispose(): Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), "ucch-omp-guard-"));
  const path = join(dir, "guard.yml");
  try {
    await writeFile(path, `${JSON.stringify(guardOverlay(tools), null, 2)}\n`, { mode: 0o600 });
  } catch (error) {
    await rm(dir, { recursive: true, force: true });
    throw error;
  }
  return { path, dispose: () => rm(dir, { recursive: true, force: true }) };
}
