import type { ProviderId } from "./events.js";

/**
 * Which harness runs a model someone named in plain words ("opus 5.5",
 * "gpt6 sol", "kimi k2"), for a subagent or a harness switch.
 *
 * The person's own subscriptions come first, each for its own vendor's models:
 * a Claude model runs on Claude Code and an OpenAI model on Codex, while that
 * CLI is signed in. Any other model, or one whose CLI is not available, is
 * looked up in the OpenRouter catalogue and runs on the Custom harness. With
 * no model named, the parent's own harness and model are used.
 *
 * Pure, so the server routes with it and the web can preview it.
 */

export type ModelFamily = "claude" | "openai" | "other";

export interface ParsedModel {
  /** What was asked for, trimmed. */
  raw: string;
  family: ModelFamily;
  /** The id the vendor's CLI takes: `claude-opus-5-5`, `gpt-6-sol`, `opus`. */
  cliModel: string;
  /** Lower-case word and number tokens, for matching the catalogue. */
  tokens: string[];
}

export interface RoutingHarness {
  provider: ProviderId;
  /** Signed in, enabled, has its key: a turn could start on it now. */
  usable: boolean;
  /** Authoritative discovery only; absent means availability is unknown. */
  models?: readonly CatalogueModel[];
  usedPercent?: number;
  blocker?: string | null;
  quota?: { status: string; checkedAt?: string; usedPercent?: number };
}

export interface CatalogueModel {
  id: string;
  name?: string;
}

export interface RoutingInput {
  harnesses: readonly RoutingHarness[];
  catalogue: readonly CatalogueModel[];
  /** The harness and model the asking session runs on: the default. */
  parent: { provider: ProviderId; model: string | null };
  /** What runs OpenRouter models on this server: `omp`, or `native` without OMP. */
  customProvider: "omp" | "native";
}

export type RoutingVia = "inherit" | "claude-cli" | "codex-cli" | "openrouter";

export type Routing =
  | { ok: true; provider: ProviderId; model: string | null; via: RoutingVia; label: string }
  | { ok: false; reason: string; candidates: string[] };

const CLAUDE_WORDS = new Set(["claude", "opus", "sonnet", "haiku", "fable"]);
/** Words people put around a model's name that are not part of it. */
const FILLER = new Set(["model", "use", "using", "the", "with", "via", "on", "a", "an"]);
const VENDOR_PREFIX = /^(anthropic|openai|openrouter)\//;

const PROVIDER_LABEL: Record<ProviderId, string> = {
  native: "Default",
  claude: "Claude Code",
  codex: "Codex",
  omp: "Default",
};

/**
 * Splits on anything that is not a letter or digit, and between letters and
 * digits: "gpt6 sol" → gpt 6 sol, "opus-5.5" → opus 5 5.
 */
export function modelTokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/([a-z])(\d)/g, "$1 $2")
    .replace(/(\d)([a-z])/g, "$1 $2")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

export function parseModelRequest(request: string): ParsedModel {
  const raw = request.trim();
  const bare = raw.toLowerCase().replace(VENDOR_PREFIX, "");
  const tokens = modelTokens(bare).filter((token) => !FILLER.has(token));
  const first = tokens[0] ?? "";
  const family: ModelFamily = tokens.some((token) => CLAUDE_WORDS.has(token))
    ? "claude"
    : first === "gpt" || first === "codex" || /^o\d+$/.test(first) || (first === "o" && /^\d/.test(tokens[1] ?? ""))
      ? "openai"
      : "other";
  return { raw, family, cliModel: cliModelId(bare, family, tokens), tokens };
}

/**
 * Claude Code takes `claude-opus-5-5` (dashes for the version's dots) or the
 * bare alias `opus`; Codex takes OpenAI's ids, which keep their dots
 * (`gpt-5.1-codex`).
 */
function cliModelId(bare: string, family: ModelFamily, tokens: string[]): string {
  if (family === "claude") {
    const words = tokens.filter((token) => token !== "claude");
    if (words.length === 1 && CLAUDE_WORDS.has(words[0]!)) return words[0]!;
    return ["claude", ...words].join("-");
  }
  if (family === "openai") {
    // Keep dots between digits, dash everything else: "gpt 5.1 codex" →
    // gpt-5.1-codex, "gpt6 sol" → gpt-6-sol.
    // A word run into its version gets a dash (gpt6 → gpt-6); a one-letter
    // series name keeps its number (o4-mini).
    return bare
      .replace(/([a-z]{2,})(\d)/g, "$1-$2")
      .split(/[^a-z0-9.]+/)
      .filter((part) => part && !FILLER.has(part))
      .join("-")
      .replace(/-?\.-?/g, ".");
  }
  return bare;
}

/**
 * Whether `want` appears in `have` in order (not necessarily adjacent):
 * "opus 5 5" is in anthropic/claude-opus-5.5, not in claude-opus-4.5.
 */
