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
