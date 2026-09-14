import { toJsonSchema, type ToolSchema } from "./schema.js";
import type { AnyTool } from "./tool.js";
import { deleteFile, editFile, listDir, readFile, writeFile } from "./tools/fs.js";
import { glob, grep } from "./tools/search.js";
import { bash } from "./tools/shell.js";
import { currentTime, ping } from "./tools/system.js";
import { researchBrowse, researchRead, researchSearch } from "./tools/research.js";
import { attachUpload } from "./tools/uploads.js";
import { webFetch, webSearch } from "./tools/web.js";

/**
 * Every tool, in the one order that exists.
 *
 * `plan.md` §10 names non-deterministic tool ordering as a silent prompt-cache
 * invalidator. The tool block is the first thing in the cached prefix, so one
 * changed byte costs the whole turn's cache -- and nothing about the reply
 * looks wrong when it happens, which is what makes it worth this much care.
 *
 * So: order comes from this one frozen array literal. Presets filter, never
 * reorder. No sorting, no `Object.keys`, no `Set` iteration.
 */
export const ALL: readonly AnyTool[] = Object.freeze([
  readFile,
  listDir,
  writeFile,
  editFile,
  glob,
  grep,
  bash,
  currentTime,
  ping,
  webSearch,
  webFetch,
  // Appended rather than slotted in beside the file tools: the array's order
  // is the cached prompt prefix, and adding at the end is the one edit that
  // does not move every tool after it.
  attachUpload,
  deleteFile,
  // The research pipeline. At the end for the reason above, and offered on
  // the `research` preset alone -- see `RESEARCH_ONLY`.
  researchSearch,
  researchRead,
  researchBrowse,
]);

/**
 * `research` is the pipeline behind the composer's Research toggle: the
 * research tools in place of `web_search` and `web_fetch`, every read tool,
 * and enough of the write tools to save what was found. No shell, and
 * nothing that deletes.
 */
export type ToolPreset = "readonly" | "minimal" | "standard" | "ptc" | "research";

/**
 * How the tool block is put in front of the model.
 *
 * `function` is JSON Schema in the `tools` array, which is what every model
 * here is trained on. `code` is DeepSeek Harness's programmatic tool calling:
 * the schemas are rendered as a typed SDK and the model writes one program
 * against it, so a sequence that would take five round trips takes one.
 *
 * **Only `function` is built.** The renderer is deliberately not, because the
 * generated SDK is itself prompt tokens and dsh's own documentation is blunt
 * that with few tools "the net savings may be negligible or negative". This
 * harness has thirteen. The gate for building it is a measurement, not a
 * preference: prompt tokens per turn, retained result tokens across a
 * session, latency, and error-recovery cost, all of which the cache canary in
 * `loop.ts` and the usage on `agent.turn_completed` already collect.
 *
 * The `ptc` preset therefore resolves to the same tools as `standard` today.
 * It exists so the decision has somewhere to land that is not a new call
 * site in every consumer.
 */
export type ToolPresentation = "function" | "code";

/** Backs the `subagents.tool_preset` column, which already exists. */
const MINIMAL: readonly string[] = ["read_file", "list_dir", "grep", "current_time"];

/**
 * Built while this module is evaluated, so a tool whose schema `strict: true`
 * would reject stops the server at boot.
 *
 * Each schema object is created exactly once and handed out by reference, so
 * two requests for the same preset send byte-identical bytes rather than
 * equal-looking ones.
 */
const SCHEMAS: ReadonlyMap<string, ToolSchema> = buildSchemas(ALL);

/** Exported so the ordering and strictness rules can be tested with fixtures. */
export function buildSchemas(tools: readonly AnyTool[]): ReadonlyMap<string, ToolSchema> {
  const schemas = new Map<string, ToolSchema>();
  for (const tool of tools) {
    if (schemas.has(tool.name)) {
      // Two tools under one name means the model's call is ambiguous and the
      // preset filters are silently wrong. It is a coding error, not a case.
      throw new Error(`duplicate tool name: ${tool.name}`);
    }
    schemas.set(
      tool.name,
      Object.freeze({
        type: "function",
        function: Object.freeze({
          name: tool.name,
          description: tool.description,
          parameters: toJsonSchema(tool.name, tool.inputSchema),
          strict: true,
        }),
      }) as ToolSchema,
    );
  }
  return schemas;
}