function inOrder(want: readonly string[], have: readonly string[]): boolean {
  let at = 0;
  for (const token of have) if (token === want[at]) at += 1;
  return at === want.length;
}

/**
 * How far a catalogue model is from the request: the number of words it has
 * beyond the request's, in its own id (without the vendor), full id or
 * name, whichever fits best; null when none has every word of the request
 * in order. A tagged variant (`:free`, `:thinking`) counts one further.
 */
function distance(parsed: ParsedModel, model: CatalogueModel): number | null {
  const idTokens = modelTokens(model.id.replace(/:.*$/, ""));
  const vendor = model.id.includes("/") ? modelTokens(model.id.split("/")[0]!).length : 0;
  const candidates = [idTokens.slice(vendor), idTokens, model.name ? modelTokens(model.name) : []];
  // A named version must match in full, including patch versions.
  const version = parsed.tokens.filter((token) => /^\d+$/.test(token)).join(".");
  if (version && idTokens.filter((token) => /^\d+$/.test(token)).join(".") !== version) return null;
  const fits = candidates.filter((tokens) => inOrder(parsed.tokens, tokens));
  if (fits.length === 0) return null;
  return Math.min(...fits.map((tokens) => tokens.length - parsed.tokens.length)) + (model.id.includes(":") ? 1 : 0);
}

/** The catalogue models that fit the request, closest first. */
export function matchCatalogue(
  parsed: ParsedModel,
  catalogue: readonly CatalogueModel[],
): { model: CatalogueModel; distance: number }[] {
  if (parsed.tokens.length === 0) return [];
  const exact = catalogue.find((model) => model.id.toLowerCase() === parsed.raw.toLowerCase());
  if (exact) return [{ model: exact, distance: 0 }];
  const scored: { model: CatalogueModel; distance: number }[] = [];
  for (const model of catalogue) {
    const d = distance(parsed, model);
    if (d !== null) scored.push({ model, distance: d });
  }
  return scored.sort((a, b) => a.distance - b.distance || a.model.id.length - b.model.id.length);
}

function usable(input: RoutingInput, provider: ProviderId): boolean {
  return input.harnesses.some((harness) => harness.provider === provider && harness.usable && (harness.usedPercent === undefined || harness.usedPercent <= 90));
}

function supports(input: RoutingInput, provider: ProviderId, parsed: ParsedModel): boolean {
  const models = input.harnesses.find((harness) => harness.provider === provider)?.models;
  return !models || matchCatalogue(parsed, models).length > 0;
}

/** Where a named model runs. See the module comment for the order. */
export function resolveHarness(request: string | null | undefined, input: RoutingInput): Routing {
  const { parent } = input;
  if (!request?.trim()) {
    return {
      ok: true,
      provider: parent.provider,
      model: parent.model,
      via: "inherit",
      label: `${parent.model ?? "default model"} on ${PROVIDER_LABEL[parent.provider]} (same as the session)`,
    };
  }
  const parsed = parseModelRequest(request);
  if (parsed.family === "claude" && usable(input, "claude") && supports(input, "claude", parsed)) {
    return { ok: true, provider: "claude", model: parsed.cliModel, via: "claude-cli", label: `${parsed.cliModel} on Claude Code` };
  }
  if (parsed.family === "openai" && usable(input, "codex") && supports(input, "codex", parsed)) {
    return { ok: true, provider: "codex", model: parsed.cliModel, via: "codex-cli", label: `${parsed.cliModel} on Codex` };
  }
  if (!usable(input, input.customProvider)) {
    const cli = parsed.family === "claude" ? "Claude Code" : parsed.family === "openai" ? "Codex" : null;
    return {
      ok: false,
      reason: cli
        ? `${cli} cannot run the requested model within the subscription routing policy, and OMP (OpenRouter) is not set up either`
        : `"${parsed.raw}" needs the Custom harness (OpenRouter), which is not set up`,
      candidates: [],
    };
  }
  const matches = matchCatalogue(parsed, input.catalogue);
  const [best, second] = matches;
  if (!best) {
    return { ok: false, reason: `no OpenRouter model matches "${parsed.raw}"`, candidates: [] };
  }
  // Two equally close: the agent picks (or asks), rather than a guess.
  if (second && second.distance === best.distance) {
    return {
      ok: false,
      reason: `"${parsed.raw}" matches more than one OpenRouter model; name one of these`,
      candidates: matches.filter((match) => match.distance === best.distance).slice(0, 6).map(({ model }) => model.id),
    };
  }
  const preferred = parsed.family === "claude" ? "claude" : parsed.family === "openai" ? "codex" : null;
  const cli = input.harnesses.find((h) => h.provider === preferred);
  const reason = !preferred ? "model uses OpenRouter" : cli?.usedPercent !== undefined && cli.usedPercent > 90
    ? `${PROVIDER_LABEL[preferred]} subscription usage ${cli.usedPercent}% exceeds 90%`
    : cli && !cli.usable ? cli.blocker ?? `${PROVIDER_LABEL[preferred]} is unavailable`
    : `requested model is unavailable on ${PROVIDER_LABEL[preferred]}`;
  const label = `${best.model.id} on ${PROVIDER_LABEL[input.customProvider]} (OpenRouter; billed to the configured key): ${reason}`;
  return { ok: true, provider: input.customProvider, model: best.model.id, via: "openrouter", label };
}

