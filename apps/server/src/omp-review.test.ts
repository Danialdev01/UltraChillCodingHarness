import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { ReviewFinding, type DomainEvent } from "@ucch/protocol";
import { HostProcessHost, OmpProvider, type OmpCallResult, type OmpStructuredResult } from "@ucch/providers";
import { runGit } from "./git-exec.js";
import {
  DIFF_BYTES,
  excludedFromReview,
  parseReview,
  relativeFile,
  REVIEW_TOOLS,
  reviewChanges,
  reviewPrompt,
  runReview,
  splitDiff,
  withoutExcluded,
  type ReviewGit,
} from "./omp-review.js";

const PROJECT = "00000000-0000-4000-8000-000000000004";
const TURN = "00000000-0000-4000-8000-000000000003";
const FAKE_OMP = join(import.meta.dirname, "../../../scripts/load/fake-omp.mjs");
const REVIEW_FIXTURE = join(import.meta.dirname, "../../../packages/providers/src/fixtures/omp-review.jsonl");

/** A repository with one commit, then the planted bug and a lock file left uncommitted. */
function repo(): { tree: string; git: ReviewGit; sh(...argv: string[]): string } {
  const tree = mkdtempSync(join(tmpdir(), "omp-review-"));
  const sh = (...argv: string[]) =>
    execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "init.defaultBranch=main", ...argv], { cwd: tree, encoding: "utf8" });
  const write = (path: string, text: string) => {
    mkdirSync(dirname(join(tree, path)), { recursive: true });
    writeFileSync(join(tree, path), text);
  };
  sh("init", "-q");
  write("math.ts", "export const add = (a: number, b: number) => a + b;\nexport const div = (a: number, b: number) => a / b;\n");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\n");
  sh("add", "-A");
  sh("commit", "-qm", "first");
  // The planted bug: `div` multiplies. Line 2 of math.ts.
  write("math.ts", "export const add = (a: number, b: number) => a + b;\nexport const div = (a: number, b: number) => a * b;\n");
  write("pnpm-lock.yaml", "lockfileVersion: '9.0'\npackages: {}\n");
  write("dist/math.js", "export const div = (a, b) => a * b;\n");
  write("notes.md", "Division is fixed.\n");
  const git: ReviewGit = async (argv, ok) => {
    try {
      return await runGit(argv, tree, 10_000, { read: true, ...(ok ? { okExitCodes: ok } : {}) });
    } catch {
      return null;
    }
  };
  return { tree, git, sh };
}

describe("what a review leaves out", () => {
  it("drops lock files, minified, generated and snapshot files, maps, and build or vendored dirs, as OMP does", () => {
    for (const path of ["pnpm-lock.yaml", "web/package-lock.json", "yarn.lock", "Cargo.lock", "a/b/flake.lock", "x.lock", "app.min.js", "s.min.css", "api.generated.ts", "__snapshots__/a.test.ts.snap", "a.js.map", "dist/a.js", "pkg/build/x.js", "out/y", "node_modules/z/index.js", "vendor/lib.go"]) {
      expect([path, excludedFromReview(path)]).toEqual([path, true]);
    }
    for (const path of ["math.ts", "src/lock.ts", "builder.ts", "distance/a.ts", "docs/output.md", "Cargo.toml"]) {
      expect([path, excludedFromReview(path)]).toEqual([path, false]);
    }
  });

  it("cuts a diff at its file headers and keeps what is reviewed", () => {
    const diff = [
      "commit abc\n\nmsg\n",
      "diff --git a/math.ts b/math.ts\n--- a/math.ts\n+++ b/math.ts\n@@ -1 +1 @@\n-a\n+b\n",
      "diff --git a/pnpm-lock.yaml b/pnpm-lock.yaml\n--- a/pnpm-lock.yaml\n+++ b/pnpm-lock.yaml\n@@ -1 +1 @@\n-x\n+y\n",
      "diff --git a/gone.ts b/gone.ts\ndeleted file mode 100644\n--- a/gone.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-z\n",
    ].join("");
    expect(splitDiff(diff).map((s) => s.path)).toEqual(["", "math.ts", "pnpm-lock.yaml", "gone.ts"]);
    const kept = withoutExcluded(diff);
    expect(kept.excluded).toEqual(["pnpm-lock.yaml"]);
    expect(kept.diff).toContain("+++ b/math.ts");
    expect(kept.diff).toContain("gone.ts");
    expect(kept.diff).not.toContain("pnpm-lock");
  });
});

