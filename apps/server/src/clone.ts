import { access, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import type { Command, DomainEvent } from "@ucch/protocol";
import { CREDENTIAL_HELPER, runGit, safeRepoUrl } from "./git-exec.js";
import { redactToken, tokenAppliesTo } from "./github.js";

export { CREDENTIAL_HELPER };
import { DrainableWorker } from "./worker.js";

type ProjectCreated = Extract<DomainEvent, { type: "project.created" }>;
type ProjectCloned = Extract<DomainEvent, { type: "project.cloned" }>;

/** A clone of a large repository is slow, but it is not slow for ever. */
const DEFAULT_TIMEOUT_MS = 5 * 60_000;

/**
 * What the owning account brings to a clone: who to commit as, and what to
 * authenticate with.
 *
 * Resolved per project rather than held, so a token is decrypted for the one
 * clone that needs it and the reactor keeps no credential of its own.
 */
export interface CloneCredentials {
  /** A GitHub token, for a private repository over HTTPS. */
  token?: string | null;
  /** The identity the first commit of an empty project is made under. */
  author?: { name: string; email: string };
}

export interface CloneOptions {
  /** Host directory the project workspaces live under. */
  workspaceRoot: string;
  timeoutMs?: number;
  /**
   * The owning account's credentials, looked up when a clone is about to run.
   *
   * Optional: without it a public repository still clones and an empty project
   * is still initialised, which is what keeps the reactor testable with no
   * database behind it.
   */
  credentials?: (event: ProjectCreated) => Promise<CloneCredentials>;
}

/** Who an initial commit is attributed to when the account says nothing. */
const FALLBACK_AUTHOR = { name: "UltraChillCodingHarness", email: "harness@localhost" };

/**
 * The first file of a repository that was started rather than cloned.
 *
 * Something has to be committed -- `git init` alone leaves no HEAD to resolve,
 * and every later checkpoint is a diff against a commit that would not exist.
 * A README with the project's name is the smallest file that is also worth
 * keeping, and the agent rewrites it as soon as it is asked for anything.
 */
function readmeFor(name: string): string {
  return `# ${name}\n`;
}

/**
 * The reactor that puts a repository on disk.
 *
 * On `project.created` it clones the repository into
 * `WORKSPACE_ROOT/{projectId}`, detects the stack from marker files, and
 * emits `project.cloned` -- an event the protocol has carried since Phase 1
 * with nothing to produce it. Until this existed `WORKSPACE_ROOT` was
 * validated at boot and written by nobody, so the file tools had an empty
 * directory to look at.
 *
 * It lives here rather than in `packages/vcs`, which does not exist yet;
 * §12 of `idea.md` is explicit that this moves when that package is built.
 *
 * The work runs in a `DrainableWorker` for the same reason the orchestration
 * queue does: one clone at a time, and a test can await genuine completion
 * rather than sleeping and hoping.
 */
export class CloneReactor {
  readonly worker: DrainableWorker<ProjectCreated>;

  /**
   * @param append emits the resulting event -- injected rather than reached
   *   for, so the clone can be tested without a database behind it. Narrowed
   *   to what this reactor actually produces, so the caller can append it
   *   against the project without proving the event has a `projectId`.
   */
  constructor(
    private readonly append: (event: ProjectCloned) => Promise<void>,
    private readonly options: CloneOptions,
    onError: (error: unknown, event: ProjectCreated) => void = () => {},
  ) {
    this.worker = new DrainableWorker<ProjectCreated>(
      "clone",
      (event) => this.#clone(event),
      onError,
    );
  }

  /** Queues a clone for each project that was just created. */
  react(_command: Command, batch: readonly DomainEvent[]): void {
    for (const event of batch) {
      if (event.type === "project.created") this.worker.push(event);
    }
  }

  /** Resolves once every queued clone has finished. For tests and shutdown. */
  drain(): Promise<void> {
    return this.worker.drain();
  }

  async #clone(event: ProjectCreated): Promise<void> {
    const dest = join(this.options.workspaceRoot, event.projectId);
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Idempotent: a redelivered event, or a boot that replays one, must not
    // fail on a directory that is already a working tree. `git clone` refuses
    // a non-empty target, so the check has to happen before it runs.
    const alreadyCloned = await exists(join(dest, ".git"));

    if (!alreadyCloned) {
      // Looked up only when there is work to do, so a redelivered event
      // decrypts nothing. A resolver that fails is not the clone's problem
      // to report: a public repository does not need it.
      const credentials = this.options.credentials
        ? await this.options.credentials(event).catch(() => ({}) as CloneCredentials)
        : {};

      if (event.repoUrl === null) {
        await this.#init(event, dest, credentials, timeoutMs);
      } else {
        await this.#fetch(event, event.repoUrl, dest, credentials, timeoutMs);
      }
    }

    const headSha = (await runGit(["rev-parse", "HEAD"], dest, timeoutMs)).trim();
    const stack = await detectStack(dest);

    await this.append({ type: "project.cloned", projectId: event.projectId, headSha, stack });
  }

  /** Clones a remote into an empty directory. */
  async #fetch(
    event: ProjectCreated,
    repoUrl: string,
    dest: string,
    credentials: CloneCredentials,
    timeoutMs: number,
  ): Promise<void> {
    const url = safeRepoUrl(repoUrl);
    // The URL stays clean and the credential travels out of band. Putting it on
    // the URL instead would write it into the clone's own `.git/config`, where
    // it would outlive the clone and be readable by the agent and by every
    // terminal opened in the project.
    const token = tokenAppliesTo(url) ? credentials.token ?? null : null;
    const clean = (error: unknown) => redactToken(describe(error), token);

    await mkdir(dest, { recursive: true });
    try {
      await runGit(
        ["clone", "--depth", "1", "--branch", event.defaultBranch, "--", url, dest],
        this.options.workspaceRoot,
        timeoutMs,
        { token },
      );
    } catch (error) {
      // `defaultBranch` defaults to "main" when the creating command did
      // not name one, and plenty of repositories are still on "master".
      // Falling back to the remote's own HEAD turns the commonest possible
      // failure into a working tree; a genuinely broken URL still throws,
      // now carrying both messages.
      //
      // The target is cleared first: a clone that failed partway leaves
      // whatever it had written, and the retry would then refuse a
      // directory that is not empty.
      await rm(dest, { recursive: true, force: true });
      await mkdir(dest, { recursive: true });
      try {
        await runGit(
          ["clone", "--depth", "1", "--", url, dest],
          this.options.workspaceRoot,
          timeoutMs,
          { token },
        );
      } catch (fallback) {
        throw new Error(
          `could not clone ${repoUrl}: ${clean(error)} (and without --branch: ${clean(fallback)})`,
        );
      }
    }
  }

  /**
   * Starts a repository that has no remote.
   *
   * The project is a git repository from this moment rather than from whenever
   * somebody remembers to run `git init` in the terminal: the checkpoint and
   * revert machinery is all diffs against commits, and a working tree with no
   * HEAD has nothing for them to be diffs against. It is also what makes the
   * project pushable later -- a remote is added to a history that already
   * exists, and the first push is the only new step.
   *
   * `-b` names the initial branch explicitly, so the project is on the branch
   * the dialog said it would be on rather than whatever this git's
   * `init.defaultBranch` happens to be.
   */
  async #init(
    event: ProjectCreated,
    dest: string,
    credentials: CloneCredentials,
    timeoutMs: number,
  ): Promise<void> {
    await mkdir(dest, { recursive: true });
    await runGit(["init", "-b", event.defaultBranch], dest, timeoutMs);

    // Never clobbered: an empty project is the usual case, but a directory
    // that already has files -- a retry, or a restore -- is committed as it
    // stands rather than having a README written over the top of it.
    const readme = join(dest, "README.md");
    if (!(await exists(readme))) await writeFile(readme, readmeFor(event.name), "utf8");

    const author = credentials.author ?? FALLBACK_AUTHOR;
    await runGit(["add", "-A"], dest, timeoutMs);
    await runGit(
      [
        // Passed as config rather than set in the repository: the identity
        // belongs to this commit, and the agent's own commits resolve it the
        // same way rather than inheriting a name from here.
        "-c",
        `user.name=${author.name}`,
        "-c",
        `user.email=${author.email}`,
        "commit",
        "--no-verify",
        "-m",
        `Initialise ${event.name}`,
      ],
      dest,
      timeoutMs,
    );
  }
}

