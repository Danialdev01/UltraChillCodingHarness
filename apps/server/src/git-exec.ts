import { execFile } from "node:child_process";
import { BaseUrlError, checkedAddresses } from "./git-base-url.js";
import type { GitAuth } from "./git-auth.js";
import { registry } from "./metrics.js";

/**
 * The environment variable the credential helper below reads the token from.
 *
 * An environment variable rather than an argument: a process's command line is
 * world-readable on Linux, so a token on it would be visible to every other
 * user on the host for as long as the command ran.
 */
const TOKEN_ENV = "UCCH_GIT_TOKEN";
/** The name that goes with it. Also from the environment: a login is the host's to choose, and this is a shell. */
const USERNAME_ENV = "UCCH_GIT_USERNAME";

/**
 * A credential helper that answers from the environment, and writes nothing.
 *
 * This is how a token reaches a private clone without ever being stored: not
 * in the URL, which `git clone` copies into the new repository's own
 * `.git/config`; not in a config file, which would outlive the command; and
 * not on the command line, which is readable from `/proc`. A `!` helper is a
 * shell snippet git runs for the one operation that needs a password, and
 * `$UCCH_GIT_TOKEN` is expanded by that shell, from the environment this
 * process handed it.
 *
 * `test "$1" = get` is the guard that makes it read-only: git also calls a
 * helper with `store` and `erase`, and this one declines to do either.
 */
export const CREDENTIAL_HELPER =
  `!f() { test "$1" = get && printf 'username=%s\\npassword=%s\\n' ` +
  `"$${USERNAME_ENV}" "$${TOKEN_ENV}"; }; f`;

/**
 * A git command that exited with a code the caller did not accept.
 *
 * Carries stderr as its own field because that is where git explains itself,
 * and the routes decide from its wording whether the failure was the user's
 * (a dirty tree, a non-fast-forward push) or ours.
 */
export class GitError extends Error {
  constructor(
    readonly argv: string[],
    readonly exitCode: number | null,
    readonly stderr: string,
    detail?: string,
  ) {
    super(`git ${argv[0] ?? ""} failed: ${stderr.trim() || detail || `exit ${exitCode}`}`);
    this.name = "GitError";
  }
}

export interface GitRunOptions {
  /** Attaches the credential helper for this one command and this one host. */
  auth?: GitAuth | null;
  /**
   * Exit codes that are answers rather than failures: `diff` exits 1 when
   * there are differences, `merge` exits 1 on a conflict.
   */
  okExitCodes?: readonly number[];
  /**
   * A read: `GIT_OPTIONAL_LOCKS=0`, so `status` and `diff` do not refresh
   * and rewrite `.git/index` on the way -- a write that woke the file
   * watcher again, and took the index lock from under the agent.
   */
  read?: boolean;
  /** Added to the rebuilt environment: another git directory or work tree. */
  env?: Readonly<Record<string, string>>;
}

/**
 * Runs git with a rebuilt environment and no way to ask a human anything.
 *
 * The environment matters twice over. The server's own holds `SECRET_KEY`
 * and `DATABASE_URL` and a subprocess has no business reading them; and
 * without `GIT_TERMINAL_PROMPT=0` a private repository does not fail, it
 * *blocks* on a credential prompt no one is there to answer, holding the
 * worker until the timeout. The config files are pinned to /dev/null so the
 * host's `insteadOf` rules and hooks cannot rewrite what gets fetched.
 *
 * An `auth` attaches the credential helper above for this one command, scoped
 * to the origin it is for: another host -- a submodule, a remote that moved --
 * gets nothing. git follows a
 * redirect on its first request, before it has asked for a credential, so a
 * renamed repository still works and a redirect elsewhere is asked for again.
 */
// Every git the server starts comes through here, so this is the count of
// them: what a burst of file changes costs in processes, by subcommand.
const gitProcesses = registry.counter("git_processes_total", "git processes the server started, by subcommand", [
  "command",
]);

/**
 * The subcommand in a git argv: the first word that is not an option, with
 * the values of `-c` and `-C` skipped -- `-c user.name=...` carries a
 * person's name, which has no business in a metric label.
 */
export function gitSubcommand(argv: readonly string[]): string {
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "-c" || arg === "-C") i++;
    else if (!arg.startsWith("-")) return arg;
  }
  return "other";
}

