import { z } from "zod";
import type { DomainEvent, ReviewFinding, ReviewScope, ReviewVerdict } from "@ucch/protocol";
import type { OmpCallInput, OmpCallResult, OmpStructuredResult } from "@ucch/providers";

/**
 * The review engine (solution §9, OM7.7): a set of changes, read from git
 * in the tree under review, handed to OMP's bundled `reviewer`, and its
 * verdict read back as data.
 *
 * Not `/review`: under `--no-extensions`, which every UCCH run keeps
 * (§0.3), OMP 18.14.1 does not expand the command and the model gets it as
 * text (OM6.2). The prompt is the headless request `/review` expands to,
 * as the bridge's `omp_review` sends it, with the diff in it: the reviewer
 * gets the changes without a shell.
 *
 * The verdict is the reviewer's `yield`, which it has only under the
 * overlay's `task.structured: true` (the `review` preset). OMP checks it
 * against the agent's schema and reports it in the `async-result` that
 * ends the background job (`ompStructuredResults`); the `<output>` of the
 * same report is the fallback, for a run whose structured result was not
 * marked valid.
 */

/** The most diff a review is handed; past it the reviewer reads the files. */
export const DIFF_BYTES = 200 * 1024;

/** Untracked files shown as additions, at most; the rest are listed. */
const UNTRACKED_FILES = 50;

/** The main agent's tools: read the code, and hand the diff to the reviewer. */
export const REVIEW_TOOLS = ["read", "grep", "glob", "task"] as const;

/** How long a review may take, `--max-time`: the reviewer is OMP's slowest role. */
export const REVIEW_MAX_TIME = "15m";

/**
 * What OMP's own `/review` leaves out of a diff (18.14.1): lock files,
 * minified, generated and snapshot files, source maps, and build output or
 * vendored code anywhere in the tree.
 */
const LOCK_FILES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "Cargo.lock",
  "Gemfile.lock",
  "poetry.lock",
  "composer.lock",
  "flake.lock",
]);
const EXCLUDED_DIRS = new Set(["dist", "build", "out", "node_modules", "vendor"]);

export function excludedFromReview(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  if (LOCK_FILES.has(name) || name.endsWith(".lock")) return true;
  if (/\.min\.(js|css)$/.test(name) || name.includes(".generated.") || name.endsWith(".snap") || name.endsWith(".map")) return true;
  return parts.slice(0, -1).some((dir) => EXCLUDED_DIRS.has(dir));
}

/** One file's part of a unified diff. */
export interface DiffSection {
  path: string;
  text: string;
}

/**
 * A unified diff cut at its `diff --git` headers. The path is the new side's
 * (`b/…`); a deletion's is the old side's. Anything before the first header
 * (a commit's message, from `git show`) is a section with an empty path.
 */
export function splitDiff(diff: string): DiffSection[] {
  const sections: DiffSection[] = [];
  const starts = [...diff.matchAll(/^diff --git /gm)].map((match) => match.index);
  if (starts.length === 0) return diff ? [{ path: "", text: diff }] : [];
  if (starts[0]! > 0) sections.push({ path: "", text: diff.slice(0, starts[0]) });
  for (const [i, start] of starts.entries()) {
    const text = diff.slice(start, starts[i + 1] ?? diff.length);
    sections.push({ path: sectionPath(text), text });
  }
  return sections;
}

function sectionPath(text: string): string {
  const plus = /^\+\+\+ b\/(.+)$/m.exec(text)?.[1];
  if (plus) return plus;
  const minus = /^--- a\/(.+)$/m.exec(text)?.[1];
  if (minus) return minus;
  // A rename with no content change, a mode change, a binary file.
  const renamed = /^rename to (.+)$/m.exec(text)?.[1];
  if (renamed) return renamed;
  return /^diff --git a\/.+ b\/(.+)$/m.exec(text)?.[1] ?? "";
}

/** The diff without OMP's excluded files, and which those were. */
export function withoutExcluded(diff: string): { diff: string; excluded: string[] } {
  const kept: string[] = [];
  const excluded: string[] = [];
  for (const section of splitDiff(diff)) {
    if (section.path && excludedFromReview(section.path)) excluded.push(section.path);
    else kept.push(section.text);
  }
  return { diff: kept.join(""), excluded: [...new Set(excluded)] };
}

/** Runs git in the tree under review: its stdout, or null when git fails. */
export type ReviewGit = (argv: string[], okExitCodes?: readonly number[]) => Promise<string | null>;

export interface ReviewChanges {
  diff: string;
  /** What is reviewed, in words, for the prompt. */
  label: string;
  excluded: string[];
}

/**
 * The changes a review is of (§9.1).
 *
 * - `uncommitted`: the working tree against HEAD, untracked files shown as
 *   additions.
 * - `branch`: HEAD since it left `ref`, or `base` (the session's base
 *   branch, else the project's default branch).
 * - `commit`: the commit `ref`, HEAD when absent.
 */
