import { existsSync, mkdirSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import * as pty from "@lydell/node-pty";
import type { Command, DomainEvent } from "@ucch/protocol";
import type { ProfileRef } from "./profile-ref.js";
import type { ArgvWrapper } from "./child-priority.js";
import { commandCwd, findCommand } from "./project-commands.js";
import { sessionTree } from "./trees.js";

/**
 * A real terminal per tab, running in the project's workspace.
 *
 * This is a pseudo-terminal, not a pipe: the shell is on the controlling end
 * of a tty, so it behaves the way it does in any other terminal. Line
 * editing, tab completion, colour, ctrl-C, job control, and anything that
 * draws its own screen -- vim, top, a package manager's progress bar -- all
 * work, because none of them are being emulated. The client runs xterm.js and
 * the two speak the same protocol they would over ssh.
 *
 * **What this runs as.** The shell is the operator's own login shell, with
 * their environment and their home directory, as the user the server runs as.
 * That is deliberate and it is what makes `node`, `php`, `composer` and
 * whatever else is installed through a version manager resolve at all -- a
 * scrubbed `PATH` finds none of them. It also means a command typed here can
 * do anything that user can do. That is the same trade the agent's `bash`
 * tool already makes, gated behind the same flag: development gets it
 * unasked, production has to say so with `AGENT_ALLOW_HOST_SHELL`.
 *
 * The one thing not inherited is the harness's own secrets -- `SECRET_KEY`,
 * `DATABASE_URL`, the GitHub client secret. Those are not the user's
 * credentials, they are the server's, and `env` is one word to type. See
 * `terminalEnv`.
 */

/**
 * Terminals open at once: in one project, for one person, on the whole
 * server. Each is a shell and whatever runs in it, so the server's share is
 * bounded however many people and projects there are. Over a limit the
 * terminal says so; nothing waits for a slot. `TERMINAL_MAX_*` in config.
 */
const MAX_SESSIONS_PER_PROJECT = 10;
const MAX_SESSIONS_PER_USER = 5;
const MAX_SESSIONS_TOTAL = 40;

/** Bytes sent in one `terminal.output` event; a large paste is split, not cut. */
const MAX_EVENT_BYTES = 64 * 1024;

/**
 * A terminal with nothing typed into it for this long is closed.
 *
 * Short because of what it reclaims: leaving the project page closes its
 * terminals, but a browser tab closed outright, or a reload, drops the socket
 * without a `terminal.close` for each shell -- and a shell per abandoned page
 * would accumulate until the server restarted. Fifteen minutes is longer than
 * a pause for thought and shorter than a forgotten tab.
 */
const IDLE_TIMEOUT_MS = 15 * 60_000;

/** What a terminal opens at, before the client reports its real size. */
const DEFAULT_COLS = 80;
const DEFAULT_ROWS = 24;

interface Session {
  id: string;
  projectId: string;
  /** Who opened it. Nobody else may write to it, resize it, or close it. */
  userId: string;
  pty: pty.IPty;
  idleTimer: NodeJS.Timeout;
  /** Its OMP bridge's files and token, once written; see `TerminalOptions.ompBridge`. */
  bridge?: Promise<{ dispose(): Promise<void> } | null>;
  /** Its bridge being taken down, once that has started. */
  unbridged?: Promise<void>;
}

/** A program a terminal can run other than the shell. */
export type TerminalProgram = "shell" | "claude-login" | "codex-login" | "command";

export interface LoginLaunch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
  /** Typed into the shell once it starts: a command button's command line. */
  input?: string;
}

