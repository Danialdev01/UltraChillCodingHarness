import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPermissionMode } from "@ucch/protocol";

/**
 * The per-turn OMP overlay (solution §4): a `config.yml`-style file passed
 * with `--config`, ranked above the cloned repository's `.omp/config.yml`
 * and below runtime flags.
 *
 * The rule that shapes all of it: mappings deep-merge and **records merge
 * key by key** (OM0), so a key the overlay does not write is the
 * repository's to set. A project's `tools.approval.bash: allow` survives an
 * overlay that does not name `bash`; a project's `modelRoles.vision` bills
 * whatever model it names to the workspace's OpenRouter key. So the overlay
 * writes every tool of the pinned version into `tools.approval`, every
 * model role into `modelRoles`, and every switch that starts paid,
 * outward-facing or process-spawning work -- whether or not UCCH wants it
 * changed from OMP's default. Arrays replace, so they are written whole.
 *
 * What a project cannot do at all, measured with 18.14.1 (spike report,
 * OM2.5): define a provider (`.omp/models.yml` and a root `models.yml` are
 * not read) or move one (`providers.openrouter.baseUrl` in project config
 * is ignored), so the key only ever goes to OpenRouter.
 */

/** OMP's approval tiers ([approvals](https://omp.sh/docs/approvals)). */
export type OmpTier = "read" | "write" | "exec";

type Policy = "allow" | "prompt" | "deny";

/** The tool presets an OMP turn can run with (solution §3.7). */
export type OmpPreset = "standard" | "research" | "documentation";

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
 * Denied whatever the mode. `ask`: questions go to the chat. `github`:
 * UCCH's Git view owns remotes. `computer`, `generate_image`, `tts`: not
 * offered. `hub`: collaboration with other OMP processes. `report_issue`:
 * OMP's tool QA, which can send reports to qa.omp.sh.
 */
const ALWAYS_DENIED = new Set(["ask", "github", "computer", "generate_image", "tts", "hub", "report_issue"]);

/** What each preset takes away, on top of the mode. */
const PRESET_DENIED: Record<OmpPreset, ReadonlySet<string>> = {
  standard: new Set(),
  // Research reads and reports; it changes nothing in the worktree.
  research: new Set(["write", "edit", "ast_edit", "learn", "manage_skill"]),
  // Writes stay; the guard hook keeps them under docs/ (§3.9).
  documentation: new Set(),
};

/**
 * The workspace's choices for its OMP turns (solution §12.4). Settings that
 * have no UI yet keep their defaults until the task that adds it.
 */
export interface OmpWorkspaceSettings {
  /** OpenRouter ids. `fast` and `deep` fall back to `default`. */
  models: { default?: string; fast?: string; deep?: string };
  /** mnemopi memory (OM7.1). */
  memory: { enabled: boolean; llmMode: "smol" | "none" };
  /** Prewalk: start on the default model, finish on the fast one. */
  economy: boolean;
  /** A second model that reviews each turn; billed separately. */
  advisor: boolean;
  /** The browser eval prelude. */
  browser: boolean;
  /**
   * Workers may run isolated, a patch applied back (OM5.5): the workspace's
   * `isolatedFanOut`. Their copies live under `OMP_WORKTREE_DIR`, the
   * subject's own (`providers.ts`).
   */
  isolatedFanOut: boolean;
}

export const DEFAULT_OMP_SETTINGS: OmpWorkspaceSettings = {
  models: {},
  memory: { enabled: false, llmMode: "smol" },
  economy: false,
  advisor: false,
  browser: false,
  isolatedFanOut: false,
};

export interface OmpOverlayInput {
  settings: OmpWorkspaceSettings;
  preset: OmpPreset;
  permissionMode?: AgentPermissionMode;
  /** Trusted projects keep debugging (§0.3: project `dap.json` loads under every flag). */
  trusted: boolean;
  /** `task.maxConcurrency`: `OMP_WORKERS_PER_TURN`. */
  workersPerTurn: number;
  /** A search key is configured; without one `web_search` is denied (§3.7). */
  webSearch: boolean;
  /** The project's mnemopi database; required when memory is on (§7.1). */
  memoryDbPath?: string;
  /**
   * UCCH's host tools (OM3.2), named so a project cannot set them. Allowed:
   * a host call runs through `runTool`, whose own approval gate asks a
   * person exactly as for a native turn, so OMP asking first would ask twice.
   */
  hostTools?: readonly string[];
}