export async function reviewChanges(
  git: ReviewGit,
  input: { scope: ReviewScope; ref: string | null; base: string | null },
): Promise<ReviewChanges | { error: string }> {
  if (input.ref?.startsWith("-")) return { error: `not a ref: ${input.ref}` };
  let raw: string;
  let label: string;
  if (input.scope === "uncommitted") {
    const diff = await git(["diff", "--no-ext-diff", "--no-color", "HEAD"]);
    const untracked = await git(["ls-files", "--others", "--exclude-standard", "-z"]);
    if (diff === null || untracked === null) return { error: "the tree is not a git repository with a commit to compare against" };
    const added = untracked.split("\0").filter(Boolean);
    const shown: string[] = [];
    for (const file of added.filter((path) => !excludedFromReview(path)).slice(0, UNTRACKED_FILES)) {
      // A new file as git would show it once added: exit 1 means "differs".
      const text = await git(["diff", "--no-ext-diff", "--no-color", "--no-index", "--", "/dev/null", file], [0, 1]);
      if (text) shown.push(text);
    }
    const unshown = added.filter((path) => !excludedFromReview(path)).slice(UNTRACKED_FILES);
    const note = unshown.length ? `\n# More untracked files, not in the diff: read them.\n${unshown.map((file) => `#   ${file}`).join("\n")}\n` : "";
    raw = `${diff}${shown.join("")}${note}`;
    // Untracked files OMP would leave out are left out here as well.
    const excludedUntracked = added.filter(excludedFromReview);
    const split = withoutExcluded(raw);
    return finish(split.diff, "the uncommitted changes (the working tree against HEAD)", [...split.excluded, ...excludedUntracked]);
  }
  if (input.scope === "branch") {
    const base = input.ref ?? input.base;
    if (!base) return { error: "there is no base branch to compare with: name one" };
    const diff = await git(["diff", "--no-ext-diff", "--no-color", `${base}...HEAD`, "--"]);
    if (diff === null) return { error: `could not compare with ${base}` };
    raw = diff;
    label = `the changes on this branch since it left \`${base}\``;
  } else {
    const commit = input.ref ?? "HEAD";
    const diff = await git(["show", "--no-ext-diff", "--no-color", "--format=commit %H%n%n%B", commit, "--"]);
    if (diff === null) return { error: `no such commit: ${commit}` };
    raw = diff;
    label = `commit \`${commit}\``;
  }
  const split = withoutExcluded(raw);
  return finish(split.diff, label, split.excluded);
}

function finish(diff: string, label: string, excluded: string[]): ReviewChanges | { error: string } {
  // A commit's message alone, or nothing at all, is nothing to review.
  if (!splitDiff(diff).some((section) => section.path)) {
    return { error: excluded.length ? `the only changes are in files a review leaves out (${excluded.join(", ")})` : `there are no changes to review (${label})` };
  }
  return { diff, label, excluded: [...new Set(excluded)] };
}

/** OMP's headless review request (what `/review` expands to), with the diff. */
export function reviewPrompt(changes: Pick<ReviewChanges, "diff" | "label" | "excluded">, focus?: string): string {
  const diff = Buffer.byteLength(changes.diff) > DIFF_BYTES ? `${truncate(changes.diff, DIFF_BYTES)}\n[… diff truncated: read the files for the rest]` : changes.diff;
  return [
    "## Code Review Request",
    "",
    "Mode: headless review request.",
    "",
    `Distribution: Use \`task\` with a \`tasks\` array. Set \`agent: "reviewer"\` inside the \`tasks[]\` item (\`tasks[].agent\`), never at the top level or omitted. Create exactly **1 reviewer task** for ${changes.label}.`,
    ...(focus ? ["", `Focus: ${focus}`] : []),
    ...(changes.excluded.length ? ["", `Excluded from the diff (lock files, generated or vendored code): ${changes.excluded.join(", ")}`] : []),
    "",
    "Put the changes below in the reviewer task's assignment. File paths are relative to the repository root; line numbers are the new file's.",
    "",
    "```diff",
    diff,
    "```",
  ].join("\n");
}

function truncate(text: string, bytes: number): string {
  let cut = Buffer.from(text, "utf8").subarray(0, bytes).toString("utf8");
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return cut;
}

// -- The reviewer's answer -----------------------------------------------------

/** The bundled `reviewer`'s output schema (18.14.1), as loosely as it can come. */
const RawFinding = z.object({
  title: z.string(),
  body: z.string().default(""),
  priority: z.union([z.number(), z.string()]),
  confidence: z.number().default(0.5),
  file_path: z.string(),
  line_start: z.number().int().nonnegative().optional(),
  line_end: z.number().int().nonnegative().optional(),
});
const RawReview = z.object({
  overall_correctness: z.string(),
  explanation: z.string().default(""),
  confidence: z.number().default(0.5),
  findings: z.array(z.unknown()).default([]),
});

export interface ParsedReview {
  verdict: ReviewVerdict;
  findings: ReviewFinding[];
}