export interface TerminalOptions {
  workspaceRoot: string;
  /** False in production without `AGENT_ALLOW_HOST_SHELL`. */
  allowHostShell: boolean;
  /** Terminals open at once in one project, for one person, and in all. */
  maxPerProject?: number;
  maxPerUser?: number;
  maxTotal?: number;
  /** How long a terminal nobody types into stays open. */
  idleMs?: number;
  /**
   * How to start a provider's sign-in flow for this user: the CLI, its
   * arguments, and the environment that points it at the user's own
   * credential directory. Absent means login terminals are refused.
   */
  login?: (userId: string, program: Exclude<TerminalProgram, "shell" | "command">, profile?: ProfileRef) => LoginLaunch;
  /**
   * The subject's own account by id, for a sign-in terminal that names one;
   * null when it is not the subject's (or not that provider's), and the
   * terminal is refused.
   */
  profile?: (subject: string, profileId: string, provider: "claude" | "codex") => Promise<ProfileRef | null>;
  /** The pty spawner. Injected by tests; the real one otherwise. */
  spawn?: typeof pty.spawn;
  /** Rewrites a shell's argv just before it starts: its priority (child-priority.ts). */
  wrapArgv?: ArgvWrapper;
  /**
   * The folder to put first on PATH for a shell in `cwd`: the project's
   * runtime versions (runtimes/manager.ts `pathFor`). The folder's links are
   * re-pointed in place when the version changes, so an open terminal runs
   * the new one on its next command.
   */
  runtimePath?: (cwd: string) => string | null;
  /**
   * The OMP bridge for CLIs started by hand (`terminal-bridge.ts`, OM6.7):
   * a project shell gets `UCCH_OMP_MCP` = `path(...)` when it starts, and
   * `open` writes the files there just after, if the workspace has the
   * bridge on. They go when the terminal does.
   */
  ompBridge?: {
    path(subject: string, terminalId: string): string;
    open(input: {
      projectId: string;
      subject: string;
      userId: string;
      terminalId: string;
      cwd: string;
    }): Promise<{ dispose(): Promise<void> } | null>;
  };
}

/** How long a watched-but-not-yet-opened terminal id stays reserved. */
const CLAIM_TTL_MS = 5 * 60_000;

/**
 * Input held for a terminal that has not opened yet: at most this much, for
 * at most this long. Keystrokes travel outside the command queue, so the
 * first of them can arrive before the `terminal.create` that opens the shell
 * -- a moment's worth of typing, never a stream.
 */
const EARLY_INPUT_BYTES = 64 * 1024;
const EARLY_INPUT_TTL_MS = 30_000;

/** What reached a terminal before it opened. */
interface EarlyInput {
  userId: string;
  chunks: string[];
  bytes: number;
  at: number;
  /** The last size asked for, applied once the shell runs. */
  size?: { cols: number; rows: number };
}

export class TerminalReactor {
  readonly #sessions = new Map<string, Session>();
  /**
   * Terminal ids someone subscribed to before opening -- which every client
   * does, so the shell's first prompt is not lost. The first to watch an id
   * owns it: nobody else may watch it, or open a shell under it.
   */
  readonly #claims = new Map<string, { userId: string; at: number }>();
  /** Input for terminals someone has claimed but not opened yet; see `input`. */
  readonly #early = new Map<string, EarlyInput>();

