import { createHash } from "node:crypto";
import { DOCUMENTATION_RULES } from "@ucch/agent";
import {
  buildRuntimeInfo,
  DEFAULT_MODE_RULES,
  limitSection,
  MAX_CLI_KNOWLEDGE_BYTES,
  UCCH_AGENT_GUIDE,
  UCCH_AGENT_UNAVAILABLE_NOTE,
  UCCH_SUBAGENT_RULES,
  UCCH_WORKING_RULES,
  WIDGET_PROMPT,
  type CliProviderId,
  type MessageMode,
  type ReasoningEffort,
  type SessionPrefix,
} from "@ucch/protocol";
import { ompBridgeGuide } from "@ucch/providers";
import { COLLABORATION_GUIDE } from "./agent-messaging.js";

/**
 * What a Claude Code, Codex or OMP turn is handed on top of its own system
 * prompt, and what the thread's log records of it
 * (`documentation/architecture.md`, "Agent instructions").
 *
 * Pure, so the order, the gating and the size of every harness's
 * instructions are tested without a turn (`cli-instructions.test.ts`,
 * `agent-context-budget.test.ts`). The CLI's own prompt is never replaced:
 * Claude Code and OMP take this through `--append-system-prompt`, Codex in
 * front of the message (`codexPrompt`).
 *
 * Fixed blocks first and the one interpolated block (`<runtime_info>`) last,
 * so the cached prefix holds across turns.
 */

/** How an OMP turn reaches UCCH's own tools: they are host tools, mounted as devices. */
const OMP_HOST_TOOLS_NOTE =
  "UCCH's own tools named below are xd:// devices: call one by writing its JSON arguments to xd://<name> " +
  "with your write tool, e.g. xd://current_time.";

/**
 * A research turn on OMP (solution §3.7): the native loop's pipeline, in
 * the same order and for the same reasons (`RESEARCH_RULES` in
 * `@ucch/agent`), with the two differences OMP makes -- the tools are
 * devices, and the preset's overlay denies every file change.
 */
const OMP_RESEARCH_RULES = `## Research turn

This is a research turn. The developer wants live, sourced information, not code changes, and this turn cannot change any file. ${OMP_HOST_TOOLS_NOTE} The pipeline's order is deliberate:

1. research_search first: a live web search that returns an answer, the URLs it drew on, and a line on each. Run several focused queries rather than one broad one -- one per sub-question, one per claim you need to check.
2. research_read next, on the URLs that matter: a fast crawler, fine to call on several URLs in parallel. Read the page before you state anything from it as fact; a search summary is a lead, not a source. A gated page is escalated to the browser agent on its own.
3. research_browse only for a page that needs interaction -- something to click, a search form, pagination. It drives a real browser and takes minutes; say precisely what to do and what to bring back.

Then write the answer. Cite the URL beside every claim it supports. Keep what the sources confirm separate from what you inferred, and say what you could not find rather than filling it in. Give dates as the sources give them, and call current_time before saying how recent anything is. The answer is the deliverable: if asked to save the findings, say that this turn cannot write files.`;

/**
 * A documentation turn on OMP: the native loop's rules, whose tools OMP is
 * given as host tools, and what is different here.
 */
const OMP_DOCUMENTATION_RULES = `## Documentation turn

${OMP_HOST_TOOLS_NOTE} The rules below were written for a harness with no shell: you have one, but use the document tools for anything a document needs. Where they say write_file, use your own write tool. Every file you write or edit must be under docs/: anything else is refused.

${DOCUMENTATION_RULES}`;

/**
 * What an OMP turn adds to OMP's system prompt (solution §3.8): the
 * project's `.agent/` knowledge, then UCCH's shared rules, then the
 * composer mode's. OMP reads the worktree's AGENTS.md itself.
 */
export function ompInstructions(
  knowledge: string | null,
  mode?: MessageMode,
  options: { planDraft?: boolean; subagent?: boolean } = {},
): string {
  const modeRules = mode === "research" ? OMP_RESEARCH_RULES : mode === "documentation" ? OMP_DOCUMENTATION_RULES : null;
  const parts = [
    knowledge ? limitSection(knowledge.trimEnd(), MAX_CLI_KNOWLEDGE_BYTES) : null,
    UCCH_WORKING_RULES,
    options.planDraft ? null : DEFAULT_MODE_RULES,
    modeRules,
    options.subagent ? UCCH_SUBAGENT_RULES : null,
  ].filter((part): part is string => Boolean(part));
  return `${parts.join("\n\n")}\n`;
}

