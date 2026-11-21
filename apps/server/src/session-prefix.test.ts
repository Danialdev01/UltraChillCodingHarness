import { describe, expect, it } from "vitest";
import type { SessionPrefix } from "@ucch/protocol";
import { assembleCliInstructions, lineDiff, planSessionPrefix, sha256, type SessionPrefixInput } from "./cli-instructions.js";

/** A turn's build: every test varies one thing from here. */
const BUILD: SessionPrefixInput["build"] = {
  provider: "claude",
  workspace: "/srv/ucch/workspaces/p1",
  model: "claude-opus-5-5",
  effort: "high",
  knowledge: "# Project\nUses pnpm.\n",
  planDraft: false,
  subagent: false,
  bridge: { omp: false },
  offersSubagents: true,
  messaging: false,
  widgets: true,
};
const TOOLS = { omp: false, subagents: true, messaging: false, widgets: true };

/** The first turn, then the session id the CLI named, as `#runCli` keeps it. */
function started(build = BUILD): SessionPrefix {
  const first = planSessionPrefix({ stored: null, resumeToken: null, build, tools: TOOLS });
  return { ...first.prefix, sessionId: "s1" };
}

describe("a session's fixed prefix (plan2 §2.3-2.5)", () => {
  it("builds a new session's text once and hands every resumed Claude turn the same bytes", () => {
    const first = planSessionPrefix({ stored: null, resumeToken: null, build: BUILD, tools: TOOLS });
    expect(first.reused).toBe(false);
    expect(first.instructions).toBe(assembleCliInstructions({ ...BUILD, fresh: true }).instructions);
    expect(first.prefix.sha256).toBe(sha256(first.instructions!));
    expect(first.injected.at(-1)).toEqual({ source: "system_prompt", content: `Session prefix sha256 ${first.prefix.sha256}, new.` });

    let stored: SessionPrefix = { ...first.prefix, sessionId: "s1" };
    for (let turn = 0; turn < 3; turn++) {
      // The widgets setting was switched off meanwhile: the session keeps its tools.
      const next = planSessionPrefix({ stored, resumeToken: "s1", build: { ...BUILD, widgets: false }, tools: TOOLS });
      expect(next.reused).toBe(true);
      expect(next.instructions).toBe(first.instructions);
      expect(next.prefix.sha256).toBe(first.prefix.sha256);
      expect(next.messagePrefix).toBeNull();
      expect(next.injected).toEqual([{ source: "system_prompt", content: `Session prefix sha256 ${first.prefix.sha256}, unchanged.` }]);
      stored = next.prefix;
    }
  });

  it("sends changed .agent/ notes in the message as a diff, once, and keeps the text", () => {
    const stored = started();
    const build = { ...BUILD, knowledge: "# Project\nUses pnpm.\nTests: vitest.\n" };
    const next = planSessionPrefix({ stored, resumeToken: "s1", build, tools: TOOLS });
    expect(next.instructions).toBe(stored.text);
    expect(next.messagePrefix).toContain("<project-knowledge-update>");
    expect(next.messagePrefix).toContain("+ Tests: vitest.");
    expect(next.messagePrefix).not.toContain("- Uses pnpm.");
    expect(next.injected).toContainEqual({ source: "project_context", content: next.messagePrefix });
    // The next turn: the update is what the session already has.
    const after = planSessionPrefix({ stored: next.prefix, resumeToken: "s1", build, tools: TOOLS });
    expect(after.messagePrefix).toBeNull();
    expect(after.instructions).toBe(stored.text);
  });

  it("starts a new prefix for another session, model, effort or bridge", () => {
    const stored = started();
    expect(planSessionPrefix({ stored, resumeToken: "s2", build: BUILD, tools: TOOLS }).reused).toBe(false);
    expect(planSessionPrefix({ stored, resumeToken: "s1", build: { ...BUILD, model: "claude-sonnet-5-5" }, tools: TOOLS }).reused).toBe(false);
    expect(planSessionPrefix({ stored, resumeToken: "s1", build: { ...BUILD, effort: "max" }, tools: TOOLS }).reused).toBe(false);
    expect(planSessionPrefix({ stored, resumeToken: "s1", build: { ...BUILD, bridge: null }, tools: TOOLS }).reused).toBe(false);
    expect(planSessionPrefix({ stored, resumeToken: "s1", build: BUILD, tools: { ...TOOLS, subagents: false } }).reused).toBe(false);
  });

  it("hands a resumed Codex turn nothing, and the stored text once after a compaction", () => {
    const build = { ...BUILD, provider: "codex" as const, model: "gpt-6.1-sol" };
    const stored = started(build);
    const quiet = planSessionPrefix({ stored, resumeToken: "s1", build, tools: TOOLS });
    expect(quiet.instructions).toBeNull();
    const again = planSessionPrefix({ stored: { ...stored, resend: true }, resumeToken: "s1", build, tools: TOOLS });
    expect(again.instructions).toBe(stored.text);
    expect(again.prefix.resend).toBe(false);
    expect(planSessionPrefix({ stored: again.prefix, resumeToken: "s1", build, tools: TOOLS }).instructions).toBeNull();
    // A resumed session nothing was kept for: the text is kept for later, not sent.
    const legacy = planSessionPrefix({ stored: null, resumeToken: "s1", build, tools: TOOLS });
    expect(legacy.instructions).toBeNull();
    expect(legacy.prefix.text).toBe(stored.text);
  });
});

describe("lineDiff", () => {
  it("marks removed and added lines and folds long unchanged runs", () => {
    const before = ["a", "b", "c", "d", "e", "f", "g"].join("\n");
    const after = ["a", "b", "c", "D", "e", "f", "g"].join("\n");
    expect(lineDiff(before, after, 1)).toBe(["  … 2 unchanged lines", "  c", "- d", "+ D", "  e", "  … 2 unchanged lines"].join("\n"));
  });
});
