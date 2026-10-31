import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { HostProcessHost, OmpProvider } from "@ucch/providers";
import {
  buildHandoffBrief,
  HANDOFF_INSTRUCTION,
  handoffMessage,
  handoffPrompt,
  handoffTitle,
  maskSecrets,
  renderTranscript,
  TOOL_RESULT_BYTES,
} from "./omp-handoff.js";

const THREAD = "00000000-0000-4000-8000-000000000002";
const TURN = "00000000-0000-4000-8000-000000000003";
const PROJECT = "00000000-0000-4000-8000-000000000004";
const FAKE_OMP = join(import.meta.dirname, "../../../scripts/load/fake-omp.mjs");

const user = (text: string): DomainEvent => ({ type: "user.message", threadId: THREAD, text });
const said = (text: string): DomainEvent => ({ type: "agent.message", threadId: THREAD, turnId: TURN, content: [{ type: "text", text }] });
const call = (id: string, name: string, input: unknown): DomainEvent => ({
  type: "agent.tool_use",
  threadId: THREAD,
  turnId: TURN,
  toolUseId: id,
  name,
  input,
});
const result = (id: string, content: string, isError = false): DomainEvent => ({
  type: "agent.tool_result",
  threadId: THREAD,
  turnId: TURN,
  toolUseId: id,
  content,
  isError,
  durationMs: 5,
});
const changed = (path: string, change: "added" | "modified" | "deleted" = "modified"): DomainEvent => ({
  type: "file.changed",
  projectId: PROJECT,
  path,
  change,
});

describe("renderTranscript", () => {
  it("is the conversation in order, each call with its result, then the files changed", () => {
    const text = renderTranscript([
      user("Fix the parser bug."),
      { type: "context.injected", threadId: THREAD, source: "system_prompt", content: "You are an agent." },
      { type: "turn.started", threadId: THREAD, turnId: TURN },
      said("Looking."),
      call("c1", "read_file", { path: "src/parser.ts" }),
      result("c1", "export function parse() {}"),
      call("c2", "bash", { command: "pnpm test" }),
      result("c2", "1 failed", true),
      changed("src/parser.ts"),
      changed("src/new.ts", "added"),
      said("Fixed the off-by-one."),
    ]);
    expect(text).toBe(
      [
        "## User\nFix the parser bug.",
        "## Assistant\nLooking.",
        '### Tool call: read_file({"path":"src/parser.ts"})\nexport function parse() {}',
        '### Tool call: bash({"command":"pnpm test"})\nFailed:\n1 failed',
        "## Assistant\nFixed the off-by-one.",
        "## Files changed\n- src/parser.ts (modified)\n- src/new.ts (added)",
      ].join("\n\n"),
    );
    // What the model was handed is not the conversation.
    expect(text).not.toContain("You are an agent.");
  });

  it("cuts each tool result to 2 KB, on a character", () => {
    const long = "é".repeat(TOOL_RESULT_BYTES); // two bytes each
    const text = renderTranscript([call("c1", "read_file", { path: "a" }), result("c1", long)]);
    const body = text.split("\n")[1]!;
    expect(Buffer.byteLength(body, "utf8")).toBeLessThanOrEqual(TOOL_RESULT_BYTES);
    expect(body).toBe("é".repeat(TOOL_RESULT_BYTES / 2));
    expect(text).toContain(`[… ${TOOL_RESULT_BYTES} more bytes]`);
  });

  it("keeps the summary an earlier compaction or handoff left", () => {
    const text = renderTranscript([
      { type: "context.injected", threadId: THREAD, source: "compaction", content: "## Goal\nShip it." },
      user("And now?"),
    ]);
    expect(text).toBe("## Summary of the conversation before this point\n## Goal\nShip it.\n\n## User\nAnd now?");
  });

  it("holds to its token budget, keeping the newest and the files, and saying what it left out", () => {
    const events: DomainEvent[] = [changed("src/kept.ts")];
    for (let i = 0; i < 200; i++) events.push(user(`question ${i} ${"x".repeat(400)}`), said(`answer ${i}`));
    const text = renderTranscript(events, { maxTokens: 2_000 });
    expect(text.length).toBeLessThanOrEqual(2_000 * 4);
    expect(text).toMatch(/^\[\d+ earlier parts of the conversation left out for length\]/);
    expect(text).toContain("answer 199");
    expect(text).not.toContain("question 0 ");
    expect(text.endsWith("## Files changed\n- src/kept.ts (modified)")).toBe(true);
  });

  it("masks what looks like a credential, wherever it is", () => {
    const text = renderTranscript([
      user("My key is OPENROUTER_API_KEY=sk-or-v1-abcdef0123456789 please use it"),
      call("c1", "bash", { command: 'export ANTHROPIC_API_KEY="sk-ant-api03-secretsecret"' }),
      result("c1", "GITHUB_TOKEN: ghp_abcdefghijklmnop1234\nAuthorization: Bearer eyJhbGciOiJIUzI1NiJ9.payload"),
    ]);
    expect(text).toContain("OPENROUTER_API_KEY=<redacted> please use it");
    expect(text).toContain("ANTHROPIC_API_KEY=<redacted>");
    expect(text).toContain("GITHUB_TOKEN: <redacted>");
    expect(text).toContain("Bearer <redacted>");
    for (const secret of ["sk-or-v1-abcdef", "secretsecret", "ghp_abcdef", "eyJhbGci"]) expect(text).not.toContain(secret);
  });
});