  constructor(
    private readonly options: TerminalOptions,
    /** Publishes `terminal.output`, which is transient and never stored. */
    private readonly publish: (projectId: string, event: DomainEvent) => void,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  get openTerminals(): number {
    return this.#sessions.size;
  }

  react(command: Command, userId: string): void {
    switch (command.type) {
      case "terminal.create": {
        const program = command.program ?? "shell";
        const subject = command.credentialWorkspaceId ? `ws-${command.credentialWorkspaceId}` : userId;
        const open = (profile?: ProfileRef) => {
          try {
            this.#open(command.terminalId, command.projectId, userId, program, subject, command.sessionHash, command.commandId, profile);
          } catch (error) {
            this.onError(error);
          }
        };
        if (command.profileId && (program === "claude-login" || program === "codex-login")) {
          // Looked up before the shell starts; what is typed meanwhile waits
          // in `#early`, as it does for any terminal still starting.
          const provider = program === "claude-login" ? "claude" : "codex";
          void (this.options.profile?.(subject, command.profileId, provider) ?? Promise.resolve(null))
            .then((profile) => {
              if (profile) open(profile);
              else this.#say(command.projectId, command.terminalId, "That account is not one of yours, or it was deleted.\r\n");
            })
            .catch((error: unknown) => this.onError(error));
          return;
        }
        open();
        return;
      }

      case "terminal.input":
        this.input(command.terminalId, userId, command.data);
        return;

      case "terminal.resize":
        this.resize(command.terminalId, userId, command.cols, command.rows);
        return;

      case "terminal.close":
        this.close(command.terminalId, userId);
        return;

      default:
        return;
    }
  }

  /**
   * Keystrokes into a terminal. False when they went nowhere: not this
   * user's terminal, one that has ended, or more early input than is kept.
   *
   * Reached straight from the socket (`terminal_input`), not through the
   * command queue, so it can arrive before the `terminal.create` sent just
   * ahead of it. That input is kept until the shell opens -- only for the
   * user who claimed the id by watching it, which every client does first.
   */
  input(terminalId: string, userId: string, data: string): boolean {
    const session = this.#mine(terminalId, userId);
    if (session) {
      // Straight through, byte for byte. Control characters are the point:
      // ctrl-C, arrow keys and a bracketed paste are all just bytes, and
      // anything that inspected them here would be second-guessing the
      // terminal it is meant to be.
      session.pty.write(data);
      this.#touch(session);
      return true;
    }
    const early = this.#earlyFor(terminalId, userId);
    if (!early) return false;
    const bytes = Buffer.byteLength(data);
    if (early.bytes + bytes > EARLY_INPUT_BYTES) {
      // Full for good, not just for this chunk: a later, smaller one let in
      // would reach the shell with a gap before it.
      early.bytes = Infinity;
      return false;
    }
    early.chunks.push(data);
    early.bytes += bytes;
    return true;
  }

  /** A terminal's new size; like `input`, kept for a shell that has not opened yet. */
  resize(terminalId: string, userId: string, cols: number, rows: number): boolean {
    const session = this.#mine(terminalId, userId);
    if (session) {
      this.#resize(session, cols, rows);
      return true;
    }
    const early = this.#earlyFor(terminalId, userId);
    if (!early) return false;
    early.size = { cols, rows };
    return true;
  }

  /**
   * Whether `userId` may watch terminal `terminalId`'s output: its owner
   * once it runs, and before that whoever watched it first.
   */
  mayWatch(terminalId: string, userId: string): boolean {
    const session = this.#sessions.get(terminalId);
    if (session) return session.userId === userId;
    const now = Date.now();
    this.#prune(now);
    const claim = this.#claims.get(terminalId);
    if (claim) return claim.userId === userId;
    this.#claims.set(terminalId, { userId, at: now });
    return true;
  }

  /** Kills a session. Idempotent: a tab closed twice is not an error. */
  close(terminalId: string, userId?: string): void {
    const session =
      userId === undefined ? this.#sessions.get(terminalId) : this.#mine(terminalId, userId);
    if (!session) return;

    clearTimeout(session.idleTimer);
    this.#sessions.delete(terminalId);
    try {
      // SIGHUP is what a closed terminal sends, so a shell and its children
      // wind up the way they would if the window had been shut.
      session.pty.kill();
    } catch {
      /* already gone */
    }
    void this.#closeBridge(session);
  }

  /** Stop a deleted project's shells and command processes, and remove their bridge files. */
  async closeProject(projectId: string): Promise<void> {
    const sessions = [...this.#sessions.values()].filter((session) => session.projectId === projectId);
    for (const session of sessions) this.close(session.id);
    await Promise.all(sessions.map((session) => this.#closeBridge(session)));
  }

  /** Every terminal, on the way down; resolves once their bridge files are gone. */
  async closeAll(): Promise<void> {
    const sessions = [...this.#sessions.values()];
    for (const session of sessions) this.close(session.id);
    await Promise.all(sessions.map((session) => this.#closeBridge(session)));
  }

  /**
   * Deletes a terminal's bridge files and revokes its token, waiting for
   * them to be written first if they are still on the way. Every call gets
   * the same promise.
   */
  #closeBridge(session: Session): Promise<void> {
    session.unbridged ??= (async () => {
      const handle = await session.bridge;
      await handle?.dispose().catch(this.onError);
    })();
    return session.unbridged;
  }

  /**
   * Starts a terminal.
   *
   * Synchronous on purpose. The claim is released and the early input taken
   * at the top (see `input`), so an `await` here, however brief, would be a
   * window where typing had neither a buffer nor a session to go to. The one
   * blocking call is a `mkdir` on a local path.
   */
  #open(
    terminalId: string,
    projectId: string,
    userId: string,
    program: TerminalProgram,
    credentialSubject: string = userId,
    sessionHash?: string,
    commandId?: string,
    profile?: ProfileRef,
  ): void {
    if (this.#sessions.has(terminalId)) return;
    // An id somebody else is already watching would hand them this shell.
    const claim = this.#claims.get(terminalId);
    if (claim && claim.userId !== userId) return;
    this.#claims.delete(terminalId);
    // Taken here whatever happens next: a shell that does not start has no
    // use for it either.
    const early = this.#early.get(terminalId);
    this.#early.delete(terminalId);

    if (!this.options.allowHostShell) {
      this.#say(projectId, terminalId, "The terminal is disabled on this server.\r\n");
      return;
    }
    const refused = this.#overLimit(projectId, userId);
    if (refused) {
      this.#say(projectId, terminalId, `${refused} Close one to open another.\r\n`);
      return;
    }

    const launch = this.#launch(projectId, credentialSubject, program, sessionHash, commandId, profile);
    if (!launch) {
      this.#say(
        projectId,
        terminalId,
        program === "command"
          ? "That command is not in .agent/commands.json, or its working directory is outside the project.\r\n"
          : "That sign-in flow is not available on this server.\r\n",
      );
      return;
    }
    const bridged = program === "shell" || program === "command" ? this.options.ompBridge : undefined;
    if (bridged) launch.env.UCCH_OMP_MCP = bridged.path(credentialSubject, terminalId);

    const [file, ...args] = this.options.wrapArgv?.(launch.argv, launch.env, launch.cwd) ?? launch.argv;
    const child = (this.options.spawn ?? pty.spawn)(file!, args, {
      name: "xterm-256color",
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd: launch.cwd,
      env: launch.env,
    });

    const session: Session = {
      id: terminalId,
      projectId,
      userId,
      pty: child,
      idleTimer: setTimeout(() => this.close(terminalId), this.#idleMs),
    };
    session.idleTimer.unref();
    this.#sessions.set(terminalId, session);
    if (bridged) {
      session.bridge = bridged
        .open({ projectId, subject: credentialSubject, userId, terminalId, cwd: launch.cwd })
        .catch((error: unknown) => {
          this.onError(error);
          return null;
        });
    }

    child.onData((data) => {
      // Split rather than truncated: a chunk cut in half mid-escape-sequence
      // would leave the client's parser waiting for the rest of a sequence
      // that never comes, and the screen wrong from then on.
      for (let at = 0; at < data.length; at += MAX_EVENT_BYTES) {
        this.#say(projectId, terminalId, data.slice(at, at + MAX_EVENT_BYTES));
      }
    });

    child.onExit(({ exitCode, signal }) => {
      clearTimeout(session.idleTimer);
      this.#sessions.delete(terminalId);
      void this.#closeBridge(session);
      const how = signal ? `signal ${signal}` : `code ${exitCode}`;
      this.#say(projectId, terminalId, `\r\n\x1b[2m[exited with ${how}]\x1b[0m\r\n`);
    });

    // A command button's command, typed at the prompt as if by hand: the
    // shell stays afterwards, to read the output, ctrl-C it, or run it again.
    if (launch.input) child.write(launch.input);

    // What was typed while the shell was starting, at the size the screen
    // had by then.
    if (early && early.userId === userId && Date.now() - early.at <= EARLY_INPUT_TTL_MS) {
      if (early.size) this.#resize(session, early.size.cols, early.size.rows);
      for (const chunk of early.chunks) child.write(chunk);
    }
  }

  /**
   * What to start.
   *
   * The shell runs in the workspace. A login program runs the vendor CLI's
   * own sign-in -- `claude auth login`, `codex login --device-auth` -- in the
   * user's credential directory, so what it writes lands where every later
   * turn reads it. The browser cannot reach a callback on this machine, so
   * the CLI shows the code-paste prompt, which is the documented path for a
   * box whose browser is elsewhere, and exactly what a terminal is for.
   */
  #launch(
    projectId: string,
    userId: string,
    program: TerminalProgram,
    sessionHash?: string,
    commandId?: string,
    profile?: ProfileRef,
  ): LoginLaunch | null {
    if (program !== "shell" && program !== "command") {
      return this.options.login?.(userId, program, profile) ?? null;
    }
    // The command line comes from the project's own file, read now: the
    // client named a button, nothing more. Read from the main checkout,
    // which is where the app's Manage dialog writes it.
    const command =
      program === "command" && commandId ? findCommand(join(this.options.workspaceRoot, projectId), commandId) : null;
    if (program === "command" && !command) return null;

    // A session's worktree, when it has one. The path is under this
    // project's own folder of worktrees, so a hash from another project
    // simply is not there -- and falls back to the project's checkout.
    const tree = sessionHash ? sessionTree(this.options.workspaceRoot, projectId, sessionHash) : null;
    const cwd = tree && existsSync(join(tree, ".git")) ? tree : join(this.options.workspaceRoot, projectId);
    // The clone reactor usually made this; a project created before it did,
    // or one whose clone failed, still gets a directory to stand in.
    mkdirSync(cwd, { recursive: true });

    // A login shell, so the profile that sets up nvm, asdf, pyenv, Homebrew
    // or a distribution's own PATH actually runs. Without `-l` the terminal
    // has whatever the *service manager* had, which is how "node: command
    // not found" happens in a terminal where node is plainly installed.
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(terminalEnv())) if (value !== undefined) env[name] = value;
    env.UCCH_ROOT = cwd;
    const runtimes = this.options.runtimePath?.(cwd);
    if (runtimes) {
      env.PATH = env.PATH ? `${runtimes}:${env.PATH}` : runtimes;
      // A login shell's profile may set PATH from scratch (/etc/profile does
      // on many distributions): the rc files put this back in front after.
      env.UCCH_RUNTIME_PATH = runtimes;
    }
    if (command) {
      const at = commandCwd(cwd, command.cwd);
      if (!at) return null;
      // The shell's startup file goes to UCCH_ROOT whatever the spawn cwd was,
      // so a subfolder is a `cd` typed first. `./` keeps it from reading as an
      // option; single quotes, escaped as every shell here reads them.
      const sub = relative(realpathSync(cwd), at);
      const cd = sub ? `cd '${`./${sub}`.replace(/'/g, "'\\''")}' && ` : "";
      return { argv: shellArgv(loginShell()), cwd: at, env, input: `${cd}${command.command}\r` };
    }
    return { argv: shellArgv(loginShell()), cwd, env };
  }

  /** The session, if it is this user's. Anyone else gets nothing. */
  #mine(terminalId: string, userId: string): Session | undefined {
    const session = this.#sessions.get(terminalId);
    if (!session) return undefined;
    // A terminal id is a uuid the client minted, so guessing one is not a
    // realistic attack -- but a shell on the host is not the place to rely on
    // that.
    return session.userId === userId ? session : undefined;
  }

  /**
   * The early input held for an id `userId` has claimed and nobody has
   * opened yet, started on first use. Undefined when the id is not theirs.
   */
  #earlyFor(terminalId: string, userId: string): EarlyInput | undefined {
    const now = Date.now();
    this.#prune(now);
    const claim = this.#claims.get(terminalId);
    if (!claim || claim.userId !== userId) return undefined;
    let early = this.#early.get(terminalId);
    if (!early) {
      early = { userId, chunks: [], bytes: 0, at: now };
      this.#early.set(terminalId, early);
    }
    return early;
  }

  /** Forgets claims and early input that were never followed by a shell. */
  #prune(now: number): void {
    for (const [id, claim] of this.#claims) if (now - claim.at > CLAIM_TTL_MS) this.#claims.delete(id);
    for (const [id, early] of this.#early) if (now - early.at > EARLY_INPUT_TTL_MS) this.#early.delete(id);
  }

  #resize(session: Session, cols: number, rows: number): void {
    try {
      // Bounded because these numbers come from a client: a pty asked for a
      // preposterous size throws, and a zero-column one makes the shell
      // divide by it.
      session.pty.resize(
        Math.min(1000, Math.max(1, Math.floor(cols))),
        Math.min(1000, Math.max(1, Math.floor(rows))),
      );
    } catch (error) {
      // A resize racing the exit is ordinary and not worth failing over.
      this.onError(error);
    }
  }

  #touch(session: Session): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => this.close(session.id), this.#idleMs);
    session.idleTimer.unref();
  }

  get #idleMs(): number {
    return this.options.idleMs ?? IDLE_TIMEOUT_MS;
  }

