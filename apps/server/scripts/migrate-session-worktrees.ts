/**
 * Moves sessions whose worktree belongs to the wrong repository into their
 * own project's repository, as a patch. Dry run unless `--apply`.
 *
 *   pnpm --filter @ucch/server exec tsx --env-file-if-exists=../../.env \
 *     scripts/migrate-session-worktrees.ts [--apply] [--out <dir>]
 *
 * Only `wrong-repo` sessions are touched (see `audit-session-worktrees.ts`
 * for how they are found). For each one:
 *
 *   1. A patch is written to `--out` (default
 *      `WORKSPACE_ROOT/.migrations/{timestamp}`): the session's commits,
 *      `git diff <base>...ucch/<hash>` in the repository it is really in,
 *      and its uncommitted edits, `git diff HEAD`. Untracked files are
 *      copied beside it. This is all a dry run does.
 *   2. With `--apply`: the misplaced worktree is *moved aside* with
 *      `git worktree move` to `<tree>.misplaced-<timestamp>` -- never
 *      deleted -- and `ucch/<hash>` is created in the project's own
 *      repository from the session's base, as a worktree at the session's
 *      usual path, with the patch applied (`git apply --index --3way`) and
 *      the untracked files copied in. Nothing is committed: the session
 *      opens with the moved changes staged, for a person to look at.
 *   3. `git worktree prune` in every project repository it touched.
 *
 * A session whose branch already exists in the right repository, or whose
 * patch does not apply, is reported and left exactly as it was.
 */
import { parseArgs } from "node:util";
import { cp, mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { createDatabase, projects, threads } from "@ucch/db";
import { runGit } from "../src/git-exec.js";
import { ProjectGit } from "../src/project-git.js";
import { projectRoot, sessionTree, treeHashOf } from "../src/trees.js";

const { values: args } = parseArgs({
  options: { apply: { type: "boolean", default: false }, out: { type: "string" } },
});

const fail = (message: string): never => {
  console.error(`migrate-session-worktrees: ${message}`);
  process.exit(2);
};
const databaseUrl = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set");
const workspaceRoot = process.env.WORKSPACE_ROOT ?? fail("WORKSPACE_ROOT is not set");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outDir = resolve(args.out ?? join(workspaceRoot, ".migrations", stamp));

const exists = (path: string) => stat(path).then(() => true, () => false);
const git = (cwd: string, argv: string[]) => runGit(["-C", cwd, "-c", "core.hooksPath=/dev/null", ...argv], cwd, 60_000);
const tryGit = (cwd: string, argv: string[]) => git(cwd, argv).then((o) => o.trim(), () => null);

const projectGit = new ProjectGit(workspaceRoot);
const db = createDatabase(databaseUrl, { max: 1 });
const rows = await db
  .select({
    hash: threads.hash,
    title: threads.title,
    branch: threads.branch,
    baseBranch: threads.baseBranch,
    worktreeState: threads.worktreeState,
    treeHash: threads.treeHash,
    projectId: projects.id,
    projectName: projects.name,
    projectBase: projects.defaultBranch,
  })
  .from(threads)
  .innerJoin(projects, eq(projects.id, threads.projectId))
  .where(isNotNull(threads.branch));
await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

const touched = new Set<string>();
let misplaced = 0;
let moved = 0;
let skipped = 0;

for (const row of rows) {
  if (row.worktreeState === "settled") continue;
  const repo = projectRoot(workspaceRoot, row.projectId);
  const tree = sessionTree(workspaceRoot, row.projectId, treeHashOf(row));
  if (!(await exists(tree)) || !(await exists(repo))) continue;
  const common = await tryGit(tree, ["rev-parse", "--git-common-dir"]);
  if (!common) continue;
  const actualGitDir = resolve(tree, common);
  if (actualGitDir === resolve(repo, ".git")) continue;

  misplaced++;
  const branch = row.branch!;
  const base = row.baseBranch ?? row.projectBase;
  const label = `${row.projectName} ${branch} (${row.title})`;
  console.log(`\n${label}\n  is a worktree of ${actualGitDir}, not ${resolve(repo, ".git")}`);

  // 1. The patch: the session's commits since its base, then its uncommitted edits.
  const committed = (await tryGit(tree, ["diff", "--binary", `${base}...${branch}`])) ?? "";
  const uncommitted = (await tryGit(tree, ["diff", "--binary", "HEAD"])) ?? "";
  const untracked = ((await tryGit(tree, ["ls-files", "--others", "--exclude-standard", "-z"])) ?? "")
    .split("\0")
    .filter(Boolean);
  const dir = join(outDir, `${row.projectId}-${row.hash}`);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, "committed.patch"), committed ? `${committed}\n` : "");
  await writeFile(join(dir, "uncommitted.patch"), uncommitted ? `${uncommitted}\n` : "");
  for (const path of untracked) {
    await mkdir(dirname(join(dir, "untracked", path)), { recursive: true });
    await cp(join(tree, path), join(dir, "untracked", path));
  }
  console.log(`  patch written to ${dir} (${untracked.length} untracked file${untracked.length === 1 ? "" : "s"})`);

  if (!args.apply) continue;

  // 2. Into the right repository, the misplaced one moved aside, not deleted.
  if (await projectGit.branchExists(row.projectId, branch)) {
    console.log(`  SKIPPED: ${branch} already exists in the project's repository; resolve by hand`);
    skipped++;
    continue;
  }
  if (!(await projectGit.branchExists(row.projectId, base))) {
    console.log(`  SKIPPED: the base ${base} does not exist in the project's repository`);
    skipped++;
    continue;
  }
  const aside = `${tree}.misplaced-${stamp}`;
  try {
    await git(tree, ["worktree", "move", tree, aside]);
  } catch (error) {
    console.log(`  SKIPPED: could not move the misplaced worktree aside: ${String(error)}`);
    skipped++;
    continue;
  }
  console.log(`  moved the misplaced worktree to ${aside}`);
  try {
    await projectGit.addWorktree(row.projectId, treeHashOf(row), branch, base);
    for (const patch of ["committed.patch", "uncommitted.patch"]) {
      const file = join(dir, patch);
      if ((await stat(file)).size > 0) await git(tree, ["apply", "--index", "--3way", file]);
    }
    if (untracked.length) await cp(join(dir, "untracked"), tree, { recursive: true });
    touched.add(row.projectId);
    moved++;
    console.log(`  recreated as ${branch} in ${repo}, changes staged at ${tree}`);
  } catch (error) {
    console.log(`  FAILED to recreate: ${String(error)}`);
    console.log(`  the original is untouched at ${aside}; the patch is in ${dir}`);
    skipped++;
  }
}

// 3. Every repository touched forgets the worktrees that are gone.
for (const projectId of touched) await projectGit.prune(projectId);

console.log(
  `\n${misplaced} misplaced session${misplaced === 1 ? "" : "s"}` +
    (args.apply ? `: ${moved} moved, ${skipped} skipped` : ` (dry run; --apply to move them)`),
);
