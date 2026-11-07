/**
 * Seeds a "Sidebar demo" workspace for checking the session sidebar by eye:
 * three projects, a dozen sessions across Claude Code, Codex and UCCH's
 * agent, in every status -- running, waiting, settled, failed, idle, pinned,
 * archived -- with their last activity spread from minutes to weeks ago.
 *
 *   SEED_SIDEBAR_ALLOW=1 pnpm --filter @ucch/server exec tsx \
 *     --env-file-if-exists=../../.env scripts/seed-sidebar.ts [--user <uuid>]
 *
 * The workspace belongs to `--user` (the development bypass's user by
 * default). Run again, it replaces the demo workspace's contents.
 *
 * Rows are written straight into the projections, not through the engine:
 * the projects have no repositories or containers, so opening one shows an
 * empty project, and a rebuild of the projections from the event log would
 * not bring them back. That is the point -- it is display data, for a
 * development database only, and refuses to run without the flag.
 */
import { parseArgs } from "node:util";
import { randomBytes } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { createDatabase, projects, projectStats, threads, turns, workspaceMembers, workspaces } from "@ucch/db";

const DEV_USER_ID = "00000000-0000-4000-8000-000000000001";
const WORKSPACE_NAME = "Sidebar demo";

const { values: args } = parseArgs({ options: { user: { type: "string", default: DEV_USER_ID } } });

const fail = (message: string): never => {
  console.error(`seed-sidebar: ${message}`);
  process.exit(1);
};
if (process.env.SEED_SIDEBAR_ALLOW !== "1") fail("set SEED_SIDEBAR_ALLOW=1 to seed demo sessions");
const databaseUrl = process.env.DATABASE_URL ?? fail("DATABASE_URL is not set");

const db = createDatabase(databaseUrl, { max: 1 });
const userId = args.user;

const hash = () => {
  const alphabet = "abcdefghijklmnopqrstuvwxyz0123456789";
  return [...randomBytes(12)].map((b) => alphabet[b % alphabet.length]).join("");
};
const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000);

const PROJECTS = [
  { name: "BakeryShop", stack: "laravel", defaultBranch: "main" },
  { name: "dbot", stack: "node", defaultBranch: "main" },
  { name: "ClinicApp", stack: "react-native", defaultBranch: "develop" },
  // Empty: the grouped view says "No sessions yet".
  { name: "Inventory API", stack: "spring", defaultBranch: "main" },
] as const;

type Turn = { model: string; stopReason?: string | null; error?: string | null };
const SESSIONS: {
  project: number;
  title: string;
  provider: "claude" | "codex" | "omp" | null;
  status: "idle" | "running" | "error";
  minutesAgo: number;
  branch?: string;
  pinned?: boolean;
  archived?: boolean;
  turn?: Turn;
}[] = [
  { project: 0, title: "Identify project purpose", provider: "claude", status: "idle", minutesAgo: 360, turn: { model: "claude-opus-5-5", stopReason: "end_turn" }, pinned: true },
  { project: 0, title: "Fix checkout tax rounding", provider: "codex", status: "running", minutesAgo: 1, branch: "ucch/fixtaxround1", turn: { model: "gpt-5-codex" } },
  { project: 0, title: "Add Stripe webhook tests", provider: "omp", status: "idle", minutesAgo: 60 * 26, branch: "ucch/stripehooks1", turn: { model: "openrouter/qwen/qwen3-coder", stopReason: "end_turn" } },
  { project: 0, title: "Migrate to Laravel 12", provider: "claude", status: "error", minutesAgo: 60 * 24 * 3, branch: "ucch/laravel12up1", turn: { model: "claude-sonnet-4-5", error: "the CLI exited with code 1" } },
  { project: 1, title: "Why is the deploy 500ing", provider: "claude", status: "running", minutesAgo: 4, turn: { model: "claude-opus-5-5" } },
  { project: 1, title: "Refactor the command router", provider: "codex", status: "idle", minutesAgo: 60 * 5, branch: "ucch/cmdrouter001", turn: { model: "gpt-5.1-codex-mini", stopReason: "end_turn" } },
  { project: 1, title: "Untitled", provider: null, status: "idle", minutesAgo: 12 },
  { project: 1, title: "Old spike: voice commands", provider: "omp", status: "idle", minutesAgo: 60 * 24 * 40, archived: true, turn: { model: "openrouter/deepseek/deepseek-v3", stopReason: "cancelled" } },
  { project: 2, title: "Push notifications on Android", provider: "codex", status: "idle", minutesAgo: 60 * 24 * 9, branch: "ucch/androidpush1", turn: { model: "gpt-5-codex", stopReason: "max_tokens" } },
  { project: 2, title: "Appointment reminders screen", provider: "claude", status: "idle", minutesAgo: 60 * 24 * 16, turn: { model: "claude-haiku-4-5", stopReason: "end_turn" } },
  { project: 2, title: "Expo SDK upgrade", provider: "omp", status: "idle", minutesAgo: 60 * 30, branch: "ucch/exposdkup01", turn: { model: "openrouter/anthropic/claude-sonnet-4.5", stopReason: "end_turn" } },
];

let [workspace] = await db
  .select({ id: workspaces.id, hash: workspaces.hash })
  .from(workspaces)
  .where(and(eq(workspaces.ownerUserId, userId), eq(workspaces.name, WORKSPACE_NAME)))
  .limit(1);

if (workspace) {
  // Projects cascade to their threads and turns.
  await db.delete(projects).where(eq(projects.workspaceId, workspace.id));
} else {
  [workspace] = await db
    .insert(workspaces)
    .values({ ownerUserId: userId, name: WORKSPACE_NAME, slug: `sidebar-demo-${hash().slice(0, 6)}`, hash: hash() })
    .returning({ id: workspaces.id, hash: workspaces.hash });
  await db.insert(workspaceMembers).values({ workspaceId: workspace!.id, userId, role: "owner" });
}

const projectIds: string[] = [];
for (const p of PROJECTS) {
  const [row] = await db
    .insert(projects)
    .values({ workspaceId: workspace!.id, userId, hash: hash(), name: p.name, stack: p.stack, defaultBranch: p.defaultBranch })
    .returning({ id: projects.id });
  projectIds.push(row!.id);
  await db.insert(projectStats).values({ projectId: row!.id }).onConflictDoNothing();
}

for (const s of SESSIONS) {
  const [thread] = await db
    .insert(threads)
    .values({
      projectId: projectIds[s.project]!,
      title: s.title,
      status: s.status,
      provider: s.provider,
      hash: hash(),
      createdByUserId: userId,
      baseBranch: s.branch ? PROJECTS[s.project]!.defaultBranch : null,
      branch: s.branch ?? null,
      worktreeState: s.branch ? "ready" : null,
      pinned: s.pinned ?? false,
      archivedAt: s.archived ? ago(s.minutesAgo - 5) : null,
      lastActivityAt: ago(s.minutesAgo),
      createdAt: ago(s.minutesAgo + 30),
    })
    .returning({ id: threads.id });
  if (s.turn) {
    await db.insert(turns).values({
      threadId: thread!.id,
      seq: 0,
      model: s.turn.model,
      stopReason: s.turn.stopReason ?? null,
      error: s.turn.error ?? null,
      createdAt: ago(s.minutesAgo),
    });
  }
}

console.log(`seed-sidebar: ${SESSIONS.length} sessions in ${PROJECTS.length} projects, at /${workspace!.hash}`);
process.exit(0);