  /** Which limit one more terminal would go over, as the terminal says it; null when none. */
  #overLimit(projectId: string, userId: string): string | null {
    const open = [...this.#sessions.values()];
    const perProject = this.options.maxPerProject ?? MAX_SESSIONS_PER_PROJECT;
    const perUser = this.options.maxPerUser ?? MAX_SESSIONS_PER_USER;
    const total = this.options.maxTotal ?? MAX_SESSIONS_TOTAL;
    if (open.filter((s) => s.projectId === projectId).length >= perProject) {
      return `This project already has ${perProject} terminals open, its limit.`;
    }
    if (open.filter((s) => s.userId === userId).length >= perUser) {
      return `You already have ${perUser} terminals open, the most one person can.`;
    }
    if (open.length >= total) return `The server already has ${total} terminals open, its limit.`;
    return null;
  }

  #say(projectId: string, terminalId: string, data: string): void {
    this.publish(projectId, { type: "terminal.output", projectId, terminalId, data });
  }
}

/** Where fish lives on the systems the harness runs on. */
const FISH_PATHS = ["/usr/bin/fish", "/usr/local/bin/fish", "/opt/homebrew/bin/fish"];

/**
 * The shell to start.
 *
 * `TERMINAL_SHELL` pins it outright. Otherwise fish, when it is installed:
 * `$SHELL` is whatever launched the server -- an editor's integrated
 * terminal, a tool runner -- not a choice anyone made for this terminal, and
 * it brought in that shell's rc files (a random oh-my-zsh theme on every new
 * tab). `$SHELL` and then bash remain the fallbacks for a host without fish,
 * like the production image. Not `sh`: the point is a shell with a prompt
 * and completions.
 */