// Keyed by preset and gate together: a handful of entries, each holding the
// one frozen array that goes out for that combination.
const toolCache = new Map<string, readonly AnyTool[]>();
const schemaCache = new Map<string, readonly ToolSchema[]>();

const cacheKey = (preset: ToolPreset, options: RegistryOptions): string =>
  `${preset}:${options.allowHostShell ?? true}`;

/**
 * Filters a tool list to a preset, in the list's own order.
 *
 * `filter` rather than anything that rebuilds the sequence: the order is the
 * cache key, so a preset that reordered would quietly cost the prefix.
 */
/**
 * Tools whose plugin can be withheld at deployment time.
 *
 * `bash` is the whole of the `shell` plugin, and until the container runtime
 * lands it is host RCE -- so production has to ask for it explicitly. The
 * gate is orthogonal to the presets: "standard" still means every tool the
 * deployment offers, and which tools those are is the server's decision.
 */
const HOST_SHELL: readonly string[] = ["bash"];

/**
 * Tools that exist only on the `research` preset.
 *
 * Filtered out of every other preset by name rather than by permission:
 * they are reads, and `readonly` would otherwise pick them up and offer a
 * browser agent to a turn that did not ask for one.
 */
const RESEARCH_ONLY: readonly string[] = ["research_search", "research_read", "research_browse"];

/** What the research tools stand in for, and so are left out beside them. */
const RESEARCH_REPLACES: readonly string[] = ["web_search", "web_fetch"];

/** The writes a research turn keeps: enough to save findings into the repository. */
const RESEARCH_WRITES: readonly string[] = ["write_file", "edit_file"];

export interface RegistryOptions {
  /**
   * Defaults to true, so the registry offers what the preset names unless
   * told otherwise. `apps/server` passes `shellPluginEnabled(config)`.
   */
  allowHostShell?: boolean;
}

export function selectPreset(
  tools: readonly AnyTool[],
  preset: ToolPreset,
  options: RegistryOptions = {},
): readonly AnyTool[] {
  const allowHostShell = options.allowHostShell ?? true;
  return Object.freeze(
    tools.filter((tool) => {
      if (!allowHostShell && HOST_SHELL.includes(tool.name)) return false;
      if (preset !== "research" && RESEARCH_ONLY.includes(tool.name)) return false;
      switch (preset) {
        case "research":
          if (RESEARCH_REPLACES.includes(tool.name)) return false;
          return tool.permission === "read" || RESEARCH_WRITES.includes(tool.name);
        case "standard":
        // Same capability set; only the presentation is meant to differ, and
        // that renderer is not built. See `ToolPresentation`.
        case "ptc":
          return true;
        case "readonly":
          return tool.permission === "read";
        case "minimal":
          return MINIMAL.includes(tool.name);
      }
    }),
  );
}

/** The preset's members, in `ALL`'s order. */
export function toolsFor(preset: ToolPreset, options: RegistryOptions = {}): readonly AnyTool[] {
  const key = cacheKey(preset, options);
  const cached = toolCache.get(key);
  if (cached) return cached;

  const tools = selectPreset(ALL, preset, options);
  toolCache.set(key, tools);
  return tools;
}

/** The same frozen array every time, which is what keeps the cache warm. */
export function schemasFor(
  preset: ToolPreset,
  options: RegistryOptions = {},
): readonly ToolSchema[] {
  const key = cacheKey(preset, options);
  const cached = schemaCache.get(key);
  if (cached) return cached;

  const schemas = Object.freeze(toolsFor(preset, options).map((tool) => SCHEMAS.get(tool.name)!));
  schemaCache.set(key, schemas);
  return schemas;
}

/** Looks a tool up by the name the model used. */
export function toolByName(
  preset: ToolPreset,
  name: string,
  options: RegistryOptions = {},
): AnyTool | undefined {
  return toolsFor(preset, options).find((tool) => tool.name === name);
}