/** The sources a CLI turn's instructions are logged under. */
export type InjectedSource = "system_prompt" | "project_context" | "omp_bridge";

export interface CliInstructionsInput {
  provider: CliProviderId;
  /** The checkout the CLI runs in: the runtime info names it. */
  workspace: string;
  model?: string | undefined;
  effort?: ReasoningEffort | undefined;
  /** The project's `.agent/` knowledge (`readProjectKnowledge`). */
  knowledge: string | null;
  mode?: MessageMode | undefined;
  /** A plan-mode draft: the plan rules ride in the message, so no default-mode rules. */
  planDraft: boolean;
  /** A subagent's own session. */
  subagent: boolean;
  /**
   * The session is handed its instructions this turn: always for Claude
   * Code and OMP, only on a new session for Codex, which reads them from
   * its history after that (false: nothing at all).
   */
  fresh: boolean;
  /** The turn's MCP bridge, null when none was opened (not wanted, or its bundle is missing). */
  bridge: { omp: boolean } | null;
  /** `ucch_agent` is wanted for this session (not a subagent's own). */
  offersSubagents: boolean;
  /** Cross-session messaging is on for the server. */
  messaging: boolean;
  /** The workspace allows interactive widgets, and this is not a subagent. */
  widgets: boolean;
}

export interface CliInstructions {
  /** The text the CLI is handed, or null for nothing. */
  instructions: string | null;
  /** The same text, part by part in prompt order, for `context.injected`. */
  injected: { source: InjectedSource; content: string }[];
}

/**
 * Each guide only where its tool exists on the turn (t3code: "instructions
 * for unavailable tools would steer the model away"):
 *
 *  - `ompBridgeGuide` with the bridge's OMP tools;
 *  - `UCCH_AGENT_GUIDE` with `ucch_agent`, which the bridge carries on Claude
 *    Code and Codex and the host tools on OMP; `UCCH_AGENT_UNAVAILABLE_NOTE`
 *    in its place when it was wanted and the bridge is missing;
 *  - `COLLABORATION_GUIDE` with the messaging tools, on the same terms;
 *  - `WIDGET_PROMPT` where widgets are on (the fence works on every harness).
 */
export function assembleCliInstructions(input: CliInstructionsInput): CliInstructions {
  const runtime = buildRuntimeInfo({
    harness: input.provider,
    workspace: input.workspace,
    ...(input.model ? { model: input.model } : {}),
    ...(input.effort ? { effort: input.effort } : {}),
  });
  const widgetRules = input.widgets && input.fresh ? WIDGET_PROMPT : null;

  if (input.provider === "omp") {
    // The host tools carry `ucch_agent` and the messaging tools: no bridge.
    const parts = [
      ompInstructions(input.knowledge, input.mode, { planDraft: input.planDraft, subagent: input.subagent }).trimEnd(),
      input.offersSubagents ? UCCH_AGENT_GUIDE : null,
      input.messaging ? COLLABORATION_GUIDE : null,
      widgetRules,
      runtime,
    ].filter((part): part is string => Boolean(part));
    // The whole appended prompt as one row, byte for byte.
    const instructions = `${parts.join("\n\n")}\n`;
    return { instructions, injected: [{ source: "system_prompt", content: instructions }] };
  }

  const bridge = input.bridge;
  if (!input.fresh) {
    // A resumed Codex session: its history holds the first turn's
    // instructions, guides and all, so nothing goes again (plan2 §2.5) --
    // a guide sent every turn grows the context by itself every turn. After
    // a compaction drops them, the session's stored text is sent once
    // (`planSessionPrefix`).
    return { instructions: null, injected: [] };
  }

  const knowledge = input.knowledge ? limitSection(input.knowledge.trimEnd(), MAX_CLI_KNOWLEDGE_BYTES) : null;
  const rules = [UCCH_WORKING_RULES, input.planDraft ? null : DEFAULT_MODE_RULES, input.subagent ? UCCH_SUBAGENT_RULES : null]
    .filter((part): part is string => Boolean(part))
    .join("\n\n");
  const guide = bridge
    ? [
        bridge.omp ? ompBridgeGuide() : null,
        input.offersSubagents ? UCCH_AGENT_GUIDE : null,
        input.messaging ? COLLABORATION_GUIDE : null,
      ]
        .filter((part): part is string => Boolean(part))
        .join("\n\n") || null
    : input.offersSubagents
      ? UCCH_AGENT_UNAVAILABLE_NOTE
      : null;

  const injected: CliInstructions["injected"] = [];
  const parts: string[] = [];
  if (knowledge) {
    // Fenced as the project's own reference material, apart from UCCH's rules.
    parts.push(`<project-knowledge>\n${knowledge}\n</project-knowledge>`);
    injected.push({ source: "project_context", content: knowledge });
  }
  parts.push(rules);
  injected.push({ source: "system_prompt", content: rules });
  if (guide) {
    parts.push(guide);
    injected.push({ source: "omp_bridge", content: guide });
  }
  if (widgetRules) {
    parts.push(widgetRules);
    injected.push({ source: "system_prompt", content: widgetRules });
  }
  parts.push(runtime);
  injected.push({ source: "system_prompt", content: runtime });
  return { instructions: parts.join("\n\n"), injected };
}

