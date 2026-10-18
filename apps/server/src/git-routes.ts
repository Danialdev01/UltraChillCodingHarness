import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";
import {
  GitCheckoutBody,
  GitCommitBody,
  GitCreateBranchBody,
  GitDiffScope,
  GitFetchBody,
  GitPathsBody,
  GitRemoteBody,
  GitResolveBody,
  type DomainEvent,
  type GitRemoteInfo,
  type GitStatus,
} from "@ucch/protocol";
import { PathError } from "./files.js";
import { GitError, RepoUrlError } from "./git-exec.js";
import { GitRefError, type GitAuthor, type GitChangedPath, type GitService, type GitTarget } from "./git.js";
import { tokenAppliesTo } from "./github.js";
import type { ProjectSummary } from "./workspaces.js";

type ProjectRequest = { cookies: Record<string, string | undefined>; params: { hash: string }; query?: unknown };

/** Who the owner commits as, and what they authenticate to the remote with. */
export interface GitCredentials {
  token: string | null;
  author: GitAuthor;
}

export interface GitRouteDeps {
  /** The caller's project for `:hash`, or null -- the same gate every project route uses. */
  projectFor(request: ProjectRequest): Promise<ProjectSummary | null>;
  /**
   * The tree a request works on: the session's worktree for `?session=`,
   * the project's checkout without one, null for a session not in it.
   */
  treeFor(request: ProjectRequest, project: ProjectSummary): Promise<GitTarget | null>;
  git: GitService;
  /** Resolved per request: a token is decrypted for the one push that needs it. */
  credentialsFor(projectId: string): Promise<GitCredentials>;
  /** Tells the project's other open views something changed. Never throws. */
  announce(projectId: string, events: DomainEvent[]): Promise<void>;
  /** Records where the code now lives: on adding, moving or removing `origin`. */
  remoteChanged(projectId: string, url: string | null): Promise<void>;
}

