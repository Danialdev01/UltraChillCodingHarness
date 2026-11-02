import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ProcessHost } from "@ucch/providers";
import { afterEach, describe, expect, it } from "vitest";
import { watched } from "../test-host.js";
import type { CallContext } from "../call.js";
import { readBridgeConfig } from "../config.js";
import { BRIDGE_TOOLS } from "./index.js";

const FAKE_OMP = join(import.meta.dirname, "../../../../scripts/load/fake-omp.mjs");
const FIXTURES = join(import.meta.dirname, "../../../providers/src/fixtures");

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** A git checkout with one commit and one uncommitted change. */
function checkout(): string {
  const dir = mkdtempSync(join(tmpdir(), "omp-bridge-tools-"));
  dirs.push(dir);
  const git = (...args: string[]) => execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", ...args], { cwd: dir });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.ts"), "export const a = 1;\n");
  git("add", ".");
  git("commit", "-qm", "init");
  writeFileSync(join(dir, "a.ts"), "export const a = 2;\n");
  return dir;
}

function ctx(host: ProcessHost, options: { fixture?: string; env?: NodeJS.ProcessEnv; worktree?: string } = {}): CallContext {
  return {
    config: readBridgeConfig(
      { UCCH_OMP_BIN: FAKE_OMP, UCCH_BRIDGE_MAX_SECONDS: "300", UCCH_WORKTREE: options.worktree ?? import.meta.dirname, ...options.env },
      import.meta.dirname,
    ),
    host,
    parentEnv: { PATH: process.env.PATH, FAKE_OMP_FIXTURE: join(FIXTURES, options.fixture ?? "omp-plain.jsonl") },
  };
}

const byName = (name: string) => {
  const found = BRIDGE_TOOLS.find((tool) => tool.name === name);
  if (!found) throw new Error(`no tool ${name}`);
  return found;
};

/** Runs a tool on fake-omp; its argv's `--tools` and `--model`, the prompt sent, and the result. */
async function run(name: string, input: unknown, options: Parameters<typeof ctx>[1] = {}) {
  const { host, spawned } = watched();
  const result = await byName(name).run(input as never, ctx(host, options));
  const rpc = spawned.filter((s) => s.spec.argv.includes("--mode"));
  const argv = rpc[0]?.spec.argv ?? [];
  const at = (flag: string) => (argv.includes(flag) ? argv[argv.indexOf(flag) + 1] : undefined);
  const prompt = rpc[0]?.written.find((frame) => frame.type === "prompt")?.message as string | undefined;
  return {
    result,
    text: (result.content as { text: string }[])[0]?.text ?? "",
    started: rpc.length,
    argv,
    tools: argv.includes("--no-tools") ? [] : (at("--tools")?.split(",") ?? null),
    model: at("--model"),
    lsp: !argv.includes("--no-lsp"),
    prompt: prompt ?? "",
  };
}

/** The result format of §10.2: the answer, a blank line, then fake-omp's cost line. */
const FORMATTED = /\n\nomp: 1\.2k in \/ 80 out · \$0\.0012 · \d+ s$/;