/** sha256 of a text, hex. */
export function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * A line diff of `before` to `after`: kept lines with two spaces, removed
 * with `-`, added with `+`, with unchanged runs longer than `context` lines
 * on either side of a change folded to a count.
 */
export function lineDiff(before: string, after: string, context = 2): string {
  const a = before.split("\n");
  const b = after.split("\n");
  // Longest common subsequence, from the end, so the walk below goes forward.
  const lcs: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
    }
  }
  const ops: { op: " " | "-" | "+"; line: string }[] = [];
  let i = 0;
  let j = 0;
  while (i < a.length || j < b.length) {
    if (i < a.length && j < b.length && a[i] === b[j]) {
      ops.push({ op: " ", line: a[i]! });
      i++;
      j++;
    } else if (i < a.length && (j === b.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) {
      // Removals first, as a unified diff has them.
      ops.push({ op: "-", line: a[i]! });
      i++;
    } else {
      ops.push({ op: "+", line: b[j]! });
      j++;
    }
  }
  const changed = ops.map((entry) => entry.op !== " ");
  const near = (index: number) => {
    for (let k = Math.max(0, index - context); k <= Math.min(ops.length - 1, index + context); k++) if (changed[k]) return true;
    return false;
  };
  const out: string[] = [];
  let folded = 0;
  ops.forEach((entry, index) => {
    if (entry.op === " " && !near(index)) {
      folded++;
      return;
    }
    if (folded > 0) out.push(`  … ${folded} unchanged line${folded === 1 ? "" : "s"}`);
    folded = 0;
    out.push(`${entry.op === " " ? " " : entry.op} ${entry.line}`);
  });
  if (folded > 0) out.push(`  … ${folded} unchanged line${folded === 1 ? "" : "s"}`);
  return out.join("\n");
}

/** What a resumed session is told when its `.agent/` notes changed under it: the change, not the notes again. */
export function knowledgeUpdate(before: string | null, after: string | null): string {
  const diff = limitSection(lineDiff(before ?? "", after ?? ""), MAX_CLI_KNOWLEDGE_BYTES);
  return [
    "<project-knowledge-update>",
    "The project's .agent/ notes changed since this session started. This replaces what <project-knowledge> said where they differ: lines starting with - were removed, lines starting with + were added.",
    diff,
    "</project-knowledge-update>",
  ].join("\n");
}

export interface SessionPrefixInput {
  /** What the thread keeps (`threads.session_prefix`), or null. */
  stored: SessionPrefix | null;
  /** The session this turn resumes, or null for a new one. */
  resumeToken: string | null;
  /** How the instructions would be built for a new session (`fresh` is set here). */
  build: Omit<CliInstructionsInput, "fresh" | "provider"> & { provider: "claude" | "codex" };
  /** The tools the bridge was opened with. */
  tools: SessionPrefix["tools"];
}

export interface SessionPrefixPlan {
  /** What the CLI is handed this turn: the session's own text, or nothing on a resumed Codex turn. */
  instructions: string | null;
  /** What the thread's log records of it. */
  injected: CliInstructions["injected"];
  /** Goes in front of the message: the `.agent/` notes that changed, as a diff. */
  messagePrefix: string | null;
  /** What the thread keeps after this turn. */
  prefix: SessionPrefix;
  /** The stored text was kept: the cached prefix is unchanged. */
  reused: boolean;
}

