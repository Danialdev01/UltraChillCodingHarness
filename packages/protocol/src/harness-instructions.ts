/**
 * What UCCH adds to every harness's own system prompt: one shared rule set
 * for the native loop, Claude Code, Codex and OMP
 * (`documentation/plan/plan1.md`, after t3code's `runtimeInstructions.ts`).
 *
 * Rules for editing this file:
 *
 *  - **Fixed text only.** No value is interpolated into the exported rule
 *    blocks: no path, model, date or name. They sit in the cached prefix of
 *    every turn, and a byte that changes between turns makes every turn pay
 *    full price (`documentation/solutions.md` §7). What does vary -- the
 *    harness, the model, the working directory -- goes in
 *    `buildRuntimeInfo`, which the assembly puts last.
 *  - **Short and imperative.** "Never X. Do Y." Each block stays under
 *    1,500 bytes; `apps/server/src/agent-context-budget.test.ts` fails a
 *    change that grows what any harness is handed past its recorded budget.
 *  - **A wording change is a reviewed change.** Update the snapshots
 *    (`apps/server/src/__snapshots__/cli-instructions.test.ts.snap`) and,
 *    when the size moved, `agent-context-budget.json`, in the same commit.
 *  - **Only describe tools the turn has.** Guides for a tool live with the
 *    tool (`model-routing.ts`, `widgets.ts`) and are added only where it is
 *    offered.
 */
import type { CliProviderId } from "./events.js";
import type { ReasoningEffort } from "./commands.js";

/** The rules every harness is handed: how work in UCCH differs from work at a terminal. */
export const UCCH_WORKING_RULES = [
  "## Working in UCCH",
  "",
  "You are working in a checkout UCCH manages; its path is in <runtime_info>. Keep your changes inside it.",
  "- Never commit or push. The person reviews and commits your changes from UCCH's Git view.",
  "- Ask any question in your reply: the chat is where the person reads and answers it.",
  "- Cite files as Markdown links with the path relative to the project root and a line, e.g. [agent.ts:42](apps/server/src/agent.ts:42). UCCH opens them at that line.",
  "- Your final reply is what the person reads: lead with the outcome, say what you verified and what you did not, and do not narrate plans you did not carry out.",
  "- When something fails (a test, a build, a tool), quote the error and say so. Never report a success you have not seen.",
].join("\n");

/** An ordinary (not plan-draft) turn: act, and ask only what matters. */
export const DEFAULT_MODE_RULES = [
  "## Default mode",
  "",
  "Make reasonable assumptions and carry out the request. Ask a concise question only when a missing decision would materially change the result, and say which assumption you made.",
].join("\n");

/** Each harness's name, as the runtime info says it. */
export const HARNESS_LABELS: Record<CliProviderId | "native", string> = {
  native: "UCCH native",
  claude: "Claude Code",
  codex: "Codex",
  omp: "OMP",
};

/** The most of any one value the runtime info repeats. */
const MAX_RUNTIME_VALUE = 200;

/**
 * One line, with nothing that could close the block or open another:
 * whitespace collapsed, `<`, `>` and backticks removed (as t3code's
 * `toSingleLine` and `folderLabel`), and capped.
 */
function singleLine(value: string): string {
  return value.replace(/[<>`]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_RUNTIME_VALUE);
}

/**
 * The turn's runtime facts, for the model to answer "which model are you?"
 * from. Interpolated, so it goes after every fixed block.
 */
export function buildRuntimeInfo(input: {
  harness: CliProviderId | "native";
  model?: string | null;
  effort?: ReasoningEffort | null;
  workspace: string;
}): string {
  const model = input.model ? singleLine(input.model) : "";
  const named = model && !/^(?:auto|default)$/i.test(model) ? ` as ${model}` : "";
  const effort =
    input.effort === "off" ? " with reasoning off" : input.effort ? ` with ${singleLine(input.effort)} effort` : "";
  return [
    "<runtime_info>",
    `In case you're asked: you're running in UCCH through the ${HARNESS_LABELS[input.harness]} harness${named}${effort}. No need to mention this otherwise.`,
    `Working directory: ${singleLine(input.workspace)}`,
    "</runtime_info>",
  ].join("\n");
}

/** The most of a project's `.agent/` knowledge a CLI harness is handed. */
export const MAX_CLI_KNOWLEDGE_BYTES = 24_000;

/**
 * At most `maxBytes` of UTF-8, cut on a character boundary, with a marker
 * saying how much was left out (t3code's `limitSection`).
 */
export function limitSection(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text);
  if (encoded.byteLength <= maxBytes) return text;
  // Back off to the start of a character, so the cut never splits one.
  let end = Math.max(0, maxBytes);
  while (end > 0 && (encoded[end]! & 0xc0) === 0x80) end--;
  const head = new TextDecoder().decode(encoded.subarray(0, end));
  return `${head}\n[… ${encoded.byteLength - end} more bytes left out]`;
}
