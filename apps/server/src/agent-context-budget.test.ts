import { readFileSync, writeFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { HARNESS_RULES } from "@ucch/agent";
import {
  DEFAULT_MODE_RULES,
  PLAN_DRAFT_RULES,
  UCCH_AGENT_GUIDE,
  UCCH_SUBAGENT_RULES,
  UCCH_WORKING_RULES,
  WIDGET_PROMPT,
} from "@ucch/protocol";
import { COLLABORATION_GUIDE } from "./agent-messaging.js";
import { assembleCliInstructions, type CliInstructionsInput } from "./cli-instructions.js";

/**
 * How many bytes of instructions UCCH hands each harness, on fixed fixture
 * turns (plan1 §5.1, after t3code's `AgentContextBudget.test.ts`).
 *
 * The figures are recorded in `agent-context-budget.json`; a turn that
 * grows past its figure by even a byte fails here, so instruction
 * bloat is caught in review rather than paid for on every turn. A change
 * that means to grow them updates the JSON in the same commit:
 * `UCCH_UPDATE_CONTEXT_BUDGET=1 npx vitest run apps/server/src/agent-context-budget.test.ts`.
 */
const BUDGET_FILE = new URL("./agent-context-budget.json", import.meta.url);
/** The most any one fixed block may be. */
const MAX_BLOCK_BYTES = 1_500;

const bytes = (text: string | null) => (text ? Buffer.byteLength(text, "utf8") : 0);

/** The project's knowledge is the project's, not UCCH's: none, so the figures are UCCH's alone. */
const BASE: CliInstructionsInput = {
  provider: "claude",
  workspace: "/srv/ucch/workspaces/00000000-0000-0000-0000-000000000000/worktrees/0000000000",
  model: "claude-opus-5-5",
  effort: "high",
  knowledge: null,
  planDraft: false,
  subagent: false,
  fresh: true,
  bridge: null,
  offersSubagents: false,
  messaging: false,
  widgets: false,
};

const everyTool: Partial<CliInstructionsInput> = { bridge: { omp: true }, offersSubagents: true, messaging: true, widgets: true };

const CLI_CASES: Record<string, Partial<CliInstructionsInput>> = {
  "claude.default": {},
  "claude.plan_draft": { planDraft: true },
  "claude.subagent": { subagent: true },
  "claude.every_tool": everyTool,
  "codex.default": { provider: "codex", model: "gpt-6" },
  "codex.every_tool": { provider: "codex", model: "gpt-6", ...everyTool },
  // Nothing: its history holds the first turn's (plan2 §2.5).
  "codex.resumed_coordinated": { provider: "codex", model: "gpt-6", fresh: false, ...everyTool },
  "omp.default": { provider: "omp", model: "openai/gpt-5" },
  "omp.plan_draft": { provider: "omp", model: "openai/gpt-5", planDraft: true },
  "omp.subagent": { provider: "omp", model: "openai/gpt-5", subagent: true },
  "omp.every_tool": { provider: "omp", model: "openai/gpt-5", offersSubagents: true, messaging: true, widgets: true },
};

/** What each fixture is handed, in bytes. */
function measure(): Record<string, number> {
  const figures: Record<string, number> = {};
  for (const [name, over] of Object.entries(CLI_CASES)) {
    figures[name] = bytes(assembleCliInstructions({ ...BASE, ...over }).instructions);
  }
  // The native loop: its fixed rules and widgets, plus the extra
  // instructions the server adds (`agent.ts`, the `runTurn` call).
  const native = bytes(HARNESS_RULES) + bytes(WIDGET_PROMPT);
  figures["native.default"] = native;
  figures["native.every_tool"] = native + bytes(`${COLLABORATION_GUIDE}\n\n${UCCH_AGENT_GUIDE}`);
  figures["native.subagent"] = bytes(HARNESS_RULES) + bytes(`${COLLABORATION_GUIDE}\n\n${UCCH_SUBAGENT_RULES}`);
  figures["native.plan_draft"] = native + bytes(PLAN_DRAFT_RULES);
  return figures;
}

describe("the instructions each harness is handed", () => {
  const figures = measure();
  if (process.env.UCCH_UPDATE_CONTEXT_BUDGET === "1") writeFileSync(BUDGET_FILE, `${JSON.stringify(figures, null, 2)}\n`);
  const budget = JSON.parse(readFileSync(BUDGET_FILE, "utf8")) as Record<string, number>;

  it("hands a resumed Codex session nothing every turn", () => {
    expect(figures["codex.resumed_coordinated"]).toBe(0);
  });

  it("has a recorded budget for every fixture, and none for a fixture that is gone", () => {
    expect(Object.keys(budget).sort()).toEqual(Object.keys(figures).sort());
  });

  for (const [name, size] of Object.entries(figures)) {
    it(`${name} stays within its budget`, () => {
      expect(size, `${name} is ${size} bytes; its budget is ${budget[name]}`).toBeLessThanOrEqual(budget[name] ?? 0);
    });
  }

  it(`keeps each shared block under ${MAX_BLOCK_BYTES} bytes`, () => {
    for (const [name, block] of Object.entries({ UCCH_WORKING_RULES, DEFAULT_MODE_RULES, UCCH_SUBAGENT_RULES })) {
      expect(bytes(block), name).toBeLessThanOrEqual(MAX_BLOCK_BYTES);
    }
  });
});