export function loginShell(
  env: NodeJS.ProcessEnv = process.env,
  exists: (path: string) => boolean = existsSync,
): string {
  if (env.TERMINAL_SHELL) return env.TERMINAL_SHELL;
  const fish = FISH_PATHS.find(exists);
  return fish ?? (env.SHELL || "/bin/bash");
}

/** The scripts that keep a shell inside its project; see `shell/ucch.fish`. */
const FISH_INIT = fileURLToPath(new URL("./shell/ucch.fish", import.meta.url));
const BASH_RC = fileURLToPath(new URL("./shell/ucch.bashrc", import.meta.url));

/**
 * The command line that starts `shell` in a project, kept to its folder.
 *
 * fish sources the guard after the user's own config, so its prompt is the
 * one in play; bash takes it as `--rcfile`, which sources the login profile
 * itself. Any other shell -- one pinned with `TERMINAL_SHELL` -- starts as a
 * plain login shell in the folder.
 */
export function shellArgv(shell: string): string[] {
  switch (basename(shell)) {
    case "fish":
      return [shell, "-l", "-C", `source ${fishQuote(FISH_INIT)}`];
    case "bash":
      return [shell, "--rcfile", BASH_RC, "-i"];
    default:
      return [shell, "-l"];
  }
}

function fishQuote(text: string): string {
  return `'${text.replace(/[\\']/g, "\\$&")}'`;
}

