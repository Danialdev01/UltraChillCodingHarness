import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import * as pty from "@lydell/node-pty";
import type { Command, DomainEvent } from "@ucch/protocol";

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

/** Terminals one project may have open at once. */
const MAX_SESSIONS_PER_PROJECT = 10;

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
}

/** A program a terminal can run other than the shell. */
export type TerminalProgram = "shell" | "claude-login" | "codex-login";

export interface LoginLaunch {
  argv: string[];
  cwd: string;
  env: Record<string, string>;
}

export interface TerminalOptions {
  workspaceRoot: string;
  /** False in production without `AGENT_ALLOW_HOST_SHELL`. */
  allowHostShell: boolean;
  /**
   * How to start a provider's sign-in flow for this user: the CLI, its
   * arguments, and the environment that points it at the user's own
   * credential directory. Absent means login terminals are refused.
   */
  login?: (userId: string, program: Exclude<TerminalProgram, "shell">) => LoginLaunch;
  /** The pty spawner. Injected by tests; the real one otherwise. */
  spawn?: typeof pty.spawn;
}

export class TerminalReactor {
  readonly #sessions = new Map<string, Session>();

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
      case "terminal.create":
        try {
          this.#open(command.terminalId, command.projectId, userId, command.program ?? "shell");
        } catch (error) {
          this.onError(error);
        }
        return;

      case "terminal.input": {
        const session = this.#mine(command.terminalId, userId);
        if (!session) return;
        // Straight through, byte for byte. Control characters are the point:
        // ctrl-C, arrow keys and a bracketed paste are all just bytes, and
        // anything that inspected them here would be second-guessing the
        // terminal it is meant to be.
        session.pty.write(command.data);
        this.#touch(session);
        return;
      }

      case "terminal.resize": {
        const session = this.#mine(command.terminalId, userId);
        if (!session) return;
        try {
          // Bounded because these numbers come from a client: a pty asked
          // for a preposterous size throws, and a zero-column one makes the
          // shell divide by it.
          session.pty.resize(
            Math.min(1000, Math.max(1, Math.floor(command.cols))),
            Math.min(1000, Math.max(1, Math.floor(command.rows))),
          );
        } catch (error) {
          // A resize racing the exit is ordinary and not worth failing over.
          this.onError(error);
        }
        return;
      }

      case "terminal.close":
        this.close(command.terminalId, userId);
        return;

      default:
        return;
    }
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
  }

  /** Every terminal, on the way down. */
  closeAll(): void {
    for (const id of [...this.#sessions.keys()]) this.close(id);
  }

  /**
   * Starts a terminal.
   *
   * Synchronous on purpose. `terminal.input` for a session that is not in the
   * map yet is dropped, and the client sends the first keystrokes the moment
   * the tab opens -- so an `await` here, however brief, is a window where
   * typing goes nowhere. The one blocking call is a `mkdir` on a local path.
   */
  #open(terminalId: string, projectId: string, userId: string, program: TerminalProgram): void {
    if (this.#sessions.has(terminalId)) return;

    if (!this.options.allowHostShell) {
      this.#say(projectId, terminalId, "The terminal is disabled on this server.\r\n");
      return;
    }
    const open = [...this.#sessions.values()].filter((s) => s.projectId === projectId).length;
    if (open >= MAX_SESSIONS_PER_PROJECT) {
      this.#say(projectId, terminalId, "Too many terminals are open in this project.\r\n");
      return;
    }

    const launch = this.#launch(projectId, userId, program);
    if (!launch) {
      this.#say(projectId, terminalId, "That sign-in flow is not available on this server.\r\n");
      return;
    }

    const [file, ...args] = launch.argv;
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
      idleTimer: setTimeout(() => this.close(terminalId), IDLE_TIMEOUT_MS),
    };
    session.idleTimer.unref();
    this.#sessions.set(terminalId, session);

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
      const how = signal ? `signal ${signal}` : `code ${exitCode}`;
      this.#say(projectId, terminalId, `\r\n\x1b[2m[exited with ${how}]\x1b[0m\r\n`);
    });
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
  #launch(projectId: string, userId: string, program: TerminalProgram): LoginLaunch | null {
    if (program !== "shell") {
      return this.options.login?.(userId, program) ?? null;
    }

    // The clone reactor usually made this; a project created before it did,
    // or one whose clone failed, still gets a directory to stand in.
    const cwd = join(this.options.workspaceRoot, projectId);
    mkdirSync(cwd, { recursive: true });

    // A login shell, so the profile that sets up nvm, asdf, pyenv, Homebrew
    // or a distribution's own PATH actually runs. Without `-l` the terminal
    // has whatever the *service manager* had, which is how "node: command
    // not found" happens in a terminal where node is plainly installed.
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(terminalEnv())) if (value !== undefined) env[name] = value;
    return { argv: [loginShell(), "-l"], cwd, env };
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

  #touch(session: Session): void {
    clearTimeout(session.idleTimer);
    session.idleTimer = setTimeout(() => this.close(session.id), IDLE_TIMEOUT_MS);
    session.idleTimer.unref();
  }

  #say(projectId: string, terminalId: string, data: string): void {
    this.publish(projectId, { type: "terminal.output", projectId, terminalId, data });
  }
}

/**
 * The shell to start.
 *
 * `$SHELL` is the one the operator chose; the fallback chain is for a service
 * manager that does not set it. Not `sh`: the point is the shell they
 * actually use, with their prompt and their completions.
 */
export function loginShell(env: NodeJS.ProcessEnv = process.env): string {
  return env.SHELL || "/bin/bash";
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