const Sha = z.string().regex(/^[0-9a-f]{4,40}$/);
const DiffQuery = z.object({ path: z.string().min(1), scope: GitDiffScope.default("worktree") });
const CommitDiffQuery = z.object({ path: z.string().min(1) });
const LogQuery = z.object({
  skip: z.coerce.number().int().min(0).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

/** What git says when the failure is the user's situation rather than ours. */
const USER_FAULT =
  /CONFLICT|would be overwritten|non-fast-forward|nothing to commit|nothing added to commit|no upstream|not something we can merge|no tracking information|already exists|rejected|not a git repository|no such remote|does not have any commits|MERGE_HEAD|not currently on a branch|unmerged files|failed to push some refs/i;
const AUTH_FAULT = /Authentication failed|could not read Username|Permission denied|Invalid username or (token|password)|403/i;

/**
 * A project's repository, under `/api/projects/:hash/git`.
 *
 * Mutations answer with the fresh status so the view has nothing to fetch
 * afterwards, and every one that touches the working tree announces the
 * paths so the file tree and the editor hear about it the way they hear
 * about the agent's writes.
 */
export function registerGitRoutes(app: FastifyInstance, deps: GitRouteDeps): void {
  const { projectFor, treeFor, git, credentialsFor, announce, remoteChanged } = deps;

  type Hash = { hash: string };
  type HashAndSha = { hash: string; sha: string };

  const notFound = { error: "project not found" };

  async function fileEvents(projectId: string, changed: GitChangedPath[]): Promise<void> {
    if (changed.length === 0) return;
    await announce(
      projectId,
      changed.map((c) => ({ type: "file.changed" as const, projectId, path: c.path, change: c.change })),
    );
  }

  /** The owner's token, but only for the host the repository actually lives on. */
  async function remoteCredentials(project: ProjectSummary): Promise<GitCredentials> {
    const [credentials, url] = await Promise.all([credentialsFor(project.id), git.remoteUrl(project.id)]);
    const token = url && tokenAppliesTo(url) ? credentials.token : null;
    return { token, author: credentials.author };
  }

  /** Runs a handler, turning git's refusals into the status they deserve. */
  async function attempt<T>(reply: FastifyReply, work: () => Promise<T>): Promise<T | undefined> {
    try {
      return await work();
    } catch (error) {
      failure(error, reply);
      return undefined;
    }
  }

  // ---- reading ------------------------------------------------------------

  app.get<{ Params: Hash }>("/api/projects/:hash/git/status", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    if (!(await git.isRepo(tree))) return reply.code(409).send({ error: "not a git repository", notRepo: true });
    return attempt(reply, () => git.status(tree));
  });

  app.get<{ Params: Hash; Querystring: unknown }>("/api/projects/:hash/git/diff", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const query = DiffQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "path is required" });
    return attempt(reply, () => git.diff(tree, query.data.path, query.data.scope));
  });

  app.get<{ Params: Hash; Querystring: unknown }>("/api/projects/:hash/git/log", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const query = LogQuery.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "bad paging" });
    return attempt(reply, () => git.log(tree, query.data));
  });

  app.get<{ Params: HashAndSha }>("/api/projects/:hash/git/commits/:sha", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const sha = Sha.safeParse(request.params.sha);
    if (!sha.success) return reply.code(400).send({ error: "not a commit id" });
    return attempt(reply, () => git.show(tree, sha.data));
  });

  app.get<{ Params: HashAndSha; Querystring: unknown }>(
    "/api/projects/:hash/git/commits/:sha/diff",
    async (request, reply) => {
      const project = await projectFor(request);
      if (!project) return reply.code(404).send(notFound);
      const tree = await treeFor(request, project);
      if (!tree) return reply.code(404).send({ error: "session not found" });
      const sha = Sha.safeParse(request.params.sha);
      const query = CommitDiffQuery.safeParse(request.query);
      if (!sha.success || !query.success) return reply.code(400).send({ error: "commit id and path are required" });
      return attempt(reply, () => git.commitDiff(tree, sha.data, query.data.path));
    },
  );

  app.get<{ Params: Hash }>("/api/projects/:hash/git/branches", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    return attempt(reply, () => git.branches(tree));
  });

  // ---- the index ----------------------------------------------------------

  for (const action of ["stage", "unstage"] as const) {
    app.post<{ Params: Hash; Body: unknown }>(`/api/projects/:hash/git/${action}`, async (request, reply) => {
      const project = await projectFor(request);
      if (!project) return reply.code(404).send(notFound);
      const tree = await treeFor(request, project);
      if (!tree) return reply.code(404).send({ error: "session not found" });
      const body = GitPathsBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "paths or all is required" });
      const paths = "all" in body.data ? "all" : body.data.paths;
      return attempt(reply, async (): Promise<GitStatus> => {
        await git[action](tree, paths);
        return git.status(tree);
      });
    });
  }

  app.post<{ Params: Hash; Body: unknown }>("/api/projects/:hash/git/discard", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const body = GitPathsBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "paths or all is required" });
    const paths = "all" in body.data ? "all" : body.data.paths;
    return attempt(reply, async (): Promise<GitStatus> => {
      const changed = await git.discard(tree, paths);
      await fileEvents(project.id, changed);
      return git.status(tree);
    });
  });

  app.post<{ Params: Hash; Body: unknown }>("/api/projects/:hash/git/commit", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const body = GitCommitBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "a summary is required" });
    return attempt(reply, async () => {
      const { author } = await credentialsFor(project.id);
      const { sha, branch } = await git.commit(tree, body.data, author);
      await announce(project.id, [
        {
          type: "git.committed",
          projectId: project.id,
          threadId: null,
          commitSha: sha,
          branch: branch ?? "HEAD",
          message: body.data.summary,
        },
      ]);
      return { sha, branch, status: await git.status(tree) };
    });
  });

  // ---- branches -----------------------------------------------------------

  app.post<{ Params: Hash; Body: unknown }>("/api/projects/:hash/git/checkout", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const body = GitCheckoutBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "a branch is required" });
    return attempt(reply, async (): Promise<GitStatus> => {
      const changed = await git.checkout(tree, body.data.branch, body.data.remote ?? false);
      await fileEvents(project.id, changed);
      return git.status(tree);
    });
  });

  app.post<{ Params: Hash; Body: unknown }>("/api/projects/:hash/git/branches", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const body = GitCreateBranchBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "a branch name is required" });
    return attempt(reply, async (): Promise<GitStatus> => {
      await git.createBranch(tree, body.data.name);
      return git.status(tree);
    });
  });

  // ---- the remote ---------------------------------------------------------

  app.post<{ Params: Hash; Body: unknown }>("/api/projects/:hash/git/fetch", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const body = GitFetchBody.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: "bad request" });
    return attempt(reply, async (): Promise<GitStatus> => {
      const { token } = await remoteCredentials(project);
      await git.fetch(tree, token, body.data);
      return git.status(tree);
    });
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/git/pull", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    return attempt(reply, async () => {
      const { token, author } = await remoteCredentials(project);
      const { conflicts, changed } = await git.pull(tree, token, author);
      await fileEvents(project.id, changed);
      return { conflicts, status: await git.status(tree) };
    });
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/git/push", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    return attempt(reply, async (): Promise<GitStatus> => {
      const { token } = await remoteCredentials(project);
      const { branch, remoteSha } = await git.push(tree, token);
      await announce(project.id, [{ type: "git.pushed", projectId: project.id, branch, remoteSha }]);
      return git.status(tree);
    });
  });

  app.post<{ Params: Hash; Body: unknown }>("/api/projects/:hash/git/remote", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const body = GitRemoteBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "a repository url is required" });
    return attempt(reply, async () => {
      const url = body.data.url;
      // The token is judged against the URL being added, not the one on the
      // repository -- there is none yet.
      const credentials = await credentialsFor(project.id);
      const token = tokenAppliesTo(url) ? credentials.token : null;
      const { mergedFrom, conflicts, changed } = await git.connectRemote(tree, url, token, credentials.author);
      await remoteChanged(project.id, url);
      await fileEvents(project.id, changed);
      return { mergedFrom, conflicts, status: await git.status(tree) };
    });
  });

  // Reading, moving and forgetting `origin`, for the manage page. Adding one
  // is the POST above, because it also fetches and joins the histories.
  async function remoteInfo(tree: GitTarget): Promise<GitRemoteInfo> {
    const [url, status] = await Promise.all([git.remoteUrl(tree), git.status(tree)]);
    return { url: url ? scrub(url) : null, status };
  }

  app.get<{ Params: Hash }>("/api/projects/:hash/git/remote", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    if (!(await git.isRepo(tree))) return reply.code(409).send({ error: "not a git repository", notRepo: true });
    return attempt(reply, () => remoteInfo(tree));
  });

  app.put<{ Params: Hash; Body: unknown }>("/api/projects/:hash/git/remote", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const body = GitRemoteBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "a repository url is required" });
    return attempt(reply, async () => {
      await git.setRemoteUrl(tree, body.data.url);
      await remoteChanged(project.id, body.data.url);
      return remoteInfo(tree);
    });
  });

  app.delete<{ Params: Hash }>("/api/projects/:hash/git/remote", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    return attempt(reply, async () => {
      await git.removeRemote(tree);
      await remoteChanged(project.id, null);
      return remoteInfo(tree);
    });
  });

  // ---- conflicts ----------------------------------------------------------

  app.post<{ Params: Hash; Body: unknown }>("/api/projects/:hash/git/resolve", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const body = GitResolveBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "a path and strategy are required" });
    return attempt(reply, async (): Promise<GitStatus> => {
      await git.resolve(tree, body.data.path, body.data.strategy);
      await fileEvents(project.id, [{ path: body.data.path, change: "modified" }]);
      return git.status(tree);
    });
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/git/merge/abort", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const tree = await treeFor(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    return attempt(reply, async (): Promise<GitStatus> => {
      const changed = await git.abortMerge(tree);
      await fileEvents(project.id, changed);
      return git.status(tree);
    });
  });
}

/**
 * Turns a refused path or ref into a 400, a situation git will not act on
 * into a 409, a remote that wants credentials into a 403, and the rest into
 * a 500 that still says what git said.
 */
function failure(error: unknown, reply: FastifyReply): void {
  if (error instanceof PathError || error instanceof GitRefError || error instanceof RepoUrlError) {
    void reply.code(400).send({ error: error.message });
    return;
  }
  if (error instanceof GitError) {
    const message = scrub(error.stderr.trim() || error.message);
    if (AUTH_FAULT.test(message)) {
      void reply.code(403).send({ error: message, needsToken: true });
      return;
    }
    if (USER_FAULT.test(message)) {
      void reply.code(409).send({ error: message });
      return;
    }
    void reply.code(500).send({ error: message });
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  void reply.code(500).send({ error: scrub(message) });
}

/** A URL with embedded credentials, should git ever echo one, loses them. */
function scrub(text: string): string {
  return text.replace(/\/\/[^/@\s]+@/g, "//");
}