/**
 * The branches a remote offers, and which one it points HEAD at.
 *
 * `git ls-remote --symref` rather than GitHub's API: it is one call, it works
 * against GitLab and a self-hosted mirror exactly as well, and it needs no
 * token for a public repository. It reads the remote without cloning it, so
 * the dialog can offer real branches before anything is written to disk.
 *
 * The URL goes through the same whitelist a clone does, and the same
 * environment -- so a private repository fails fast on a refused prompt
 * rather than hanging, and `ext::` never reaches git.
 *
 * A token, when the account has one, is what makes a private GitHub
 * repository readable here rather than a refusal the person cannot act on --
 * and it is redacted out of any failure, because git quotes the URL it was
 * handed back at whoever asked.
 */
export async function listRemoteBranches(
  repoUrl: string,
  options: { token?: string | null; timeoutMs?: number } = {},
): Promise<{ branches: string[]; defaultBranch: string | null }> {
  const url = safeRepoUrl(repoUrl);
  const token = tokenAppliesTo(url) ? options.token ?? null : null;
  // No `--heads`: it filters the reply down to `refs/heads/*` and drops the
  // `ref: refs/heads/... HEAD` line with it, which is the only thing that
  // says which branch the remote considers default. Tags and pull refs come
  // along instead, and the parser ignores them.
  try {
    const stdout = await runGit(
      ["ls-remote", "--symref", "--", url],
      process.cwd(),
      options.timeoutMs ?? 20_000,
      { token },
    );
    return parseRemoteRefs(stdout);
  } catch (error) {
    throw new Error(redactToken(describe(error), token));
  }
}

