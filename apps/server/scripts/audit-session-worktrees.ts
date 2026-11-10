/**
 * Checks that every project session's worktree belongs to its own project's
 * repository. Reads only: the database, and git's answers about each folder.
 *
 *   pnpm --filter @ucch/server exec tsx --env-file-if-exists=../../.env \
 *     scripts/audit-session-worktrees.ts [--json]
 *
 * For each thread with a branch it compares the worktree's
 * `git rev-parse --git-common-dir` and `origin` with the project's checkout
 * (`WORKSPACE_ROOT/{projectId}`), and sorts it into:
 *
 *   ok          the worktree is a worktree of its own project's repository
 *   wrong-repo  it is a worktree of some other repository -- the case
 *               `migrate-session-worktrees.ts` repairs, after you confirm
 *   missing     the database names it, but there is no worktree on disk
 *               (seeded demo rows, a folder removed by hand, an empty
 *               folder); listed only
 *   settled     merged into the base and removed; nothing to check
 *
 * Exits 1 when anything is wrong-repo, so it can gate a deploy.
 */
import { parseArgs } from "node:util";
import { stat } from "node:fs/promises";
import { resolve } from "node:path";
import { eq, isNotNull } from "drizzle-orm";
import { createDatabase, projects, threads } from "@ucch/db";
import { runGit } from "../src/git-exec.js";
import { projectRoot, sessionTree, treeHashOf } from "../src/trees.js";

const { values: args } = parseArgs({ options: { json: { type: "boolean", default: false } } });

const fail = (message: string): never => {
  console.error(`audit-session-worktrees: ${message}`);
  process.exit(2);
};
const databaseUrl = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set");
const workspaceRoot = process.env.WORKSPACE_ROOT ?? fail("WORKSPACE_ROOT is not set");

export type AuditKind = "ok" | "wrong-repo" | "missing" | "settled";

export interface AuditRow {
  kind: AuditKind;
  projectId: string;
  projectName: string;
  threadId: string;
  hash: string;
  title: string;
  branch: string;
  baseBranch: string | null;
  tree: string;
  expectedCommonDir: string;
  commonDir: string | null;
  origin: string | null;
  expectedOrigin: string | null;
  detail: string | null;
}

const exists = (path: string) => stat(path).then(() => true, () => false);
const git = (argv: string[], cwd: string) =>
  runGit(["-C", cwd, ...argv], cwd, 20_000, { read: true }).then(
    (out) => out.trim(),
    () => null,
  );
/** A remote URL for display, with any credentials taken out. */
const clean = (url: string | null) => (url ? url.replace(/\/\/[^/@]*@/, "//") : null);

const db = createDatabase(databaseUrl, { max: 1 });
const rows = await db
  .select({
    threadId: threads.id,
    hash: threads.hash,
    title: threads.title,
    branch: threads.branch,
    baseBranch: threads.baseBranch,
    worktreeState: threads.worktreeState,
    treeHash: threads.treeHash,
    projectId: projects.id,
    projectName: projects.name,
  })
  .from(threads)
  .innerJoin(projects, eq(projects.id, threads.projectId))
  .where(isNotNull(threads.branch));

const report: AuditRow[] = [];
for (const row of rows) {
  const repo = projectRoot(workspaceRoot, row.projectId);
  const tree = sessionTree(workspaceRoot, row.projectId, treeHashOf(row));
  const expectedCommonDir = resolve(repo, ".git");
  const expectedOrigin = (await exists(repo)) ? await git(["remote", "get-url", "origin"], repo) : null;
  const base: Omit<AuditRow, "kind" | "commonDir" | "origin" | "detail"> = {
    projectId: row.projectId,
    projectName: row.projectName,
    threadId: row.threadId,
    hash: row.hash,
    title: row.title,
    branch: row.branch!,
    baseBranch: row.baseBranch,
    tree,
    expectedCommonDir,
    expectedOrigin: clean(expectedOrigin),
  };

  if (row.worktreeState === "settled") {
    report.push({ ...base, kind: "settled", commonDir: null, origin: null, detail: null });
    continue;
  }
  if (!(await exists(tree))) {
    const detail = (await exists(repo)) ? "no worktree folder" : "no worktree folder, and no project checkout";
    report.push({ ...base, kind: "missing", commonDir: null, origin: null, detail });
    continue;
  }
  const common = await git(["rev-parse", "--git-common-dir"], tree);
  const commonDir = common ? resolve(tree, common) : null;
  if (!commonDir) {
    // A folder, but no worktree in it: nothing to move anywhere.
    const detail = (await exists(repo)) ? "folder exists but is not a git worktree" : "folder is not a git worktree, and there is no project checkout";
    report.push({ ...base, kind: "missing", commonDir: null, origin: null, detail });
    continue;
  }
  const origin = await git(["remote", "get-url", "origin"], tree);
  const sameRepo = commonDir === expectedCommonDir;
  const sameOrigin = (origin ?? null) === (expectedOrigin ?? null);
  report.push({
    ...base,
    kind: sameRepo && sameOrigin ? "ok" : "wrong-repo",
    commonDir,
    origin: clean(origin),
    detail: !sameRepo ? "belongs to another repository" : !sameOrigin ? "origin differs" : null,
  });
}
await (db as unknown as { $client: { end(): Promise<void> } }).$client.end();

if (args.json) {
  console.log(JSON.stringify(report, null, 2));
} else {
  for (const kind of ["ok", "wrong-repo", "missing", "settled"] as const) {
    const group = report.filter((r) => r.kind === kind);
    console.log(`\n${kind.toUpperCase()} (${group.length})`);
    for (const r of group) {
      console.log(`  ${r.projectName.padEnd(18)} ${r.branch.padEnd(22)} ${r.title}`);
      if (r.kind === "ok" || r.kind === "wrong-repo") {
        console.log(`    common dir ${r.commonDir ?? "-"}${r.kind === "wrong-repo" ? `  (expected ${r.expectedCommonDir})` : ""}`);
        console.log(`    origin     ${r.origin ?? "(none)"}${r.kind === "wrong-repo" ? `  (expected ${r.expectedOrigin ?? "(none)"})` : ""}`);
      }
      if (r.detail) console.log(`    ${r.detail}`);
    }
  }
  console.log("");
}
process.exit(report.some((r) => r.kind === "wrong-repo") ? 1 : 0);