describe("reviewChanges", () => {
  it("uncommitted: the working tree against HEAD, untracked files as additions, excluded files listed", async () => {
    const { git } = repo();
    const changes = await reviewChanges(git, { scope: "uncommitted", ref: null, base: null });
    if ("error" in changes) throw new Error(changes.error);
    expect(changes.diff).toContain("+export const div = (a: number, b: number) => a * b;");
    expect(changes.diff).toContain("+++ b/notes.md");
    expect(changes.diff).not.toContain("lockfileVersion");
    expect(changes.diff).not.toContain("dist/math.js");
    expect(changes.excluded.sort()).toEqual(["dist/math.js", "pnpm-lock.yaml"]);
    expect(changes.label).toMatch(/uncommitted/);
  });

  it("branch: HEAD since it left the base; commit: one commit", async () => {
    const { git, sh } = repo();
    sh("checkout", "-qb", "feature");
    sh("add", "-A");
    sh("commit", "-qm", "divide wrongly");
    const branch = await reviewChanges(git, { scope: "branch", ref: null, base: "main" });
    if ("error" in branch) throw new Error(branch.error);
    expect(branch.diff).toContain("+export const div = (a: number, b: number) => a * b;");
    expect(branch.excluded.sort()).toEqual(["dist/math.js", "pnpm-lock.yaml"]);
    expect(branch.label).toContain("`main`");
    const commit = await reviewChanges(git, { scope: "commit", ref: null, base: null });
    if ("error" in commit) throw new Error(commit.error);
    expect(commit.diff).toMatch(/^commit [0-9a-f]{40}\n\ndivide wrongly/);
    expect(commit.label).toBe("commit `HEAD`");
  });

  it("says why there is nothing to review", async () => {
    const { git, sh } = repo();
    sh("add", "-A");
    sh("commit", "-qm", "all");
    expect(await reviewChanges(git, { scope: "uncommitted", ref: null, base: null })).toEqual({
      error: "there are no changes to review (the uncommitted changes (the working tree against HEAD))",
    });
    expect(await reviewChanges(git, { scope: "branch", ref: null, base: null })).toEqual({ error: "there is no base branch to compare with: name one" });
    expect(await reviewChanges(git, { scope: "commit", ref: "nope", base: null })).toEqual({ error: "no such commit: nope" });
    expect(await reviewChanges(git, { scope: "commit", ref: "--output=/tmp/x", base: null })).toEqual({ error: "not a ref: --output=/tmp/x" });
  });

  it("refuses a change made only of excluded files", async () => {
    const { tree, git, sh } = repo();
    sh("checkout", "--", "math.ts");
    execFileSync("rm", ["-r", join(tree, "dist"), join(tree, "notes.md")]);
    expect(await reviewChanges(git, { scope: "uncommitted", ref: null, base: null })).toEqual({
      error: "the only changes are in files a review leaves out (pnpm-lock.yaml)",
    });
  });
});

describe("reviewPrompt", () => {
  it("is OMP's headless request with the diff, the focus and what was left out", () => {
    const prompt = reviewPrompt({ diff: "diff --git a/x b/x\n", label: "commit `HEAD`", excluded: ["pnpm-lock.yaml"] }, "error handling");
    expect(prompt).toContain('Set `agent: "reviewer"` inside the `tasks[]` item');
    expect(prompt).toContain("Create exactly **1 reviewer task** for commit `HEAD`.");
    expect(prompt).toContain("Focus: error handling");
    expect(prompt).toContain("Excluded from the diff (lock files, generated or vendored code): pnpm-lock.yaml");
    expect(prompt).toContain("```diff\ndiff --git a/x b/x\n\n```");
  });

  it("truncates a diff past its limit", () => {
    const prompt = reviewPrompt({ diff: `diff --git a/x b/x\n${"+".repeat(DIFF_BYTES * 2)}`, label: "l", excluded: [] });
    expect(prompt).toContain("[… diff truncated: read the files for the rest]");
    expect(Buffer.byteLength(prompt)).toBeLessThan(DIFF_BYTES + 2_000);
  });
});

