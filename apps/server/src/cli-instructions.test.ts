import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODE_RULES,
  UCCH_AGENT_GUIDE,
  UCCH_AGENT_UNAVAILABLE_NOTE,
  UCCH_SUBAGENT_RULES,
  UCCH_WORKING_RULES,
  WIDGET_PROMPT,
  type CliProviderId,
} from "@ucch/protocol";
import { ompBridgeGuide } from "@ucch/providers";
import { COLLABORATION_GUIDE } from "./agent-messaging.js";
import { assembleCliInstructions, type CliInstructionsInput } from "./cli-instructions.js";

/** A fixed turn: every test varies one thing from here. */
const BASE: CliInstructionsInput = {
  provider: "claude",
  workspace: "/srv/ucch/workspaces/p1",
  model: "claude-opus-5-5",
  effort: "high",
  knowledge: "# Project\nUses pnpm.\n",
  planDraft: false,
  subagent: false,
  fresh: true,
  bridge: null,
  offersSubagents: false,
  messaging: false,
  widgets: false,
};

const assemble = (over: Partial<CliInstructionsInput> = {}) => assembleCliInstructions({ ...BASE, ...over });

describe("assembleCliInstructions", () => {
  it("hands Claude Code and a new Codex session the knowledge, UCCH's rules, then the runtime info, in that order", () => {
    for (const provider of ["claude", "codex"] as const) {
      const { instructions, injected } = assemble({ provider });
      expect(instructions).toBe(
        [
          "<project-knowledge>\n# Project\nUses pnpm.\n</project-knowledge>",
          `${UCCH_WORKING_RULES}\n\n${DEFAULT_MODE_RULES}`,
          injected.at(-1)!.content,
        ].join("\n\n"),
      );
      expect(injected.map((part) => part.source)).toEqual(["project_context", "system_prompt", "system_prompt"]);
      expect(injected.at(-1)!.content).toMatch(/^<runtime_info>\n[\s\S]*<\/runtime_info>$/);
      // The log holds the same bytes the CLI was handed, part by part.
      expect(injected.every((part) => instructions!.includes(part.content))).toBe(true);
    }
  });

  it("names the harness, the model, the effort and the working directory in the runtime info", () => {
    const runtime = assemble({ provider: "codex", model: "gpt-6", effort: "xhigh" }).injected.at(-1)!.content;
    expect(runtime).toContain("through the Codex harness as gpt-6 with xhigh effort.");
    expect(runtime).toContain("Working directory: /srv/ucch/workspaces/p1");
    const bare = assemble({ model: undefined, effort: undefined }).injected.at(-1)!.content;
    expect(bare).toContain("through the Claude Code harness. No need");
  });

  it("leaves the default-mode rules off a plan draft", () => {
    for (const provider of ["claude", "codex", "omp"] as const) {
      expect(assemble({ provider, planDraft: true }).instructions).not.toContain(DEFAULT_MODE_RULES);
      expect(assemble({ provider }).instructions).toContain(DEFAULT_MODE_RULES);
    }
  });

  it("adds the subagent's rules to a subagent's own session only", () => {
    for (const provider of ["claude", "codex", "omp"] as const) {
      expect(assemble({ provider, subagent: true }).instructions).toContain(UCCH_SUBAGENT_RULES);
      expect(assemble({ provider }).instructions).not.toContain(UCCH_SUBAGENT_RULES);
    }
  });

  it("caps the project's knowledge", () => {
    const { instructions, injected } = assemble({ knowledge: "x".repeat(40_000) });
    expect(injected[0]!.content).toMatch(/\[… \d+ more bytes left out\]$/);
    expect(instructions!.length).toBeLessThan(30_000);
  });

  it("hands a resumed Codex session no rules again, and only the coordination guides whose tools it has", () => {
    const resumed = { provider: "codex" as const, fresh: false };
    expect(assemble(resumed)).toEqual({ instructions: null, injected: [] });
    expect(assemble({ ...resumed, bridge: { omp: true }, offersSubagents: true, widgets: true })).toEqual({ instructions: null, injected: [] });
    const coordinated = assemble({ ...resumed, messaging: true, offersSubagents: true, bridge: { omp: false } });
    expect(coordinated.instructions).toBe(`${COLLABORATION_GUIDE}\n\n${UCCH_AGENT_GUIDE}`);
    expect(coordinated.injected).toEqual([{ source: "omp_bridge", content: coordinated.instructions }]);
    // No bridge: no messaging tools to describe, and `ucch_agent` is reported missing.
    expect(assemble({ ...resumed, messaging: true, offersSubagents: true }).instructions).toBe(UCCH_AGENT_UNAVAILABLE_NOTE);
  });

  it("logs an OMP turn's appended prompt as one row, byte for byte", () => {
    const { instructions, injected } = assemble({ provider: "omp", offersSubagents: true, messaging: true, widgets: true });
    expect(injected).toEqual([{ source: "system_prompt", content: instructions }]);
    expect(instructions!.startsWith(`# Project\nUses pnpm.\n\n${UCCH_WORKING_RULES}`)).toBe(true);
    expect(instructions!.endsWith("</runtime_info>\n")).toBe(true);
  });
});

