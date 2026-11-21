import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { claudeProjectFolder, cliTranscriptExists, removeCliSessionFiles, removeOrphanCliFiles } from "./cli-session-files.js";

const SESSION = "3af04324-f8a0-49e8-b5a1-7fb487f9951b";
const OTHER = "fc6fdfd5-29ad-4661-82b7-9082490e47b4";
const LIVE = "6571301c-ed92-4d4f-9ca9-71700673487a";
const GONE = "25de2064-930d-4b20-9cb5-2115efadc54f";

let creds: string;
const workspaceRoot = "/home/u/.local/share/ucch/workspaces";
const escaped = "-home-u--local-share-ucch-workspaces";

async function put(path: string, content = "") {
  await mkdir(join(path, ".."), { recursive: true });
  await writeFile(path, content);
}

beforeEach(async () => {
  creds = await mkdtemp(join(tmpdir(), "ucch-creds-"));
});
afterEach(async () => {
  await rm(creds, { recursive: true, force: true });
});

describe("removeCliSessionFiles", () => {
  it("removes each CLI's transcript of the named sessions, and nothing else", async () => {
    const claude = join(creds, "user", "claude", "projects", `${escaped}-${LIVE}`);
    await put(join(claude, `${SESSION}.jsonl`));
    await mkdir(join(claude, SESSION), { recursive: true });
    await put(join(claude, `${OTHER}.jsonl`));
    const codex = join(creds, "user", "codex", "sessions", "2026", "11", "18");
    await put(join(codex, `rollout-2026-11-18T03-37-49-${SESSION}.jsonl`));
    await put(join(codex, `rollout-2026-11-18T03-37-49-${OTHER}.jsonl`));

    expect(await removeCliSessionFiles(creds, [SESSION, "short"])).toBe(3);
    expect(await readdir(claude)).toEqual([`${OTHER}.jsonl`]);
    expect(await readdir(codex)).toEqual([`rollout-2026-11-18T03-37-49-${OTHER}.jsonl`]);
  });
});

describe("removeOrphanCliFiles", () => {
  it("removes transcripts of deleted projects and of worktrees that are gone", async () => {
    const projects = join(creds, "user", "claude", "projects");
    await mkdir(join(projects, `${escaped}-${LIVE}`), { recursive: true });
    await mkdir(join(projects, `${escaped}-${GONE}`), { recursive: true });
    await mkdir(join(projects, `${escaped}--worktrees-${LIVE}-abc123`), { recursive: true });
    await mkdir(join(projects, "-home-u-elsewhere"), { recursive: true });
    const omp = join(creds, "user", "omp", "sessions");
    await mkdir(join(omp, LIVE), { recursive: true });
    await mkdir(join(omp, GONE), { recursive: true });
    const day = join(creds, "user", "codex", "sessions", "2026", "11", "18");
    const meta = (cwd: string) => `${JSON.stringify({ type: "session_meta", payload: { id: SESSION, cwd } })}\n`;
    await put(join(day, "rollout-a.jsonl"), meta(`${workspaceRoot}/${LIVE}`));
    await put(join(day, "rollout-b.jsonl"), meta(`${workspaceRoot}/.worktrees/${GONE}/abc123`));
    await put(join(day, "rollout-c.jsonl"), meta("/somewhere/else"));

    const removed = await removeOrphanCliFiles(creds, workspaceRoot, (id) => id === LIVE);
    expect(removed).toBe(4);
    expect((await readdir(projects)).sort()).toEqual([`${escaped}-${LIVE}`, "-home-u-elsewhere"].sort());
    expect(await readdir(omp)).toEqual([LIVE]);
    expect((await readdir(day)).sort()).toEqual(["rollout-a.jsonl", "rollout-c.jsonl"]);
  });
});

describe("cliTranscriptExists", () => {
  it("finds a Claude Code or Codex transcript by its session id, and says when it is gone", async () => {
    const claude = join(creds, "user", "claude");
    await put(join(claude, "projects", `${escaped}-${LIVE}`, `${SESSION}.jsonl`));
    expect(await cliTranscriptExists(claude, "claude", SESSION)).toBe(true);
    expect(await cliTranscriptExists(claude, "claude", OTHER)).toBe(false);
    const codex = join(creds, "user", "codex");
    await put(join(codex, "sessions", "2026", "11", "18", `rollout-2026-11-18T03-37-49-${SESSION}.jsonl`));
    expect(await cliTranscriptExists(codex, "codex", SESSION)).toBe(true);
    expect(await cliTranscriptExists(codex, "codex", OTHER)).toBe(false);
    expect(await cliTranscriptExists(join(creds, "missing"), "omp", SESSION)).toBe(true);
  });

  it("looks for Claude Code's only in the folder of the cwd it resumes in (plan2 §3.6)", async () => {
    const claude = join(creds, "user", "claude");
    const cwd = "/srv/work/ucch/project-1/.ucch-tree";
    expect(claudeProjectFolder(cwd)).toBe("-srv-work-ucch-project-1--ucch-tree");
    await put(join(claude, "projects", "-somewhere-else", `${SESSION}.jsonl`));
    // In another project's folder: `claude --resume` run here would not find it.
    expect(await cliTranscriptExists(claude, "claude", SESSION, cwd)).toBe(false);
    await put(join(claude, "projects", claudeProjectFolder(cwd)!, `${SESSION}.jsonl`));
    expect(await cliTranscriptExists(claude, "claude", SESSION, cwd)).toBe(true);
    // A path the CLI would shorten with a hash: every folder is looked in.
    expect(claudeProjectFolder(`/${"a".repeat(240)}`)).toBeNull();
    expect(await cliTranscriptExists(claude, "claude", SESSION, `/${"a".repeat(240)}`)).toBe(true);
  });
});