describe("parseReview", () => {
  const data = {
    overall_correctness: "incorrect",
    explanation: "div multiplies.",
    confidence: 0.9,
    findings: [
      { title: "nit", body: "style", priority: 3, confidence: 0.4, file_path: "./math.ts", line_start: 1, line_end: 1 },
      { title: "div multiplies", body: "`a * b`", priority: 0, confidence: 0.95, file_path: "/w/tree/math.ts", line_start: 2, line_end: 2 },
      { title: "no lines", body: "", priority: "P1", confidence: 7, file_path: "b/x.ts" },
      { title: "bad priority", body: "", priority: 9, confidence: 0.5, file_path: "x.ts", line_start: 1 },
      "not a finding",
    ],
  };
  const structured = (over: Partial<OmpStructuredResult> = {}): OmpStructuredResult => ({ id: "R", agent: "R", status: "completed", schemaStatus: "valid", data, ...over });

  it("reads the reviewer's structured result into findings and a verdict", () => {
    const parsed = parseReview({ structured: [structured()], events: [] }, "/w/tree");
    expect(parsed?.verdict).toEqual({ verdict: "incorrect", explanation: "div multiplies.", confidence: 0.9 });
    expect(parsed?.findings).toEqual([
      { priority: "P0", confidence: 0.95, title: "div multiplies", body: "`a * b`", file: "math.ts", startLine: 2, endLine: 2 },
      { priority: "P1", confidence: 1, title: "no lines", body: "", file: "x.ts", startLine: 0, endLine: 0 },
      { priority: "P3", confidence: 0.4, title: "nit", body: "style", file: "math.ts", startLine: 1, endLine: 1 },
    ]);
    for (const finding of parsed!.findings) ReviewFinding.parse(finding);
  });

  it("prefers a schema-valid result, then falls back to the JSON in a subagent's output", () => {
    const correct = { ...data, overall_correctness: "correct", findings: [] };
    expect(parseReview({ structured: [structured({ schemaStatus: "invalid", data: correct }), structured()], events: [] }, "/")?.verdict.verdict).toBe("incorrect");
    const finished: DomainEvent = {
      type: "agent.subagent_finished",
      threadId: PROJECT,
      turnId: TURN,
      subagentId: "R",
      status: "completed",
      result: `Here it is:\n\`\`\`json\n${JSON.stringify(correct)}\n\`\`\``,
    };
    expect(parseReview({ structured: [], events: [finished] }, "/")).toEqual({
      verdict: { verdict: "correct", explanation: "div multiplies.", confidence: 0.9 },
      findings: [],
    });
    expect(parseReview({ structured: [structured({ data: { overall_correctness: "maybe" } })], events: [] }, "/")).toBeNull();
  });

  it("makes a finding's file relative to the tree", () => {
    expect(relativeFile("/w/t/src/a.ts", "/w/t")).toBe("src/a.ts");
    expect(relativeFile("a/src/a.ts", "/w/t")).toBe("src/a.ts");
    expect(relativeFile("./src/a.ts", "/w/t/")).toBe("src/a.ts");
  });
});

describe("runReview", () => {
  it("against fake-omp replaying the reviewer: a P0 on the planted bug's file and line, the lock file left out", async () => {
    const { tree, git } = repo();
    const omp = new OmpProvider(FAKE_OMP);
    const ctx = { cwd: tree, env: { PATH: process.env.PATH ?? "/usr/bin", OPENROUTER_API_KEY: "sk-or-test", FAKE_OMP_FIXTURE: REVIEW_FIXTURE }, host: new HostProcessHost() };
    const prompts: string[] = [];
    const outcome = await runReview({
      tree,
      git,
      scope: "uncommitted",
      ref: null,
      base: null,
      focus: "arithmetic",
      call: (input) => {
        prompts.push(input.prompt);
        expect(input.tools).toEqual(REVIEW_TOOLS);
        return omp.call({ ctx, omp: { overlayPath: "/c/r.yml", guardHookPath: "/c/g.ts" }, projectId: PROJECT, callId: TURN, model: "openai/gpt-5", ...input });
      },
    });
    expect(outcome.verdict.verdict).toBe("incorrect");
    const serious = outcome.findings.filter((f) => f.priority === "P0" || f.priority === "P1");
    expect(serious).toEqual([expect.objectContaining({ file: "math.ts", startLine: 2, endLine: 2 })]);
    expect(outcome.excluded.sort()).toEqual(["dist/math.js", "pnpm-lock.yaml"]);
    expect(prompts[0]).toContain("Focus: arithmetic");
    expect(prompts[0]).not.toContain("lockfileVersion");
    expect(outcome.costUsd).toBeGreaterThanOrEqual(0);
  });

  it("says when OMP gave no verdict, and does not run OMP when there is nothing to review", async () => {
    const { git, sh } = repo();
    const silent = async (): Promise<OmpCallResult> => ({ events: [], structured: [], usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 0 });
    await expect(runReview({ tree: "/", git, scope: "uncommitted", ref: null, base: null, call: silent })).rejects.toThrow("OMP did not start a reviewer for these changes");
    sh("add", "-A");
    sh("commit", "-qm", "all");
    let called = false;
    await expect(
      runReview({ tree: "/", git, scope: "uncommitted", ref: null, base: null, call: async () => ((called = true), silent()) }),
    ).rejects.toThrow(/no changes to review/);
    expect(called).toBe(false);
  });
});