/**
 * Plan1 §2.3: a guide is in a turn's instructions exactly when its tool is
 * on the turn, for every harness and every combination.
 */
describe("each guide only with its tool", () => {
  const providers: CliProviderId[] = ["claude", "codex", "omp"];
  const flags = [false, true];
  for (const provider of providers) {
    for (const bridged of flags) {
      for (const ompTools of flags) {
        for (const offersSubagents of flags) {
          for (const messaging of flags) {
            for (const widgets of flags) {
              // OMP never opens the bridge: its host tools carry UCCH's tools.
              if (provider === "omp" && (bridged || ompTools)) continue;
              if (!bridged && ompTools) continue;
              const name = `${provider} bridge=${bridged} omp=${ompTools} subagents=${offersSubagents} messaging=${messaging} widgets=${widgets}`;
              it(name, () => {
                const text = assemble({
                  provider,
                  bridge: bridged ? { omp: ompTools } : null,
                  offersSubagents,
                  messaging,
                  widgets,
                }).instructions!;
                const hasAgentTool = offersSubagents && (provider === "omp" || bridged);
                const hasMessaging = messaging && (provider === "omp" || bridged);
                expect(text.includes(ompBridgeGuide())).toBe(bridged && ompTools);
                expect(text.includes(UCCH_AGENT_GUIDE)).toBe(hasAgentTool);
                expect(text.includes(UCCH_AGENT_UNAVAILABLE_NOTE)).toBe(offersSubagents && !hasAgentTool);
                expect(text.includes(COLLABORATION_GUIDE)).toBe(hasMessaging);
                expect(text.includes(WIDGET_PROMPT)).toBe(widgets);
              });
            }
          }
        }
      }
    }
  }
});

/**
 * Plan1 §5.2: the whole assembled text per harness and mode, so a change to
 * any wording shows up in review as a snapshot diff.
 */
describe("the assembled instructions", () => {
  const cases: [string, Partial<CliInstructionsInput>][] = [
    ["claude default", {}],
    ["claude plan draft", { planDraft: true }],
    ["claude subagent", { subagent: true }],
    ["claude with every tool", { bridge: { omp: true }, offersSubagents: true, messaging: true, widgets: true }],
    ["codex new session", { provider: "codex", model: "gpt-6", effort: "medium" }],
    ["codex resumed and coordinated", { provider: "codex", fresh: false, bridge: { omp: false }, offersSubagents: true, messaging: true }],
    ["omp default", { provider: "omp", model: "openai/gpt-5", effort: undefined }],
    ["omp research", { provider: "omp", model: "openai/gpt-5", mode: "research" }],
    ["omp plan draft", { provider: "omp", model: "openai/gpt-5", planDraft: true }],
  ];
  for (const [name, over] of cases) {
    it(name, () => {
      expect(assemble(over).instructions).toMatchSnapshot();
    });
  }
});
