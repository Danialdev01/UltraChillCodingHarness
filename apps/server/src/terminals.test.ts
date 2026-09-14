import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { DomainEvent } from "@ucch/protocol";
import { isSecretName, loginShell, terminalEnv, TerminalReactor } from "./terminals.js";

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

  // Bound to *this* array rather than to the `output` variable: a shell
  // killed in `afterEach` reports its exit a moment later, and a closure over
  // the binding would push that into the next test's output.
  const sink = output;
  reactor = new TerminalReactor({ workspaceRoot: root, allowHostShell: true }, (_project, event) => {
    if (event.type === "terminal.output") sink.push(event.data);
  });
});

afterEach(async () => {
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
  it("is the one the operator chose", () => {
    expect(loginShell({ SHELL: "/usr/bin/fish" })).toBe("/usr/bin/fish");
  });

  it("falls back when a service manager sets no SHELL", () => {
    expect(loginShell({})).toBe("/bin/bash");
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
    expect(calls[0]?.args).toEqual(["-l"]);
    expect(calls[0]?.cwd).toBe(join(root, PROJECT));
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