export async function runGit(
  argv: string[],
  cwd: string,
  timeoutMs: number,
  options: GitRunOptions = {},
): Promise<string> {
  const auth = options.auth ?? null;
  const authArgs = auth ? await authConfig(auth) : [];
  const ok = options.okExitCodes ?? [0];
  gitProcesses.inc({ command: gitSubcommand(argv) });
  return new Promise<string>((settle, fail) => {
    execFile(
      "git",
      // Before the subcommand, which is where `-c` has to be. `core.fsmonitor`
      // is a command git runs on every `status`, read from the repository's
      // own config -- never one the server should run on a repo's say-so.
      [
        "-c",
        "core.fsmonitor=false",
        ...authArgs,
        ...argv,
      ],
      {
        cwd,
        timeout: timeoutMs,
        maxBuffer: 8 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
          HOME: process.env.HOME ?? "/tmp",
          LANG: process.env.LANG ?? "C.UTF-8",
          GIT_TERMINAL_PROMPT: "0",
          // Left unset with a token: an empty `GIT_ASKPASS` is still a
          // configured askpass as far as git is concerned, and it takes
          // precedence over the credential helper.
          ...(auth ? { [TOKEN_ENV]: auth.token, [USERNAME_ENV]: auth.username } : { GIT_ASKPASS: "" }),
          GIT_SSH_COMMAND: "ssh -oBatchMode=yes -oStrictHostKeyChecking=accept-new",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_CONFIG_SYSTEM: "/dev/null",
          ...options.env,
          ...(options.read ? { GIT_OPTIONAL_LOCKS: "0" } : {}),
        },
      },
      (error, stdout, stderr) => {
        if (error) {
          const code = typeof error.code === "number" ? error.code : null;
          if (code !== null && ok.includes(code)) {
            settle(stdout);
            return;
          }
          // git says what went wrong on stderr and nothing useful in the
          // error itself, so the message is the one worth propagating.
          fail(new GitError(argv, code, stderr, error.message));
          return;
        }
        settle(stdout);
      },
    );
  });
}

/**
 * The `-c` settings an authenticated command runs with.
 *
 * A plain-http host has to be private, as it was when the account was saved,
 * and curl is pinned to the address that was checked so git's own lookup
 * cannot answer differently.
 */
async function authConfig(auth: GitAuth): Promise<string[]> {
  const args = ["-c", `credential.${auth.origin}.helper=${CREDENTIAL_HELPER}`];
  const url = new URL(auth.origin);
  if (url.protocol === "http:") {
    args.push("-c", "http.followRedirects=false");
    let addresses: string[];
    try {
      addresses = await checkedAddresses(url);
    } catch (error) {
      throw new RepoUrlError(error instanceof BaseUrlError ? error.message : "the git server could not be checked");
    }
    if (!url.hostname.startsWith("[")) {
      const pinned = addresses.map((a) => (a.includes(":") ? `[${a}]` : a)).join(",");
      args.push("-c", `http.curloptResolve=${url.hostname}:${url.port || "80"}:${pinned}`);
    }
  }
  return args;
}

/**
 * Transports git may be asked to use.
 *
 * A whitelist rather than a blacklist, because `ext::sh -c ...` is a valid
 * URL as far as `z.string().url()` is concerned and is a remote shell as far
 * as git is concerned. `file:` is here because a local path is how the tests
 * -- and a self-hosted mirror -- provide a repository.
 */
const ALLOWED_PROTOCOLS: ReadonlySet<string> = new Set(["https:", "http:", "ssh:", "git:", "file:"]);

/**
 * Whether `file:` may be used. Off unless asked for: every project's checkout
 * sits under one workspace root on the same disk, so a `file:` clone of a
 * neighbour's path would be a copy of somebody else's repository.
 */
function fileReposAllowed(): boolean {
  return process.env.NODE_ENV === "test" || process.env.ALLOW_FILE_REPOS === "true";
}

/** The caller handed over something that is not a repository URL git may be given. */
export class RepoUrlError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoUrlError";
  }
}

/**
 * Refuses a URL git would treat as a command rather than a location.
 *
 * `ext::sh -c whoami` parses as a perfectly good URL and runs as a perfectly
 * good shell, so the transport is checked against a whitelist. A leading
 * dash is refused for the same class of reason, even though `--` already
 * separates the options from the operands. Every place a URL from outside
 * reaches git -- a clone, a `ls-remote`, a remote being added -- goes
 * through here.
 */
export function safeRepoUrl(repoUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(repoUrl);
  } catch {
    throw new RepoUrlError(`not a valid repository URL: ${repoUrl}`);
  }
  if (!ALLOWED_PROTOCOLS.has(parsed.protocol)) {
    throw new RepoUrlError(`unsupported repository transport: ${parsed.protocol}`);
  }
  if (parsed.protocol === "file:" && !fileReposAllowed()) {
    throw new RepoUrlError("local repository paths are not allowed; set ALLOW_FILE_REPOS=true to enable them");
  }
  if (repoUrl.startsWith("-")) throw new RepoUrlError(`repository URL must not start with a dash`);
  return repoUrl;
}