/** What a tier gets under each mode: OMP's own table (`approvalFor`), written out. */
function tierPolicy(tier: OmpTier, mode: AgentPermissionMode | undefined): Policy {
  if (mode === "allow_all") return "allow";
  if (tier === "read") return "allow";
  if (tier === "write") return mode === "strict" ? "prompt" : "allow";
  return "prompt";
}

/** The `tools.approval` record: every tool, in a stable order. */
export function ompApprovals(input: OmpOverlayInput): Record<string, Policy> {
  const approvals: Record<string, Policy> = {};
  for (const [name, tier] of Object.entries(OMP_TOOL_TIERS)) {
    const denied =
      ALWAYS_DENIED.has(name) ||
      PRESET_DENIED[input.preset].has(name) ||
      (name === "browser" && !input.settings.browser) ||
      (name === "web_search" && !input.webSearch) ||
      (name === "debug" && !input.trusted);
    approvals[name] = denied ? "deny" : tierPolicy(tier, input.permissionMode);
  }
  for (const name of input.hostTools ?? []) approvals[name] = "allow";
  return approvals;
}

const openrouter = (id: string) => (id.startsWith("openrouter/") ? id : `openrouter/${id}`);

/**
 * Every role 18.14.1 assigns (its role set, plus `advisor`), so none is
 * left to a project. Without a default model the roles are not written and
 * OMP's catalogue decides -- the server always passes one (`--model` too).
 */
function modelRoles(models: OmpWorkspaceSettings["models"]): Record<string, string> | null {
  if (!models.default) return null;
  const main = openrouter(models.default);
  const fast = models.fast ? openrouter(models.fast) : main;
  const deep = models.deep ? openrouter(models.deep) : main;
  return { default: main, smol: fast, slow: deep, plan: deep, vision: main, commit: fast, advisor: deep };
}

/** The overlay as data, in the order it is written. */
export function ompOverlay(input: OmpOverlayInput): Record<string, unknown> {
  const { settings } = input;
  if (settings.memory.enabled && !input.memoryDbPath) throw new Error("OMP memory needs the project's database path");
  const roles = modelRoles(settings.models);
  return {
    // Context management -- /docs/compaction, /docs/handoff
    compaction: {
      enabled: true,
      methodOrder: ["handoff", "remote", "shake", "soft"],
      keepRecentTokens: 20000,
      midTurnEnabled: true,
      asyncEnabled: true,
      autoContinue: true,
      idleEnabled: false,
      handoffSaveToDisk: true,
      supersedeReads: true,
      dropUseless: true,
    },
    contextPromotion: { enabled: false },

    // Memory -- /docs/memory
    memory: { backend: settings.memory.enabled ? "mnemopi" : "off" },
    ...(settings.memory.enabled
      ? {
          mnemopi: {
            scoping: "global",
            dbPath: input.memoryDbPath,
            autoRecall: true,
            autoRetain: true,
            retainEveryNTurns: 4,
            recallLimit: 8,
            llmMode: settings.memory.llmMode,
            noEmbeddings: false,
          },
        }
      : {}),
    autolearn: { enabled: false },

    // Subagents -- /docs/subagents
    task: {
      maxConcurrency: input.workersPerTurn,
      maxRecursionDepth: 1,
      softRequestBudget: 120,
      maxRuntimeMs: 900000,
      agentIdleTtlMs: 60000,
      isolation: { enabled: settings.isolatedFanOut, apply: true, merge: "patch" },
    },
    async: { enabled: true },

    // Roles -- /docs/agents-and-roles
    ...(roles ? { modelRoles: roles } : {}),
    retry: { modelFallback: false },
    providers: { cacheWarming: "idle" },

    // Code intelligence / edits / debug
    lsp: {
      enabled: true,
      lazy: true,
      shared: true,
      formatOnWrite: false,
      diagnosticsOnWrite: true,
      diagnosticsDeduplicate: true,
    },
    astEdit: { enabled: true },
    debug: { enabled: input.trusted },

    // Approvals -- /docs/approvals
    tools: { approval: ompApprovals(input) },

    // Tools UCCH does not offer, or offers only when the workspace says so
    ask: { enabled: false },
    github: { enabled: false },
    browser: { enabled: settings.browser },
    computer: { enabled: false },
    generate_image: { enabled: false },
    speechgen: { enabled: false },
    speech: { enabled: false },
    web_search: { enabled: input.webSearch },
    dev: { autoqa: false },

    // Plan / prewalk / advisor
    plan: { enabled: true },
    prewalk: { enabled: settings.economy },
    advisor: { enabled: settings.advisor },
    recap: { enabled: false },

    // Nothing leaves the box but the model requests
    telemetry: { otlpExportEnabled: false },

    // Project sources off (§0.3)
    skills: { enableClaudeProject: false, enablePiProject: false, enableAgentsProject: false },
    commands: { enableClaudeProject: false, enableOpencodeProject: false },
    mcp: { enableProjectConfig: false },
  };
}