describe("each bridge tool's row (solution §10.2)", () => {
  it("omp_task: a bundled agent, read-only unless sonic; scout searches the web only with a key", async () => {
    const scout = await run("omp_task", { agent: "scout", assignment: "Map src/.", files: ["src/a.ts"] });
    expect(scout.tools).toEqual(["read", "grep", "glob", "lsp", "task"]);
    expect(scout.model).toBe("@smol");
    expect(scout.prompt).toBe("Use the `scout` subagent: Map src/.\n\nStart from these files: `src/a.ts`.\n\nReturn the subagent's result as it gave it.");
    expect(scout.text).toMatch(FORMATTED);

    const searching = await run("omp_task", { agent: "scout", assignment: "x" }, { env: { UCCH_OMP_WEB_SEARCH: "1" } });
    expect(searching.tools).toEqual(["read", "grep", "glob", "lsp", "task", "web_search"]);
    const sonic = await run("omp_task", { agent: "sonic", assignment: "x" }, { env: { UCCH_OMP_WEB_SEARCH: "1" } });
    expect(sonic.tools).toEqual(["read", "grep", "glob", "lsp", "task", "edit", "write"]);
    for (const agent of ["reviewer", "security-reviewer"]) {
      expect((await run("omp_task", { agent, assignment: "x" })).tools).toEqual(["read", "grep", "glob", "lsp", "task"]);
    }
  });

  it("omp_task: answers with the subagent's own result", async () => {
    const { text } = await run("omp_task", { agent: "scout", assignment: "x" }, { fixture: "omp-subagent.jsonl" });
    expect(text).toMatch(/^src\/a\.ts exports `a`\.\n\nomp: /);
  });

  it("omp_review: one reviewer task over the diff git gives, read-only", async () => {
    const worktree = checkout();
    const review = await run("omp_review", { scope: "uncommitted", focus: "the constant" }, { worktree });
    expect(review.tools).toEqual(["read", "grep", "glob", "task"]);
    expect(review.model).toBe("@smol");
    expect(review.lsp).toBe(false);
    expect(review.prompt).toContain('Set `agent: "reviewer"` inside the `tasks[]` item');
    expect(review.prompt).toContain("Focus: the constant");
    expect(review.prompt).toContain("-export const a = 1;\n+export const a = 2;");
    expect(review.text).toMatch(FORMATTED);

    const commit = await run("omp_review", { scope: "commit" }, { worktree });
    expect(commit.prompt).toContain("+export const a = 1;");
  });

  it("omp_review: says why there is nothing to review, without starting omp", async () => {
    const worktree = checkout();
    const branch = await run("omp_review", { scope: "branch" }, { worktree });
    expect(branch).toMatchObject({ started: 0, text: "this branch has no upstream: name the base branch in `ref`" });
    expect(branch.result.isError).toBe(true);
    const option = await run("omp_review", { scope: "commit", ref: "--output=/tmp/x" }, { worktree });
    expect(option).toMatchObject({ started: 0, text: "not a ref: --output=/tmp/x" });
    const clean = await run("omp_review", { scope: "branch", ref: "main" }, { worktree });
    expect(clean).toMatchObject({ started: 0, text: "there are no changes to review (the changes on this branch since it left `main`)" });
  });

  it("omp_symbols: the lsp tool alone, with its own action names", async () => {
    const refs = await run("omp_symbols", { op: "references", symbol: "a", file: "a.ts", line: 1 });
    expect(refs.tools).toEqual(["lsp", "read"]);
    expect(refs.lsp).toBe(true);
    expect(refs.prompt).toMatch(/^Using the lsp tool only, run its `references` action of `a` in `a.ts` at line 1\./);
    expect((await run("omp_symbols", { op: "implementations", symbol: "a" })).prompt).toContain("`implementation` action");
    expect((await run("omp_symbols", { op: "type", symbol: "a" })).prompt).toContain("`type_definition` action");
    expect((await run("omp_symbols", { op: "diagnostics", file: "src/**/*.ts" })).prompt).toContain("`diagnostics` action for `src/**/*.ts`");
    expect(refs.text).toMatch(FORMATTED);
  });

  it("omp_symbols: a lookup without a symbol is refused before omp starts", async () => {
    const missing = await run("omp_symbols", { op: "definition" });
    expect(missing).toMatchObject({ started: 0, text: "definition needs a symbol" });
  });

  it("omp_rename: a preview gets no write tool; apply adds edit and write", async () => {
    const worktree = checkout();
    const before = readFileSync(join(worktree, "a.ts"), "utf8");
    const preview = await run("omp_rename", { symbol: "a", file: "a.ts", newName: "b", apply: false }, { worktree });
    expect(preview.tools).toEqual(["lsp", "read"]);
    expect(preview.prompt).toContain("with `apply: false`");
    expect(preview.text).toMatch(FORMATTED);
    expect(readFileSync(join(worktree, "a.ts"), "utf8")).toBe(before);

    const apply = await run("omp_rename", { symbol: "a", file: "a.ts", line: 1, newName: "b", apply: true }, { worktree });
    expect(apply.tools).toEqual(["lsp", "read", "edit", "write"]);
    expect(apply.prompt).toContain("applying it");
  });

  it("omp_codemod: ast_edit without ast_grep; a preview has no write tool and stops at the proposal", async () => {
    const preview = await run("omp_codemod", { description: "rename oldName", pattern: "oldName($$$A)", rewrite: "newName($$$A)", apply: false }, {
      fixture: "omp-bridge-codemod.jsonl",
    });
    expect(preview.tools).toEqual(["ast_edit", "read"]);
    expect(preview.model).toBe("@smol");
    expect(preview.result.isError).toBeUndefined();
    expect(preview.text).toContain("+2:18 newName(2)");
    // OMP's own way to apply is not the CLI's.
    expect(preview.text).not.toContain("xd://resolve");
    expect(preview.text).toContain("Not applied: call omp_codemod again with `apply: true`");

    const apply = await run("omp_codemod", { description: "rename oldName", apply: true });
    expect(apply.tools).toEqual(["ast_edit", "read", "write"]);
    expect(apply.prompt).toContain("writing a one-sentence reason to `xd://resolve`");
  });

  it("omp_debug: the debugger on the default model, findings only", async () => {
    const debug = await run("omp_debug", {
      goal: "why total is NaN",
      program: "scripts/sum.js",
      args: ["--n", "3"],
      breakpoints: [{ file: "scripts/sum.js", line: 4, condition: "i === 2" }],
    });
    expect(debug.tools).toEqual(["debug", "read", "bash", "grep"]);
    expect(debug.model).toBe("@default");
    expect(debug.prompt).toBe(
      [
        "Using the debug tool, investigate: why total is NaN",
        'Launch `scripts/sum.js` with arguments ["--n","3"].',
        "Break at `scripts/sum.js:4` when `i === 2`.",
        "Report what you observed -- the state at each stop that matters -- and the likely cause. Do not change any file, and terminate the debug session before you answer.",
      ].join("\n"),
    );
    expect(debug.text).toMatch(FORMATTED);
  });

  it("omp_recall / omp_retain: the memory tool alone, on @smol (18.14.1 has no tiny role)", async () => {
    const env = { UCCH_OMP_MEMORY: "1" };
    const recall = await run("omp_recall", { query: "package manager" }, { env });
    expect(recall.tools).toEqual(["recall"]);
    expect(recall.model).toBe("@smol");
    expect(recall.text).toMatch(FORMATTED);
    const retain = await run("omp_retain", { fact: "Use pnpm, never npm.", kind: "convention" }, { env });
    expect(retain.tools).toEqual(["retain"]);
    expect(retain.prompt).toContain("store this convention with project scope");
  });

  it("omp_recall / omp_retain: memory off is said plainly, without starting omp", async () => {
    for (const [name, input] of [
      ["omp_recall", { query: "x" }],
      ["omp_retain", { fact: "x" }],
    ] as const) {
      const off = await run(name, input);
      expect(off).toMatchObject({ started: 0, text: "OMP memory is off for this workspace, so there is nothing to recall or retain" });
      expect(off.result.isError).toBe(true);
    }
  });

  it("omp_handoff_brief: no tools, the CLI's own account as the session", async () => {
    const brief = await run("omp_handoff_brief", { transcript: "Fixed the parser; tests pending.", focus: "the tests" });
    expect(brief.tools).toEqual([]);
    expect(brief.model).toBe("@smol");
    expect(brief.prompt).toContain("Focus on: the tests\n\n<session>\nFixed the parser; tests pending.\n</session>");
    expect(brief.text).toMatch(FORMATTED);
  });
});

describe("apply: false", () => {
  const WRITES = new Set(["write", "edit"]);

  it("never passes a tool that writes files", async () => {
    const worktree = checkout();
    for (const [name, input] of [
      ["omp_rename", { symbol: "a", file: "a.ts", newName: "b", apply: false }],
      ["omp_codemod", { description: "x", apply: false }],
    ] as const) {
      const { tools } = await run(name, input, { worktree, fixture: name === "omp_codemod" ? "omp-bridge-codemod.jsonl" : undefined });
      expect(tools, name).not.toBeNull();
      expect(tools!.filter((tool) => WRITES.has(tool)), name).toEqual([]);
    }
  });

  it("nor do the tools that only read", async () => {
    for (const [name, input] of [
      ["omp_task", { agent: "scout", assignment: "x" }],
      ["omp_task", { agent: "reviewer", assignment: "x" }],
      ["omp_symbols", { op: "references", symbol: "a" }],
      ["omp_debug", { goal: "x" }],
      ["omp_handoff_brief", { transcript: "x" }],
    ] as const) {
      const { tools } = await run(name, input);
      expect(tools!.filter((tool) => WRITES.has(tool)), name).toEqual([]);
    }
  });
});
