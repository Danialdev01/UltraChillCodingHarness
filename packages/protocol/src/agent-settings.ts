import { z } from "zod";
import { ProviderId } from "./events.js";

/**
 * A workspace's choices for how its agents run, beyond whose subscription
 * pays (`CredentialPolicy`): solution §12.4's toggles, one section each.
 * Stored whole as `workspaces.agent_settings`; every field has a default,
 * so a section added later reads as its default on a row written before it.
 */
export const WorkspaceAgentSettings = z.object({
  /**
   * Automatic handoff on a usage limit (solution §5.4, OM4.6): a Claude Code
   * or Codex turn that fails on its plan's limit is carried on in a new
   * thread on `fallbackProvider`, in the same worktree, with the message
   * that failed. Off until both are set.
   */
  autoHandoff: z
    .object({
      enabled: z.boolean().default(false),
      fallbackProvider: ProviderId.nullable().default(null),
    })
    .default({}),
  /**
   * Isolated fan-out edits (solution §6.5, OM5.5): an OMP turn's workers
   * may each run in a copy of the worktree (`task.isolation.enabled`, a
   * task asking with `isolated: true`), their changes applied back to the
   * thread's worktree as a patch. Off: workers share the worktree, which
   * is already the thread's own.
   */
  isolatedFanOut: z.object({ enabled: z.boolean().default(false) }).default({}),
  /**
   * The OMP bridge (solution §10, OM6.4–OM6.5): Claude Code and Codex turns are offered
   * OMP's tools -- subagents, code intelligence, codemods, review -- as an
   * MCP server, each call billed to the OpenRouter key the workspace's
   * Custom turns use. Off: the CLI runs as it always has.
   */
  ompBridge: z.object({ enabled: z.boolean().default(false) }).default({}),
  /**
   * mnemopi memory on OMP turns (solution §7, OM7.1): OMP recalls what
   * earlier turns of the same project learned and retains what this one
   * does, in one bank per project shared by its threads' worktrees.
   * `llmMode: smol` lets the bank use the workspace's fast model (billed
   * to its OpenRouter key) to extract and match facts; `none` keeps it to
   * full-text search. Off: OMP keeps no memory.
   *
   * With memory on, Claude Code and Codex turns that have the OMP bridge
   * get `omp_recall` / `omp_retain` on the same bank (OM7.2), and
   * `retainCliTurns` has each of their completed turns' final answer --
   * never tool output -- read by the fast model, which retains any durable
   * fact in it (solution §7.3). Billed to the OpenRouter key.
   */
  memory: z
    .object({
      enabled: z.boolean().default(false),
      llmMode: z.enum(["smol", "none"]).default("smol"),
      retainCliTurns: z.boolean().default(false),
    })
    .default({}),
});
export type WorkspaceAgentSettings = z.infer<typeof WorkspaceAgentSettings>;

/** A change to some sections; each one named is replaced whole. */
export const WorkspaceAgentSettingsPatch = WorkspaceAgentSettings.partial();
export type WorkspaceAgentSettingsPatch = z.infer<typeof WorkspaceAgentSettingsPatch>;

/**
 * A stored value as settings. Whatever does not parse -- a row from before
 * the column, a section an older server wrote differently -- is the
 * defaults, section by section, rather than an error on every turn.
 */
export function readAgentSettings(stored: unknown): WorkspaceAgentSettings {
  const defaults = WorkspaceAgentSettings.parse({});
  if (!stored || typeof stored !== "object") return defaults;
  const out: Record<string, unknown> = { ...defaults };
  for (const [key, section] of Object.entries(WorkspaceAgentSettings.shape)) {
    const parsed = section.safeParse((stored as Record<string, unknown>)[key]);
    if (parsed.success) out[key] = parsed.data;
  }
  return out as WorkspaceAgentSettings;
}

/**
 * The provider a limited turn hands off to, or null: the setting on, a
 * fallback named, and not the provider that just hit its limit.
 */
export function limitFallback(settings: WorkspaceAgentSettings, failed: ProviderId): ProviderId | null {
  const { enabled, fallbackProvider } = settings.autoHandoff;
  if (!enabled || !fallbackProvider || fallbackProvider === failed) return null;
  return fallbackProvider;
}
