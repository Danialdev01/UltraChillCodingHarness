import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GitCache } from "./git-cache.js";
import { runGit } from "./git-exec.js";
import { registerGitRoutes } from "./git-routes.js";
import { GitService } from "./git.js";
import type { ProjectSummary } from "./workspaces.js";

const PROJECT = "44444444-4444-4444-4444-444444444444";

let root: string;
let app: FastifyInstance;
let git: GitService;
let cache: GitCache;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-git-routes-"));
  const dir = join(root, PROJECT);
  await mkdir(dir, { recursive: true });
  await runGit(["init", "-q", "-b", "main"], dir, 20_000);
  await writeFile(join(dir, "a.ts"), "one\n");
  git = new GitService(root);
  cache = new GitCache({ onInvalidated: () => {} });
  app = Fastify();
  registerGitRoutes(app, {
    projectFor: async () => ({ id: PROJECT }) as ProjectSummary,
    treeFor: async () => PROJECT,
    git,
    cache,
    credentialsFor: async () => ({ token: null, author: { name: "Test", email: "test@example.com" } }),
    announce: async () => {},
    remoteChanged: async () => {},
  });
  await app.ready();
});

afterEach(async () => {
  cache.dispose();
  await app.close();
  await rm(root, { recursive: true, force: true });
});

describe("git reads through the shared cache", () => {
  it("answers a viewer with the current version 304, without running git", async () => {
    const status = vi.spyOn(git, "status");
    const first = await app.inject({ method: "GET", url: "/api/projects/h/git/status" });
    expect(first.statusCode).toBe(200);
    const etag = first.headers.etag as string;
    expect(etag).toMatch(/^".+"$/);
    expect(first.headers["cache-control"]).toBe("private, no-cache");

    const again = await app.inject({ method: "GET", url: "/api/projects/h/git/status", headers: { "if-none-match": etag } });
    expect(again.statusCode).toBe(304);
    const other = await app.inject({ method: "GET", url: "/api/projects/h/git/status" });
    expect(other.json()).toEqual(first.json());
    expect(status).toHaveBeenCalledTimes(1);
  });

  it("reads again after a git action, which answers with the new status", async () => {
    const first = await app.inject({ method: "GET", url: "/api/projects/h/git/status" });
    const staged = await app.inject({ method: "POST", url: "/api/projects/h/git/stage", payload: { all: true } });
    expect(staged.statusCode).toBe(200);
    expect(staged.json().files).toEqual([expect.objectContaining({ path: "a.ts", index: "A" })]);
    const after = await app.inject({
      method: "GET",
      url: "/api/projects/h/git/status",
      headers: { "if-none-match": first.headers.etag as string },
    });
    expect(after.statusCode).toBe(200);
    expect(after.json()).toEqual(staged.json());
  });

  it("shares the first page of the log as the view asks for it, and only that page", async () => {
    await runGit(["-c", "user.name=T", "-c", "user.email=t@example.com", "commit", "-q", "--allow-empty", "-m", "init"], join(root, PROJECT), 20_000);
    const log = vi.spyOn(git, "log");
    await app.inject({ method: "GET", url: "/api/projects/h/git/log" });
    await app.inject({ method: "GET", url: "/api/projects/h/git/log?skip=0&limit=50" });
    await app.inject({ method: "GET", url: "/api/projects/h/git/log?skip=50" });
    expect(log).toHaveBeenCalledTimes(2);
  });
});