/** The parts of a session's prefix that must hold for its text to be kept. */
export function sessionTools(tools: SessionPrefix["tools"]): string {
  return `${tools.omp ? 1 : 0}${tools.subagents ? 1 : 0}${tools.messaging ? 1 : 0}${tools.widgets ? 1 : 0}`;
}

/**
 * The instructions a Claude Code or Codex session is handed, fixed for the
 * session's life (plan2 §2.3-2.5):
 *
 * - built once, when the session starts, and kept with the thread;
 * - every resumed turn hands Claude Code the same text, byte for byte, so
 *   `--append-system-prompt` -- and every cached token after it -- holds;
 * - a resumed Codex turn is handed nothing (its history holds the first
 *   turn's message), except once after a compaction dropped it (`resend`);
 * - `.agent/` notes that changed go in the message as a diff, and only when
 *   they changed;
 * - a new model or effort, or a different bridge, starts a new prefix on
 *   Claude Code: the runtime info names them, and a new model's cache is
 *   cold whatever the text says.
 */
export function planSessionPrefix(input: SessionPrefixInput): SessionPrefixPlan {
  const { stored, resumeToken, build } = input;
  const provider = build.provider;
  const knowledge = build.knowledge ? limitSection(build.knowledge.trimEnd(), MAX_CLI_KNOWLEDGE_BYTES) : null;
  const knowledgeSha256 = knowledge === null ? null : sha256(knowledge);
  const model = build.model ?? null;
  const effort = build.effort ?? null;
  const bridge = build.bridge ? { omp: build.bridge.omp } : null;
  const sameSession = Boolean(stored && resumeToken && stored.provider === provider && stored.sessionId === resumeToken);
  const sameShape =
    stored !== null &&
    sessionTools(stored.tools) === sessionTools(input.tools) &&
    (stored.bridge === undefined || (stored.bridge?.omp ?? null) === (bridge?.omp ?? null));
  // Codex's instructions are in its history, not a system prompt: a new
  // model does not change what it already read.
  const sameRun = provider === "codex" || (stored?.model === model && stored?.effort === effort);

  if (stored && sameSession && sameShape && sameRun) {
    const changed = stored.knowledgeSha256 !== knowledgeSha256;
    const messagePrefix = changed ? knowledgeUpdate(stored.knowledge, knowledge) : null;
    const resend = provider === "codex" && stored.resend === true;
    const instructions = provider === "claude" || resend ? stored.text : null;
    const injected: CliInstructions["injected"] = [
      {
        source: "system_prompt",
        content: resend
          ? `Session prefix sha256 ${stored.sha256}, sent again after the session was compacted.`
          : `Session prefix sha256 ${stored.sha256}, unchanged.`,
      },
    ];
    if (messagePrefix) injected.push({ source: "project_context", content: messagePrefix });
    return {
      instructions,
      injected,
      messagePrefix,
      prefix: {
        ...stored,
        knowledge,
        knowledgeSha256,
        ...(provider === "codex" ? { model, effort } : {}),
        resend: false,
      },
      reused: true,
    };
  }

  const built = assembleCliInstructions({ ...build, fresh: true });
  const text = built.instructions ?? "";
  const hash = sha256(text);
  const prefix: SessionPrefix = {
    provider,
    sessionId: resumeToken,
    text,
    sha256: hash,
    knowledge,
    knowledgeSha256,
    model,
    effort,
    tools: input.tools,
    bridge,
    resend: false,
  };
  // A resumed Codex session read its instructions on its first turn: the
  // text is kept for the turn after a compaction, not sent again now.
  if (provider === "codex" && resumeToken) {
    return {
      instructions: null,
      injected: [{ source: "system_prompt", content: `Session prefix sha256 ${hash}, kept for after a compaction.` }],
      messagePrefix: null,
      prefix,
      reused: false,
    };
  }
  return {
    instructions: built.instructions,
    injected: [...built.injected, { source: "system_prompt", content: `Session prefix sha256 ${hash}, new.` }],
    messagePrefix: null,
    prefix,
    reused: false,
  };
}