// -- The `ucch_agent` tool ----------------------------------------------------

/** The subagent tool's name on every harness (MCP on Claude Code and Codex, a host tool on OMP, a registry tool natively). */
export const UCCH_AGENT_TOOL = "ucch_agent";

/** Whether a tool call's name is `ucch_agent` as some harness spells it (`mcp__omp__ucch_agent`, `omp.ucch_agent`, …). */
export function isUcchAgentTool(name: string): boolean {
  return name === UCCH_AGENT_TOOL || name.endsWith(`__${UCCH_AGENT_TOOL}`) || name.endsWith(`.${UCCH_AGENT_TOOL}`) || name.endsWith(`/${UCCH_AGENT_TOOL}`);
}

/** What every harness's `ucch_agent` tells its model. */
export const UCCH_AGENT_DESCRIPTION = [
  "Starts a subagent on any AI harness or model and returns its final answer.",
  'Use it when the person names a model or harness for a subagent ("use opus 5.5 for development and gpt6 sol for research"):',
  "put their words in `model`, as they said them. Claude models run on Claude Code, OpenAI models on Codex,",
  "anything else on an OpenRouter model. Leave `model` out to use the same model as this session.",
  "Set background=true for coordinated work: this returns a child session ID immediately; completion arrives as a message. Subscription usage above 90% falls back to the same model on OMP/OpenRouter, billed to the configured key.",
  "The subagent works in this session's folder but cannot see this conversation: make `task` self-contained.",
  "Call it several times in one message to run independent subagents at once. It can take many minutes.",
].join(" ");

/** The argument descriptions, shared for the same reason. */
export const UCCH_AGENT_ARGS = {
  description: "A few words for the person: what this subagent is for.",
  task: "Everything the subagent needs to do the work, self-contained.",
  background: "Return the child session ID immediately so you can keep working and exchange messages. Defaults to false.",
  model: 'The model or harness the person asked for, in their words ("opus 5.5", "gpt6 sol", "kimi k2"). Omit for this session\'s own.',
} as const;

/**
 * The short guide added to a session's instructions wherever `ucch_agent`
 * is offered, so the agent reaches for it when (and only when) a model or
 * harness is named.
 */
export const UCCH_AGENT_GUIDE = [
  "## Subagents on other models",
  "",
  "When the person asks for subagents on a particular model or harness (for example \"create 2 subagents for research and development; use opus 5.5 for development and gpt6 sol for research\"),",
  "start each one with the `ucch_agent` tool, passing the model in their words as `model`. Start independent ones in the same message so they run in parallel.",
  "Once a model or harness is named, start every subagent of that request with `ucch_agent`, including ones on this session's own vendor; never use your built-in subagent tool (Agent, Task, spawn_agent) for them, as it cannot change model or harness.",
  "Never substitute another model for the one named. If `ucch_agent` fails or the model is unavailable, say so and ask the person how to go on.",
  "Use `ucch_agent` with background=true for agents that need messaging or coordination, even when no model is named. Leave `model` out to inherit this session's model. Built-in subagents remain suitable for isolated tasks.",
  "For coordinated work use background=true, continue independent work, and use ucch_message and ucch_agent_status to coordinate. End your turn when waiting; completion messages resume you without holding a scheduler slot.",
  "If `ucch_agent` answers that a model name is ambiguous, pick the closest candidate it lists, or ask the person.",
].join("\n");

/**
 * In place of the guide when `ucch_agent` cannot be offered (the bridge is
 * missing): a named model is then reported, not silently swapped.
 */
export const UCCH_AGENT_UNAVAILABLE_NOTE = [
  "## Subagents on other models",
  "",
  "Subagents on other models or harnesses are unavailable in this session. If the person names a model or harness for a subagent that your built-in subagent tool cannot run,",
  "do not substitute another model: tell them that cross-harness subagents are unavailable, and ask whether to go on with a model you can run.",
].join("\n");

/**
 * Whether an OpenRouter failure is the key's limit rather than the
 * request's fault: out of credits (402), or over the key's own spending
 * limit. Like a CLI plan's usage limit it will not pass on a retry, and
 * another harness can carry the work on.
 */
export function isOpenRouterLimit(message: string): boolean {
  return /\b402\b|insufficient credits|requires more credits|credit limit|key limit (?:exceeded|reached)|out of credits/i.test(message);
}
