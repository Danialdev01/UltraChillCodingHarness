import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { isSecretName, loginShell, shellArgv, terminalEnv, TerminalReactor } from "./terminals.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const TERMINAL = "77777777-7777-7777-7777-777777777777";
const USER = "11111111-1111-1111-1111-111111111111";
const OTHER = "22222222-2222-2222-2222-222222222222";

let root: string;
let output: string[];
let reactor: TerminalReactor;

/** Everything the terminal has printed so far, as one string. */
const printed = () => output.join("");

/** Waits for the shell to print something matching, or gives up. */
async function until(pattern: RegExp, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pattern.test(printed())) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timed out waiting for ${pattern} in: ${JSON.stringify(printed())}`);
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-term-"));
  output = [];
  // Bash, not the fish the server prefers: fish queries the terminal at
  // startup and waits for an answer xterm.js gives and this bare pty never
  // will.
  vi.stubEnv("TERMINAL_SHELL", "/bin/bash");

  // Bound to *this* array rather than to the `output` variable: a shell
  // killed in `afterEach` reports its exit a moment later, and a closure over
  // the binding would push that into the next test's output.
  const sink = output;
  reactor = new TerminalReactor({ workspaceRoot: root, allowHostShell: true }, (_project, event) => {
    if (event.type === "terminal.output") sink.push(event.data);
  });
});

afterEach(async () => {
  vi.unstubAllEnvs();
  reactor.closeAll();
  await rm(root, { recursive: true, force: true });
});

const create = (): DomainEvent[] => {
  reactor.react(
    { type: "terminal.create", projectId: PROJECT, terminalId: TERMINAL, cols: 80, rows: 24 },
    USER,
  );
  return [];
};

const type = (data: string, user = USER) =>
  reactor.react({ type: "terminal.input", terminalId: TERMINAL, data }, user);

describe("a terminal session", () => {
  it("runs commands in the project's own workspace", async () => {
    create();
    type("pwd\n");
    await until(/ucch-term/);

    // The shell's cwd is the project directory, not the server's.
    expect(printed()).toContain(join(root, PROJECT));
  }, 20_000);

  it("keeps its state between commands, which is what makes it a shell", async () => {
    await writeFile(join(root, PROJECT, ".keep"), "").catch(() => {});
    create();
    type("mkdir -p sub && cd sub\n");
    // The tty echoes what was typed, so a marker only the *output* can carry
    // is what says the command ran rather than that it was received.
    type("echo where=$PWD=end\n");
    await until(/where=\/.*=end/);

    expect(printed()).toMatch(/where=.*\/sub=end/);
  }, 20_000);

  it("reports a command that fails rather than swallowing it", async () => {
    create();
    type("definitely-not-a-command\n");
    await until(/not found/);
    expect(printed()).toMatch(/definitely-not-a-command.*not found/s);
  }, 20_000);

  it("keeps cd inside the project folder", async () => {
    create();
    // `cd ..` from the top, then a path outside, then a bare `cd` from a
    // subfolder: all three end at the project.
    type("cd ..; echo up=$?=$PWD=end\n");
    await until(/up=\d=\/.*=end/);
    type("cd /; echo abs=$?=$PWD=end\n");
    await until(/abs=\d=\/.*=end/);
    type("mkdir -p sub && cd sub && cd; echo home=$PWD=end\n");
    await until(/home=\/.*=end/);

    const project = join(root, PROJECT);
    expect(printed()).toContain(`up=1=${project}=end`);
    expect(printed()).toContain(`abs=1=${project}=end`);
    expect(printed()).toContain(`home=${project}=end`);
    expect(printed()).toContain("only the project folder is reachable");
  }, 20_000);

  it("shows the path from the project, not from /", async () => {
    create();
    type("mkdir -p src && cd src\n");
    await until(/@\S+ src> /);
    // `user@host`, then the path from the project or nothing at all. (A
    // profile may still put the real path in the window title, which is an
    // escape sequence, not prompt text: `@host:/path`, no space.)
    expect(printed()).toMatch(/@\S+> /);
    expect(printed()).not.toMatch(/@\S+ \/\S*> /);
  }, 20_000);

  it("closes the shell, and says so", async () => {
    create();
    type("echo alive\n");
    await until(/alive/);
    expect(reactor.openTerminals).toBe(1);

    reactor.react({ type: "terminal.close", terminalId: TERMINAL }, USER);
    expect(reactor.openTerminals).toBe(0);
  }, 20_000);

  it("refuses input from anyone but the person who opened it", async () => {
    create();
    type("echo mine\n");
    await until(/mine/);

    // Not byte equality: a real terminal keeps redrawing its prompt and
    // writing title escapes, so the question is whether their command ran.
    type("echo theirs\n", OTHER);
    await new Promise((r) => setTimeout(r, 500));
    expect(printed()).not.toMatch(/theirs/);

    // And cannot be closed by them either.
    reactor.react({ type: "terminal.close", terminalId: TERMINAL }, OTHER);
    expect(reactor.openTerminals).toBe(1);
  }, 20_000);

  it("says the terminal is off rather than starting a shell, when it is", async () => {
    const sink = output;
    const off = new TerminalReactor(
      { workspaceRoot: root, allowHostShell: false },
      (_project, event) => {
        if (event.type === "terminal.output") sink.push(event.data);
      },
    );
    off.react(
      { type: "terminal.create", projectId: PROJECT, terminalId: TERMINAL, cols: 80, rows: 24 },
      USER,
    );
    await until(/disabled/);
    expect(off.openTerminals).toBe(0);
  }, 20_000);
});

describe("what a real terminal can do that a pipe could not", () => {
  it("gives the shell a tty, which is what every interactive tool checks", async () => {
    // `test -t 0` is the check behind coloured output, progress bars, and
    // every prompt that asks a question. Over pipes it is false, and tools
    // silently switch to their dumb mode.
    create();
    type("test -t 0 && echo HAS_TTY\n");
    await until(/HAS_TTY/);
    expect(printed()).toMatch(/HAS_TTY/);
  }, 20_000);

  it("reports the size it was resized to", async () => {
    create();
    reactor.react({ type: "terminal.resize", terminalId: TERMINAL, cols: 120, rows: 40 }, USER);
    type("echo cols=$(tput cols) rows=$(tput lines)\n");
    await until(/cols=\d+/);

    expect(printed()).toMatch(/cols=120 rows=40/);
  }, 20_000);

  it("refuses a resize from anyone but the person who opened it", async () => {
    create();
    reactor.react({ type: "terminal.resize", terminalId: TERMINAL, cols: 120, rows: 40 }, USER);
    reactor.react({ type: "terminal.resize", terminalId: TERMINAL, cols: 20, rows: 5 }, OTHER);
    type("echo cols=$(tput cols)\n");
    await until(/cols=\d+/);

    expect(printed()).toMatch(/cols=120/);
  }, 20_000);

  it("survives a size no terminal could have", async () => {
    // These numbers come from a client, and a pty asked for zero columns
    // makes the shell divide by it.
    create();
    reactor.react({ type: "terminal.resize", terminalId: TERMINAL, cols: 0, rows: 0 }, USER);
    reactor.react({ type: "terminal.resize", terminalId: TERMINAL, cols: 1e9, rows: 1e9 }, USER);
    type("echo survived\n");
    await until(/survived/);
  }, 20_000);

  it("passes control characters through, so ctrl-C interrupts", async () => {
    create();
    type("sleep 30\n");
    await new Promise((r) => setTimeout(r, 500));
    // \x03 is ctrl-C. A pipe has no way to deliver this at all: there is no
    // line discipline to turn it into a signal.
    type("\x03");
    type("echo interrupted\n");
    await until(/interrupted/);
  }, 20_000);
});

describe("the environment a terminal is given", () => {
  it("keeps the user's PATH, which is how node and php are found at all", () => {
    // A hand-built PATH finds only what a distribution put in /usr/bin, and
    // every version manager lives somewhere else entirely.
    const env = terminalEnv({ PATH: "/home/me/.nvm/versions/node/v22/bin:/usr/bin", HOME: "/home/me" });
    expect(env.PATH).toBe("/home/me/.nvm/versions/node/v22/bin:/usr/bin");
  });

  it("keeps the user's own home, so their profile and tools are the ones in play", () => {
    expect(terminalEnv({ HOME: "/home/me" }).HOME).toBe("/home/me");
  });

  it("declares a colour terminal", () => {
    const env = terminalEnv({});
    expect(env.TERM).toBe("xterm-256color");
    expect(env.COLORTERM).toBe("truecolor");
  });

  it("does not hand over the harness's own credentials", () => {
    const env = terminalEnv({
      PATH: "/usr/bin",
      DATABASE_URL: "postgres://user:pw@host/db",
      SECRET_KEY: "0".repeat(64),
      GITHUB_CLIENT_SECRET: "ghs_xxx",
      DEFAULT_USER_PASSWORD: "hunter2",
      ANTHROPIC_API_KEY: "sk-ant-xxx",
    });

    expect(env.PATH).toBe("/usr/bin");
    for (const name of [
      "DATABASE_URL",
      "SECRET_KEY",
      "GITHUB_CLIENT_SECRET",
      "DEFAULT_USER_PASSWORD",
      "ANTHROPIC_API_KEY",
    ]) {
      expect(env[name], name).toBeUndefined();
    }
  });

  it("catches a secret a later deployment adds without editing this file", () => {
    expect(isSecretName("STRIPE_SECRET_KEY")).toBe(true);
    expect(isSecretName("SOME_API_KEY")).toBe(true);
    expect(isSecretName("SLACK_TOKEN_B")).toBe(true);
    expect(isSecretName("DB_PASSWORD")).toBe(true);
  });

  it("does not strip the ordinary variables a shell needs", () => {
    for (const name of ["PATH", "HOME", "SHELL", "LANG", "TERM", "NVM_DIR", "EDITOR", "USER"]) {
      expect(isSecretName(name), name).toBe(false);
    }
  });
});

describe("which shell is started", () => {
  const noFish = () => false;
  const fishAt = (at: string) => (path: string) => path === at;

  it("is the one TERMINAL_SHELL pins", () => {
    expect(loginShell({ TERMINAL_SHELL: "/bin/zsh" }, fishAt("/usr/bin/fish"))).toBe("/bin/zsh");
  });

  it("is fish when it is installed, whatever SHELL the server inherited", () => {
    expect(loginShell({ SHELL: "/usr/bin/zsh" }, fishAt("/usr/bin/fish"))).toBe("/usr/bin/fish");
    expect(loginShell({}, fishAt("/opt/homebrew/bin/fish"))).toBe("/opt/homebrew/bin/fish");
  });

  it("is SHELL on a host without fish", () => {
    expect(loginShell({ SHELL: "/usr/bin/zsh" }, noFish)).toBe("/usr/bin/zsh");
  });

  it("falls back when a service manager sets no SHELL", () => {
    expect(loginShell({}, noFish)).toBe("/bin/bash");
  });
});

describe("how a shell is started", () => {
  it("keeps fish and bash to the project with their init scripts", () => {
    const fish = shellArgv("/usr/bin/fish");
    expect(fish.slice(0, 3)).toEqual(["/usr/bin/fish", "-l", "-C"]);
    expect(fish[3]).toMatch(/^source '.*\/shell\/ucch\.fish'$/);

    expect(shellArgv("/bin/bash")).toEqual([
      "/bin/bash",
      "--rcfile",
      expect.stringMatching(/\/shell\/ucch\.bashrc$/),
      "-i",
    ]);
  });

  it("starts any other shell as a plain login shell", () => {
    expect(shellArgv("/usr/bin/zsh")).toEqual(["/usr/bin/zsh", "-l"]);
  });
});

describe("a login terminal", () => {
  /** A pty double that records what it was asked to start and stays quiet. */
  function fakeSpawn() {
    const calls: { file: string; args: string[]; cwd: string; env: Record<string, string> }[] = [];
    const spawn = ((file: string, args: string[], options: { cwd: string; env: Record<string, string> }) => {
      calls.push({ file, args, cwd: options.cwd, env: options.env });
      return {
        write() {},
        resize() {},
        kill() {},
        onData() {},
        onExit() {},
      };
    }) as unknown as typeof import("@lydell/node-pty").spawn;
    return { calls, spawn };
  }

  it("runs the provider's own sign-in against the user's credential directory", () => {
    const { calls, spawn } = fakeSpawn();
    const sink: string[] = [];
    const login = new TerminalReactor(
      {
        workspaceRoot: root,
        allowHostShell: true,
        spawn,
        login: (userId, program) => ({
          argv: program === "claude-login" ? ["claude", "auth", "login"] : ["codex", "login", "--device-auth"],
          cwd: `/creds/${userId}/claude`,
          env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: `/creds/${userId}/claude` },
        }),
      },
      (_project, event) => {
        if (event.type === "terminal.output") sink.push(event.data);
      },
    );
    login.react(
      { type: "terminal.create", projectId: PROJECT, terminalId: TERMINAL, cols: 80, rows: 24, program: "claude-login" },
      USER,
    );
    expect(calls).toEqual([
      {
        file: "claude",
        args: ["auth", "login"],
        cwd: `/creds/${USER}/claude`,
        env: { PATH: "/usr/bin", CLAUDE_CONFIG_DIR: `/creds/${USER}/claude` },
      },
    ]);
    expect(login.openTerminals).toBe(1);
    login.closeAll();
  });

  it("still starts the shell in the workspace when no program is named", () => {
    const { calls, spawn } = fakeSpawn();
    const plain = new TerminalReactor({ workspaceRoot: root, allowHostShell: true, spawn }, () => {});
    plain.react({ type: "terminal.create", projectId: PROJECT, terminalId: TERMINAL, cols: 80, rows: 24 }, USER);
    expect(calls[0]?.args).toEqual(shellArgv("/bin/bash").slice(1));
    expect(calls[0]?.cwd).toBe(join(root, PROJECT));
    expect(calls[0]?.env.UCCH_ROOT).toBe(join(root, PROJECT));
    plain.closeAll();
  });

  it("says so when the server has no sign-in flow to offer", () => {
    const { calls, spawn } = fakeSpawn();
    const sink: string[] = [];
    const none = new TerminalReactor({ workspaceRoot: root, allowHostShell: true, spawn }, (_p, event) => {
      if (event.type === "terminal.output") sink.push(event.data);
    });
    none.react(
      { type: "terminal.create", projectId: PROJECT, terminalId: TERMINAL, cols: 80, rows: 24, program: "codex-login" },
      USER,
    );
    expect(calls).toEqual([]);
    expect(sink.join("")).toMatch(/not available/);
  });
});

describe("who may watch a terminal", () => {
  it("reserves an unopened id for whoever watches it first", () => {
    expect(reactor.mayWatch(TERMINAL, USER)).toBe(true);
    expect(reactor.mayWatch(TERMINAL, OTHER)).toBe(false);
    expect(reactor.mayWatch(TERMINAL, USER)).toBe(true);
  });

  it("lets only the owner watch a running shell", () => {
    create();
    expect(reactor.mayWatch(TERMINAL, USER)).toBe(true);
    expect(reactor.mayWatch(TERMINAL, OTHER)).toBe(false);
  });

  it("will not open a shell under an id someone else is watching", () => {
    expect(reactor.mayWatch(TERMINAL, OTHER)).toBe(true);
    create();
    expect(reactor.openTerminals).toBe(0);
  });
});

describe("input that arrives before the shell", () => {
  /** A pty double that records what was written to it and at what size. */
  function recordingSpawn() {
    const log: string[] = [];
    const spawn = (() => ({
      write(data: string) {
        log.push(`write ${data}`);
      },
      resize(cols: number, rows: number) {
        log.push(`resize ${cols}x${rows}`);
      },
      kill() {},
      onData() {},
      onExit() {},
    })) as unknown as typeof import("@lydell/node-pty").spawn;
    return { log, spawn };
  }

  let log: string[];
  let early: TerminalReactor;
  const open = (user = USER) =>
    early.react({ type: "terminal.create", projectId: PROJECT, terminalId: TERMINAL, cols: 80, rows: 24 }, user);

  beforeEach(() => {
    const recording = recordingSpawn();
    log = recording.log;
    early = new TerminalReactor({ workspaceRoot: root, allowHostShell: true, spawn: recording.spawn }, () => {});
  });

  afterEach(() => {
    vi.useRealTimers();
    early.closeAll();
  });

  it("is kept for whoever claimed the terminal, and written once it opens, in order", () => {
    expect(early.mayWatch(TERMINAL, USER)).toBe(true);
    expect(early.input(TERMINAL, USER, "l")).toBe(true);
    expect(early.input(TERMINAL, USER, "s\r")).toBe(true);
    expect(log).toEqual([]);
    open();
    expect(log).toEqual(["write l", "write s\r"]);
  });

  it("applies the last size asked for before the input", () => {
    early.mayWatch(TERMINAL, USER);
    expect(early.resize(TERMINAL, USER, 100, 30)).toBe(true);
    early.input(TERMINAL, USER, "x");
    expect(early.resize(TERMINAL, USER, 132, 40)).toBe(true);
    open();
    expect(log).toEqual(["resize 132x40", "write x"]);
  });

  it("refuses another user's, and an id nobody has claimed", () => {
    early.mayWatch(TERMINAL, USER);
    expect(early.input(TERMINAL, OTHER, "rm -rf ~\r")).toBe(false);
    expect(early.resize(TERMINAL, OTHER, 10, 10)).toBe(false);
    expect(early.input("88888888-8888-8888-8888-888888888888", USER, "x")).toBe(false);
    open();
    expect(log).toEqual([]);
  });

  it("holds at most 64 KB, and nothing after the first chunk past it", () => {
    early.mayWatch(TERMINAL, USER);
    expect(early.input(TERMINAL, USER, "a".repeat(60 * 1024))).toBe(true);
    expect(early.input(TERMINAL, USER, "b".repeat(8 * 1024))).toBe(false);
    // Would fit, but the shell would see it without what came before it.
    expect(early.input(TERMINAL, USER, "c")).toBe(false);
    open();
    expect(log).toEqual([`write ${"a".repeat(60 * 1024)}`]);
  });

  it("is dropped when the shell takes longer than 30 s to open", () => {
    vi.useFakeTimers();
    early.mayWatch(TERMINAL, USER);
    early.input(TERMINAL, USER, "late");
    vi.advanceTimersByTime(31_000);
    open();
    expect(log).toEqual([]);
  });

  it("goes straight to a shell that is already open, and nowhere once it is someone else's", () => {
    early.mayWatch(TERMINAL, USER);
    open();
    expect(early.input(TERMINAL, USER, "x")).toBe(true);
    expect(early.resize(TERMINAL, USER, 90, 20)).toBe(true);
    expect(early.input(TERMINAL, OTHER, "y")).toBe(false);
    expect(log).toEqual(["write x", "resize 90x20"]);
  });
});

describe("how many terminals may be open", () => {
  const PROJECTS = ["a", "b", "c"].map((c) => `${c.repeat(8)}-0000-0000-0000-000000000000`);
  const THIRD = "33333333-0000-0000-0000-000000000000";

  /** A reactor whose shells are doubles; what each terminal printed, by id. */
  function capped(limits: { maxPerProject?: number; maxPerUser?: number; maxTotal?: number; idleMs?: number }) {
    const said = new Map<string, string>();
    let spawned = 0;
    let killed = 0;
    const spawn = (() => {
      spawned++;
      return {
        write() {},
        resize() {},
        kill() {
          killed++;
        },
        onData() {},
        onExit() {},
      };
    }) as unknown as typeof import("@lydell/node-pty").spawn;
    const terminals = new TerminalReactor(
      { workspaceRoot: root, allowHostShell: true, spawn, ...limits },
      (_project, event) => {
        if (event.type === "terminal.output") said.set(event.terminalId, (said.get(event.terminalId) ?? "") + event.data);
      },
    );
    let n = 0;
    const open = (projectId: string, userId: string) => {
      const terminalId = `00000000-0000-0000-0000-${String(++n).padStart(12, "0")}`;
      terminals.react({ type: "terminal.create", projectId, terminalId, cols: 80, rows: 24 }, userId);
      return terminalId;
    };
    return { terminals, open, said, spawned: () => spawned, killed: () => killed };
  }

  it("refuses one more in a project that has its limit, and says why", () => {
    const { open, said, spawned } = capped({ maxPerProject: 2 });
    open(PROJECTS[0]!, USER);
    open(PROJECTS[0]!, OTHER);
    const third = open(PROJECTS[0]!, THIRD);
    expect(spawned()).toBe(2);
    expect(said.get(third)).toBe("This project already has 2 terminals open, its limit. Close one to open another.\r\n");
    // Another project is not affected.
    open(PROJECTS[1]!, THIRD);
    expect(spawned()).toBe(3);
  });

  it("refuses one more for a person who has their limit, in any project", () => {
    const { open, said, spawned } = capped({ maxPerUser: 2 });
    open(PROJECTS[0]!, USER);
    open(PROJECTS[1]!, USER);
    const third = open(PROJECTS[2]!, USER);
    expect(spawned()).toBe(2);
    expect(said.get(third)).toBe("You already have 2 terminals open, the most one person can. Close one to open another.\r\n");
    open(PROJECTS[2]!, OTHER);
    expect(spawned()).toBe(3);
  });

  it("refuses one more when the server has its limit, whoever asks", () => {
    const { open, said, spawned } = capped({ maxTotal: 2 });
    open(PROJECTS[0]!, USER);
    open(PROJECTS[1]!, OTHER);
    const third = open(PROJECTS[2]!, THIRD);
    expect(spawned()).toBe(2);
    expect(said.get(third)).toBe("The server already has 2 terminals open, its limit. Close one to open another.\r\n");
  });

  it("opens again once one is closed", () => {
    const { terminals, open, spawned } = capped({ maxPerUser: 1 });
    const first = open(PROJECTS[0]!, USER);
    open(PROJECTS[0]!, USER);
    expect(spawned()).toBe(1);
    terminals.close(first, USER);
    open(PROJECTS[0]!, USER);
    expect(spawned()).toBe(2);
  });

  it("closes a terminal nobody typed into for the idle time it was given", () => {
    vi.useFakeTimers();
    try {
      const { open, killed } = capped({ idleMs: 60_000 });
      open(PROJECTS[0]!, USER);
      vi.advanceTimersByTime(59_000);
      expect(killed()).toBe(0);
      vi.advanceTimersByTime(1_000);
      expect(killed()).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("a terminal's priority", () => {
  it("starts the shell behind the server's prefix, in the terminal's directory", () => {
    const started: { file: string; args: string[]; cwd?: string }[] = [];
    const spawn = ((file: string, args: string[], options: { cwd?: string }) => {
      started.push({ file, args, cwd: options.cwd });
      return { write() {}, resize() {}, kill() {}, onData() {}, onExit() {} };
    }) as unknown as typeof import("@lydell/node-pty").spawn;
    const wrapped: { argv: readonly string[]; cwd?: string }[] = [];
    const terminals = new TerminalReactor(
      {
        workspaceRoot: root,
        allowHostShell: true,
        spawn,
        wrapArgv: (argv, _env, cwd) => {
          wrapped.push({ argv, cwd });
          return ["/usr/bin/choom", "-n", "500", "--", ...argv];
        },
      },
      () => {},
    );
    terminals.react(
      { type: "terminal.create", projectId: "aaaaaaaa-0000-0000-0000-000000000000", terminalId: "00000000-0000-0000-0000-000000000001", cols: 80, rows: 24 },
      USER,
    );
    expect(started).toHaveLength(1);
    expect(started[0]!.file).toBe("/usr/bin/choom");
    expect(started[0]!.args).toEqual(["-n", "500", "--", ...wrapped[0]!.argv]);
    expect(wrapped[0]!.cwd).toBe(started[0]!.cwd);
  });
});