/**
 * Reads `ls-remote --symref` output.
 *
 * Two shapes in one stream:
 *
 *     ref: refs/heads/main	HEAD
 *     9fceb02...	refs/heads/main
 *
 * The first names the default branch, the rest are the heads. Split on any
 * whitespace: git separates the columns with a tab, but not every server
 * does.
 */
export function parseRemoteRefs(stdout: string): {
  branches: string[];
  defaultBranch: string | null;
} {
  const branches: string[] = [];
  let defaultBranch: string | null = null;

  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    if (trimmed.startsWith("ref:")) {
      const [, ref] = trimmed.split(/\s+/);
      if (ref?.startsWith("refs/heads/")) defaultBranch = ref.slice("refs/heads/".length);
      continue;
    }

    const ref = trimmed.split(/\s+/)[1];
    if (ref?.startsWith("refs/heads/")) branches.push(ref.slice("refs/heads/".length));
  }

  // A remote whose HEAD is not among its heads would leave the dialog with a
  // default it cannot select.
  if (defaultBranch && !branches.includes(defaultBranch)) branches.unshift(defaultBranch);
  return { branches, defaultBranch: defaultBranch ?? branches[0] ?? null };
}

/**
 * Detects the project's stack from marker files in the repository root.
 *
 * Order is significance, not alphabet: a Next.js project has a
 * `package.json` too, so the framework markers are tested before the
 * language ones and `node` is what is left when none of them matches.
 */
export async function detectStack(dir: string): Promise<string> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return "unknown";
  }
  const names = new Set(entries);
  const has = (pattern: RegExp) => entries.some((name) => pattern.test(name));

  if (names.has("artisan")) return "laravel";
  if (has(/^next\.config\./)) return "nextjs";
  if (has(/^vite\.config\./)) return "vite";
  if (names.has("package.json")) return "node";
  if (names.has("index.php")) return "php";
  return "static";
}

/**
 * Creates `WORKSPACE_ROOT` and proves it can be written to.
 *
 * Called at boot rather than at first clone: a workspace root that is
 * missing or read-only makes every project silently useless, and finding
 * that out when the server starts is far cheaper than finding it out from a
 * clone that failed an hour later.
 */
export async function ensureWorkspaceRoot(root: string): Promise<void> {
  try {
    await mkdir(root, { recursive: true });
  } catch (error) {
    throw new Error(`WORKSPACE_ROOT ${root} could not be created: ${describe(error)}`);
  }
  try {
    await access(root, constants.W_OK | constants.X_OK);
  } catch {
    throw new Error(`WORKSPACE_ROOT ${root} is not writable by this process`);
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
