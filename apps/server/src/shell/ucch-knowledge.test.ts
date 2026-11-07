import { execFile, execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readProjectKnowledge } from "../dev-database.js";

const run = promisify(execFile);
const SCRIPT = fileURLToPath(new URL("./ucch-knowledge.sh", import.meta.url));

async function shell(...args: string[]): Promise<string> {
  const { stdout } = await run("sh", [SCRIPT, ...args]);
  return stdout;
}

describe("ucch-knowledge.sh", () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ucch-knowledge-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("says what a harness-run agent is told, word for word", async () => {
    await mkdir(join(root, ".agent", "diagrams"), { recursive: true });
    await writeFile(join(root, ".agent", "index.md"), '\n# Demo\n\nSay "hi" \\ there\n\n');
    await writeFile(join(root, ".agent", "diagrams", "database.mmd"), "erDiagram\n");
    await writeFile(join(root, ".agent", "notes.md"), "x\n");
    await symlink("/etc/passwd", join(root, ".agent", "leak"));

    const expected = await readProjectKnowledge(root);
    expect(expected).toContain("--- .agent/index.md ---");
    expect(await shell(root)).toBe(`${expected}\n`);
  });

  it("gives the same text as a TOML string for codex", async () => {
    await mkdir(join(root, ".agent"), { recursive: true });
    await writeFile(join(root, ".agent", "index.md"), 'a "quote"\tand \\ a\nsecond line\n');
    const expected = await readProjectKnowledge(root);
    expect(JSON.parse(await shell("--toml", root))).toBe(expected);
  });

  it("says nothing for a project without .agent/", async () => {
    expect(await shell(root)).toBe("");
    expect(await shell("--toml", root)).toBe("");
  });
});

/**
 * The `claude` / `codex` wrappers (OM6.7), sourced from each init file with
 * stand-ins for both CLIs on the PATH that print their arguments, one per
 * line. `UCCH_OMP_MCP` names the bridge files `terminal-bridge.ts` writes.
 */
describe("the claude and codex wrappers with the OMP bridge", () => {
  const BASHRC = fileURLToPath(new URL("./ucch.bashrc", import.meta.url));
  const FISH = fileURLToPath(new URL("./ucch.fish", import.meta.url));
  const hasFish = (() => {
    try {
      return Boolean(execFileSync("fish", ["--version"], { stdio: "pipe" }));
    } catch {
      return false;
    }
  })();
  let root: string;
  let bin: string;
  let mcp: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ucch-wrappers-"));
    bin = join(root, "bin");
    await mkdir(join(root, "project"), { recursive: true });
    await mkdir(join(root, "home"), { recursive: true });
    await mkdir(bin);
    for (const name of ["claude", "codex"]) {
      await writeFile(join(bin, name), `#!/bin/sh\necho ${name}\nfor a in "$@"; do printf '%s\\n' "$a"; done\n`, { mode: 0o755 });
    }
    mcp = join(root, "run", "term-t.mcp.json");
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Writes the files the server writes for a terminal with the bridge on. */
  async function bridged() {
    await mkdir(join(root, "run"), { recursive: true });
    await writeFile(mcp, "{}\n");
    await writeFile(join(root, "run", "term-t.codex"), ["-c", 'mcp_servers.omp.command="/usr/bin/node"', "-c", "mcp_servers.omp.tool_timeout_sec=370"].join("\n") + "\n");
  }

  const env = () => ({ PATH: `${bin}:/usr/bin:/bin`, HOME: join(root, "home"), UCCH_ROOT: join(root, "project"), UCCH_OMP_MCP: mcp });

  const shells: [string, (cli: string, args: string[]) => Promise<string[]>][] = [
    [
      "bash",
      async (cli, args) =>
        (await run("bash", ["--norc", "--noprofile", "-c", `source "$0"; PATH="${bin}:$PATH"; ${cli} "$@"`, BASHRC, ...args], { env: env() })).stdout
          .trimEnd()
          .split("\n"),
    ],
    [
      "fish",
      async (cli, args) =>
        (await run("fish", ["--no-config", "-c", `source $argv[1]; set -gx PATH ${bin} $PATH; ${cli} $argv[2..]`, FISH, ...args], { env: env() })).stdout
          .trimEnd()
          .split("\n"),
    ],
  ];

  for (const [name, wrapped] of shells) {
    it.skipIf(name === "fish" && !hasFish)(`${name}: adds the bridge only while its files are there`, async () => {
      expect(await wrapped("claude", ["fix it"])).toEqual(["claude", "fix it"]);
      expect(await wrapped("codex", ["exec", "fix it"])).toEqual(["codex", "exec", "fix it"]);
      await bridged();
      // `=`: the flag takes every word after it as a config file otherwise.
      expect(await wrapped("claude", ["fix it"])).toEqual(["claude", `--mcp-config=${mcp}`, "fix it"]);
      expect(await wrapped("claude", ["mcp", "list"])).toEqual(["claude", "mcp", "list"]);
      expect(await wrapped("codex", ["exec", "fix it"])).toEqual([
        "codex",
        "-c",
        'mcp_servers.omp.command="/usr/bin/node"',
        "-c",
        "mcp_servers.omp.tool_timeout_sec=370",
        "exec",
        "fix it",
      ]);
    });

    it.skipIf(name === "fish" && !hasFish)(`${name}: keeps the project's knowledge after the bridge`, async () => {
      await bridged();
      await mkdir(join(root, "project", ".agent"), { recursive: true });
      await writeFile(join(root, "project", ".agent", "index.md"), "Demo\n");
      const claude = await wrapped("claude", ["go"]);
      expect(claude.slice(0, 3)).toEqual(["claude", `--mcp-config=${mcp}`, "--append-system-prompt"]);
      expect(claude.at(-1)).toBe("go");
      const codex = await wrapped("codex", ["go"]);
      expect(codex.slice(0, 6)).toEqual(["codex", "-c", 'mcp_servers.omp.command="/usr/bin/node"', "-c", "mcp_servers.omp.tool_timeout_sec=370", "-c"]);
      expect(codex[6]).toMatch(/^developer_instructions="/);
      expect(codex.at(-1)).toBe("go");
    });
  }
});