describe("maskSecrets", () => {
  it("masks config keys that are credentials, and leaves ones that only mention the word", () => {
    expect(maskSecrets('{"apiKey": "abc123", "maxTokens": 24000}')).toBe('{"apiKey": "<redacted>", "maxTokens": 24000}');
    expect(maskSecrets("password: hunter2\ntokens: 12")).toBe("password: <redacted>\ntokens: 12");
    expect(maskSecrets("inputTokens: 1200, the token budget")).toBe("inputTokens: 1200, the token budget");
    expect(maskSecrets("key sk-proj-AAAAAAAAAAAAAAAA end")).toBe("key <redacted> end");
  });
});

describe("handoffPrompt", () => {
  it("is the fixed instruction, and the focus when there is one", () => {
    expect(handoffPrompt()).toBe(HANDOFF_INSTRUCTION);
    expect(handoffPrompt("  ")).toBe(HANDOFF_INSTRUCTION);
    expect(handoffPrompt(" the migration ")).toBe(`${HANDOFF_INSTRUCTION}\n\nFocus on: the migration`);
  });
});

describe("the new thread", () => {
  it("opens with the brief marked as one, then the request", () => {
    expect(handoffMessage("  ## Goal\nShip it.\n")).toBe("<handoff-brief>\n## Goal\nShip it.\n</handoff-brief>\n\nContinue from here.");
  });

  it("is titled for what it carries on, once however often it is handed on", () => {
    expect(handoffTitle("Fix the parser")).toBe("Continued: Fix the parser");
    expect(handoffTitle("Continued: Fix the parser")).toBe("Continued: Fix the parser");
    expect(handoffTitle("  ")).toBe("Continued: Untitled");
    expect(handoffTitle("x".repeat(300))).toHaveLength(200);
  });
});

describe("buildHandoffBrief against fake-omp", () => {
  const files = { overlayPath: "/c/omp/run/brief.yml", guardHookPath: "/c/omp/agent/ucch-guard.ts" };
  const events = [user("Fix the parser bug. OPENROUTER_API_KEY=sk-or-v1-0123456789abcdef"), said("Fixed it."), changed("src/parser.ts")];

  function setup(extraEnv: Record<string, string> = {}) {
    const log = join(mkdtempSync(join(tmpdir(), "omp-handoff-")), "print.jsonl");
    const ctx = {
      cwd: tmpdir(),
      env: { PATH: process.env.PATH ?? "/usr/bin", OPENROUTER_API_KEY: "sk-or-test", FAKE_OMP_PRINT_LOG: log, ...extraEnv },
      host: new HostProcessHost(),
    };
    return { ctx, log, omp: new OmpProvider(FAKE_OMP) };
  }

  it("writes the brief from the masked, capped transcript on stdin, with no tools and no session", async () => {
    const { ctx, log, omp } = setup();
    const brief = await buildHandoffBrief({ omp, ctx, files, events, focus: "the tests", maxTokens: 500 });
    expect(brief).toMatch(/^## Goal\nFix the parser bug\. OPENROUTER_API_KEY=<redacted>\n## Done\nRead \d+ characters of transcript\.\n## Next\nthe tests$/);
    const [sent] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; stdin: string; prompt: string });
    expect(sent!.argv).toEqual(expect.arrayContaining(["-p", "--no-session", "--no-tools", "--model", "@smol", "--config", files.overlayPath]));
    expect(sent!.prompt).toBe(handoffPrompt("the tests"));
    expect(sent!.stdin).toContain("## Files changed\n- src/parser.ts (modified)");
    expect(sent!.stdin).not.toContain("sk-or-v1-0123456789abcdef");
    expect(sent!.stdin.length).toBeLessThanOrEqual(500 * 4 + "<transcript>\n\n</transcript>\n".length);
  });

  it("rejects with OMP's error", async () => {
    const { ctx, omp } = setup({ FAKE_OMP_PRINT_FAIL: "No API key found for openrouter." });
    await expect(buildHandoffBrief({ omp, ctx, files, events })).rejects.toThrow("error: No API key found for openrouter.");
  });

  it("refuses a thread with nothing in it, and a forbidden credential, before spawning", async () => {
    const { ctx, log, omp } = setup();
    await expect(buildHandoffBrief({ omp, ctx, files, events: [] })).rejects.toThrow(/nothing to hand off/);
    const billed = setup({ ANTHROPIC_API_KEY: "sk-ant-x" });
    await expect(buildHandoffBrief({ omp: billed.omp, ctx: billed.ctx, files, events })).rejects.toThrow(/ANTHROPIC_API_KEY/);
    expect(() => readFileSync(log, "utf8")).toThrow();
    expect(() => readFileSync(billed.log, "utf8")).toThrow();
  });
});
