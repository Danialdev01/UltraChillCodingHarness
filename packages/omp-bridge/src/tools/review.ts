import { z } from "zod";
import { failure, runOmpCall, type CallContext } from "../call.js";
import { git, tool } from "./tool.js";

/** The most diff a review is handed; past it the reviewer reads the files. */
const DIFF_BYTES = 200 * 1024;

/**
 * `omp_review`: OMP's bundled `reviewer` on a set of changes (solution §10.2,
 * §9).
 *
 * Not `/review`: under `--no-extensions`, which every UCCH run keeps (§0.3),
 * OMP 18.14.1 does not know the command and sends it to the model as text;
 * with extensions, it opens a "Review Mode" dialog. The prompt is OMP's own
 * headless review request, word for word, with the changes the bridge reads
 * from git in the worktree: the reviewer gets the diff without a shell.
 */
export const ompReview = tool({
  name: "omp_review",
  description: [
    "Reviews code changes with OMP's reviewer subagent and returns its findings and verdict. Changes nothing.",
    "`uncommitted`: the working tree against HEAD. `branch`: this branch since it left `ref` (default: its upstream).",
    "`commit`: one commit, `ref` (default HEAD). Use it before declaring a multi-file change done.",
  ].join(" "),
  inputSchema: {
    scope: z.enum(["uncommitted", "branch", "commit"]),
    ref: z.string().min(1).optional().describe("The base branch for `branch`, the commit for `commit`."),
    focus: z.string().optional().describe("What to look at hardest."),
  },
  annotations: { title: "OMP review", readOnlyHint: true, openWorldHint: false },
  run: async ({ scope, ref, focus }, ctx) => {
    if (ref?.startsWith("-")) return failure(`not a ref: ${ref}`);
    const changes = await changesFor(ctx, scope, ref);
    if ("error" in changes) return failure(changes.error);
    if (!changes.diff.trim()) return failure(`there are no changes to review (${changes.label})`);
    const diff = changes.diff.length > DIFF_BYTES ? `${changes.diff.slice(0, DIFF_BYTES)}\n[… diff truncated: read the files for the rest]` : changes.diff;
    const prompt = [
      "## Code Review Request",
      "",
      "Mode: headless review request.",
      "",
      `Distribution: Use \`task\` with a \`tasks\` array. Set \`agent: "reviewer"\` inside the \`tasks[]\` item (\`tasks[].agent\`), never at the top level or omitted. Create exactly **1 reviewer task** for ${changes.label}.`,
      ...(focus ? ["", `Focus: ${focus}`] : []),
      "",
      "Put the changes below in the reviewer task's assignment.",
      "",
      "```diff",
      diff,
      "```",
    ].join("\n");
    return runOmpCall(ctx, { tools: ["read", "grep", "glob", "task"], model: "@smol", prompt, answer: { subagents: true } });
  },
});

async function changesFor(
  ctx: CallContext,
  scope: "uncommitted" | "branch" | "commit",
  ref: string | undefined,
): Promise<{ diff: string; label: string } | { error: string }> {
  if (scope === "uncommitted") {
    const diff = await git(ctx, ["diff", "--no-ext-diff", "HEAD"]);
    const untracked = await git(ctx, ["ls-files", "--others", "--exclude-standard"]);
    if (diff === null || untracked === null) return { error: "the worktree is not a git repository with a commit to compare against" };
    const added = untracked.split("\n").filter(Boolean);
    const note = added.length ? `\n# Untracked files, not in the diff: read them.\n${added.map((file) => `#   ${file}`).join("\n")}\n` : "";
    return { diff: `${diff}${note}`, label: "the uncommitted changes (the working tree against HEAD)" };
  }
  if (scope === "branch") {
    const base = ref ?? (await git(ctx, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"]))?.trim();
    if (!base) return { error: "this branch has no upstream: name the base branch in `ref`" };
    const diff = await git(ctx, ["diff", "--no-ext-diff", `${base}...HEAD`]);
    if (diff === null) return { error: `could not compare with ${base}` };
    return { diff, label: `the changes on this branch since it left \`${base}\`` };
  }
  const commit = ref ?? "HEAD";
  const diff = await git(ctx, ["show", "--no-ext-diff", "--format=commit %H%n%n%B", commit, "--"]);
  if (diff === null) return { error: `no such commit: ${commit}` };
  return { diff, label: `commit \`${commit}\`` };
}
