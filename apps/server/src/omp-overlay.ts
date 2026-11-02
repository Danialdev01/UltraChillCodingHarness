import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { AgentPermissionMode } from "@ucch/protocol";
import { OMP_FOREIGN_SOURCES, OMP_TOOL_TIERS, type OmpTier } from "@ucch/providers";

export { OMP_TOOL_TIERS, type OmpTier };

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

type Policy = "allow" | "prompt" | "deny";

/** The tool presets an OMP turn can run with (solution §3.7). */
export type OmpPreset = "standard" | "research" | "documentation";

/** A turn's preset, or the review engine's (§9, OM7.7), which no turn has. */
export type OmpOverlayPreset = OmpPreset | "review";

/**
 * Denied whatever the mode. `ask`: questions go to the chat. `github`:
 * UCCH's Git view owns remotes. `computer`, `generate_image`, `tts`: not
 * offered. `hub`: collaboration with other OMP processes. `report_issue`:
 * OMP's tool QA, which can send reports to qa.omp.sh.
 */
const ALWAYS_DENIED = new Set(["ask", "github", "computer", "generate_image", "tts", "hub", "report_issue"]);

/**
 * What a review may use: reading the code, and `task` to hand the diff to
 * OMP's bundled `reviewer`. No `web_search` (it reaches out), no memory
 * writes, nothing that changes the worktree or runs a command.
 */
const REVIEW_TOOLS = new Set(["read", "glob", "grep", "find", "ast_grep", "inspect_image", "todo", "wait", "recall", "reflect", "task"]);

/** What each preset takes away, on top of the mode. */
const PRESET_DENIED: Record<OmpOverlayPreset, ReadonlySet<string>> = {
  standard: new Set(),
  // Research reads and reports; it changes nothing in the worktree.
  research: new Set(["write", "edit", "ast_edit", "learn", "manage_skill"]),
  // Writes stay; the guard hook keeps them under docs/ (§3.9).
  documentation: new Set(),
  review: new Set(Object.keys(OMP_TOOL_TIERS).filter((name) => !REVIEW_TOOLS.has(name))),
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
  preset: OmpOverlayPreset;
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
   * The bank only through the `recall` and `retain` tools: no automatic
   * recall into the prompt, no automatic retention of the session. For the
   * bridge's calls and end-of-turn retention (OM7.2), whose sessions are a
   * tool call or a retention prompt, not a turn: mnemopi's `autoRetain`
   * kept a retention run's whole prompt and stdin as a memory, verbatim.
   */
  memoryToolsOnly?: boolean;
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
    // A review runs unattended: what it may use is allowed outright, as
    // nobody is there to answer a prompt.
    approvals[name] = denied ? "deny" : input.preset === "review" ? "allow" : tierPolicy(tier, input.permissionMode);
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
            autoRecall: !input.memoryToolsOnly,
            autoRetain: !input.memoryToolsOnly,
            retainEveryNTurns: 4,
            recallLimit: 8,
            llmMode: settings.memory.llmMode,
            // Embeddings download ~770 MB (a bge-base ONNX model, onnxruntime,
            // npm packages) into HOME on first use (OM7.1, measured); recall is
            // then full-text, or helped by the fast model under `llmMode: smol`.
            noEmbeddings: true,
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
      // Gives a subagent with an output schema its `yield` tool: off (OMP's
      // default) the bundled `reviewer` answers in prose. On for a review
      // only (OM7.7, measured with 18.14.1).
      structured: input.preset === "review",
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
    // Nor any other agent's configuration: OMP reads Claude Code's whenever
    // `CLAUDE_CONFIG_DIR` is set, and an operator may have set it (OM6.8).
    disabledProviders: [...OMP_FOREIGN_SOURCES],
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