/**
 * Names the terminal must not inherit.
 *
 * The harness's own credentials, not the user's. A terminal is the user's
 * shell and should look like it -- their `PATH`, their `NVM_DIR`, their
 * editor -- but the process it is forked from is a server holding a database
 * URL, an encryption key and an OAuth client secret, and `env` is one word to
 * type. The patterns catch the ones a deployment adds later without anyone
 * remembering to come back here.
 */
const SECRET_NAMES = new Set([
  "DATABASE_URL",
  "SECRET_KEY",
  "GITHUB_CLIENT_ID",
  "GITHUB_CLIENT_SECRET",
  "ANTHROPIC_API_KEY",
  "DEFAULT_USER_EMAIL",
  "DEFAULT_USER_PASSWORD",
]);

const SECRET_PATTERN = /SECRET|PASSWORD|CREDENTIAL|_TOKEN|TOKEN_|^TOKEN$|API_KEY|PRIVATE_KEY/i;

/** Whether a variable is the server's business rather than the user's. */
export function isSecretName(name: string): boolean {
  return SECRET_NAMES.has(name) || SECRET_PATTERN.test(name);
}

/**
 * The environment a terminal gets: the operator's, minus the harness's
 * secrets, plus the terminal's own settings.
 *
 * Inherited rather than rebuilt, which is the change that makes `node` and
 * `php` work. A hand-built `PATH` finds only what a distribution put in
 * `/usr/bin`, and every version manager -- which is how most people have
 * their toolchain -- lives somewhere else entirely.
 */
export function terminalEnv(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(source)) {
    if (value === undefined) continue;
    if (isSecretName(name)) continue;
    env[name] = value;
  }

  // The user's real home, so their profile, their shell history and their
  // tool configuration are the ones in play. Pointing HOME at the workspace
  // would keep dotfiles out of it and cost the user every setting they have.
  env.HOME = source.HOME || homedir();
  env.TERM = "xterm-256color";
  env.COLORTERM = "truecolor";
  env.LANG = source.LANG || "C.UTF-8";
  // Says which harness a script is running under, and is how a prompt or an
  // rc file can tell.
  env.TERM_PROGRAM = "ucch";

  return env;
}