/**
 * The reviewer's verdict, from the run: its schema-valid structured result
 * first, then any structured result, then the JSON in a subagent's
 * `<output>`. Null when none parses. `tree` is the reviewed tree's path, cut
 * from a finding's file if the reviewer gave it absolute.
 */
export function parseReview(run: Pick<OmpCallResult, "structured" | "events">, tree: string): ParsedReview | null {
  const ranked = [...run.structured].sort((a, b) => rank(a) - rank(b));
  for (const result of ranked) {
    const parsed = reviewOf(result.data, tree);
    if (parsed) return parsed;
  }
  for (const event of [...run.events].reverse()) {
    if (event.type !== "agent.subagent_finished" || !event.result) continue;
    const parsed = reviewOf(jsonIn(event.result), tree);
    if (parsed) return parsed;
  }
  return null;
}

const rank = (result: OmpStructuredResult) => (result.schemaStatus === "valid" ? 0 : 1);

function jsonIn(text: string): unknown {
  const fenced = /```(?:json)?\s*\n([\s\S]*?)\n```/.exec(text)?.[1];
  for (const candidate of [fenced, text.trim(), text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
    if (!candidate) continue;
    try {
      return JSON.parse(candidate);
    } catch {
      // The next candidate.
    }
  }
  return null;
}

function reviewOf(data: unknown, tree: string): ParsedReview | null {
  const raw = RawReview.safeParse(data);
  if (!raw.success) return null;
  const correctness = raw.data.overall_correctness.toLowerCase();
  if (correctness !== "correct" && correctness !== "incorrect") return null;
  const findings: ReviewFinding[] = [];
  for (const item of raw.data.findings) {
    const finding = RawFinding.safeParse(item);
    if (!finding.success) continue;
    const priority = priorityOf(finding.data.priority);
    if (!priority) continue;
    const start = finding.data.line_start ?? finding.data.line_end ?? 0;
    const end = Math.max(start, finding.data.line_end ?? start);
    findings.push({
      priority,
      confidence: clamp(finding.data.confidence),
      title: finding.data.title,
      body: finding.data.body,
      file: relativeFile(finding.data.file_path, tree),
      startLine: start,
      endLine: end,
    });
  }
  findings.sort((a, b) => a.priority.localeCompare(b.priority) || b.confidence - a.confidence);
  return {
    verdict: { verdict: correctness, explanation: raw.data.explanation, confidence: clamp(raw.data.confidence) },
    findings,
  };
}

function priorityOf(value: number | string): ReviewFinding["priority"] | null {
  const n = typeof value === "number" ? value : Number(/^P?(\d)$/i.exec(value.trim())?.[1] ?? Number.NaN);
  return Number.isInteger(n) && n >= 0 && n <= 3 ? (`P${n}` as ReviewFinding["priority"]) : null;
}

const clamp = (n: number) => (Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 0.5);

/** A finding's file, relative to the tree: as the diff names it. */
export function relativeFile(path: string, tree: string): string {
  let file = path.trim();
  const root = tree.endsWith("/") ? tree : `${tree}/`;
  if (file.startsWith(root)) file = file.slice(root.length);
  return file.replace(/^\.\//, "").replace(/^[ab]\//, "");
}

// -- One review -----------------------------------------------------------------

export interface ReviewRunInput {
  /** The reviewed tree's path, where git and OMP run. */
  tree: string;
  git: ReviewGit;
  scope: ReviewScope;
  ref: string | null;
  /** The base branch for `branch` when `ref` is absent. */
  base: string | null;
  focus?: string;
  /** OMP, one unattended prompt (`OmpProvider.call` with the run's context bound). */
  call(input: Pick<OmpCallInput, "prompt" | "tools" | "maxTime">): Promise<OmpCallResult>;
}

export interface ReviewOutcome extends ParsedReview {
  excluded: string[];
  costUsd: number;
}

/** Reads the changes, runs the reviewer, and parses its verdict. Rejects with what to tell the person. */
export async function runReview(input: ReviewRunInput): Promise<ReviewOutcome> {
  const changes = await reviewChanges(input.git, { scope: input.scope, ref: input.ref, base: input.base });
  if ("error" in changes) throw new Error(changes.error);
  const run = await input.call({ prompt: reviewPrompt(changes, input.focus), tools: REVIEW_TOOLS, maxTime: REVIEW_MAX_TIME });
  const parsed = parseReview(run, input.tree);
  if (!parsed) throw new Error(noVerdict(run.events));
  return { ...parsed, excluded: changes.excluded, costUsd: run.costUsd };
}

function noVerdict(events: readonly DomainEvent[]): string {
  const reviewer = events.find((event) => event.type === "agent.subagent_started");
  if (!reviewer) return "OMP did not start a reviewer for these changes";
  const finished = events.find((event) => event.type === "agent.subagent_finished");
  if (finished?.type === "agent.subagent_finished" && finished.status !== "completed") {
    return `the reviewer ${finished.status}${finished.result ? `: ${finished.result.split("\n")[0]!.slice(0, 300)}` : ""}`;
  }
  return "the reviewer gave no verdict OMP could read";
}