/** Every dotted key path the overlay sets; a record's entries count as its own key. */
export function overlayKeyPaths(overlay: Record<string, unknown>, records: ReadonlySet<string>, prefix = ""): string[] {
  const paths: string[] = [];
  for (const [key, value] of Object.entries(overlay)) {
    const path = prefix ? `${prefix}.${key}` : key;
    if (records.has(path) || value === null || typeof value !== "object" || Array.isArray(value)) paths.push(path);
    else paths.push(...overlayKeyPaths(value as Record<string, unknown>, records, path));
  }
  return paths;
}

/**
 * YAML for the overlay. Strings are JSON-quoted, which YAML reads as the
 * same string, so a model id or path can never become YAML syntax.
 */
export function toYaml(value: Record<string, unknown>, indent = ""): string {
  let out = "";
  for (const [key, item] of Object.entries(value)) {
    if (item === undefined) continue;
    if (item !== null && typeof item === "object" && !Array.isArray(item)) {
      out += `${indent}${key}:\n${toYaml(item as Record<string, unknown>, `${indent}  `)}`;
    } else {
      out += `${indent}${key}: ${scalar(item)}\n`;
    }
  }
  return out;
}

function scalar(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(scalar).join(", ")}]`;
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean" || value === null) return String(value);
  throw new Error(`cannot write ${typeof value} to the OMP overlay`);
}

const HEADER = "# Written by UCCH for one turn and deleted after it. Do not edit.\n";

/**
 * Writes this turn's overlay to `<runDir>/<turnId>.yml`, mode 0600, and
 * returns its path and a disposer that deletes it. `runDir` is the
 * subject's `omp/run` (`ProviderService.ensureCredsDir`).
 */
export async function writeOmpOverlay(
  runDir: string,
  turnId: string,
  input: OmpOverlayInput,
): Promise<{ path: string; contextThreshold: OmpContextThreshold; dispose(): Promise<void> }> {
  if (!/^[A-Za-z0-9-]+$/.test(turnId)) throw new Error(`not a turn id: ${turnId}`);
  const path = join(runDir, `${turnId}.yml`);
  const overlay = ompOverlay(input);
  await writeFile(path, HEADER + toYaml(overlay), { mode: 0o600 });
  return { path, contextThreshold: ompContextThreshold(overlay), dispose: () => rm(path, { force: true }) };
}

/** Where the overlay starts compaction, as OMP's two settings say it. */
export interface OmpContextThreshold {
  tokens?: number;
  /** Of the model's window, 1-99. */
  percent?: number;
}

/**
 * The compaction threshold an overlay sets, for the context meter (solution
 * §5.2): `get_session_stats` reports the context's size and window but not
 * where compaction starts, so the meter takes it from what UCCH wrote. OMP
 * reads a value of 0 or below as unset (its default is -1).
 */
export function ompContextThreshold(overlay: Record<string, unknown>): OmpContextThreshold {
  const compaction = (overlay.compaction ?? {}) as { thresholdTokens?: unknown; thresholdPercent?: unknown };
  const positive = (value: unknown) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined);
  const tokens = positive(compaction.thresholdTokens);
  const percent = positive(compaction.thresholdPercent);
  return { ...(tokens !== undefined ? { tokens } : {}), ...(percent !== undefined ? { percent } : {}) };
}
