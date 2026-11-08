import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { commandCwd, findCommand, readCommands, writeCommands } from "./project-commands.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-cmds-"));
  await mkdir(join(root, ".agent"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const file = (body: string) => writeFile(join(root, ".agent", "commands.json"), body);

describe("readCommands", () => {
  it("is empty, without an error, when there is no file", async () => {
    expect(readCommands(root)).toEqual({ commands: [], error: null });
  });

  it("reads the commands", async () => {
    await file(JSON.stringify({ commands: [{ id: "dev", label: "Dev", command: "pnpm dev" }] }));
    expect(readCommands(root)).toEqual({ commands: [{ id: "dev", label: "Dev", command: "pnpm dev" }], error: null });
    expect(findCommand(root, "dev")?.command).toBe("pnpm dev");
    expect(findCommand(root, "nope")).toBeNull();
  });

  it("says why when the file is not valid JSON", async () => {
    await file("{ nope");
    expect(readCommands(root).error).toMatch(/not valid JSON/);
  });

  it("says why when a command does not fit the schema", async () => {
    await file(JSON.stringify({ commands: [{ id: "Bad Id", label: "x", command: "y" }] }));
    const read = readCommands(root);
    expect(read.commands).toEqual([]);
    expect(read.error).toMatch(/commands\.0\.id/);
  });

  it("refuses duplicate ids", async () => {
    const dev = { id: "dev", label: "Dev", command: "a" };
    await file(JSON.stringify({ commands: [dev, dev] }));
    expect(readCommands(root).error).toMatch(/unique/);
  });

  it("does not read through a symlink", async () => {
    const elsewhere = join(root, "elsewhere.json");
    await writeFile(elsewhere, JSON.stringify({ commands: [{ id: "x", label: "x", command: "x" }] }));
    await symlink(elsewhere, join(root, ".agent", "commands.json"));
    expect(readCommands(root)).toMatchObject({ commands: [], error: expect.stringMatching(/symlink/) });
  });
});

describe("writeCommands", () => {
  it("writes what readCommands reads back", async () => {
    const commands = [{ id: "test", label: "Test", command: "pnpm test", cwd: "apps" }];
    await writeCommands(root, commands);
    expect(JSON.parse(await readFile(join(root, ".agent", "commands.json"), "utf8"))).toEqual({ commands });
    expect(readCommands(root).commands).toEqual(commands);
  });

  it("refuses to write through a symlinked .agent", async () => {
    await rm(join(root, ".agent"), { recursive: true });
    const outside = await mkdtemp(join(tmpdir(), "ucch-out-"));
    try {
      await symlink(outside, join(root, ".agent"));
      await expect(writeCommands(root, [])).rejects.toThrow(/symlink/);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});

describe("commandCwd", () => {
  it("is the root by default, and a folder inside it when named", async () => {
    await mkdir(join(root, "web"));
    expect(commandCwd(root, undefined)).toBe(await realpath(root));
    expect(commandCwd(root, "web")).toBe(join(await realpath(root), "web"));
  });

  it.each(["..", "../..", "/etc", "missing", ".git", ".agent/commands.json"])("refuses %s", async (cwd) => {
    await mkdir(join(root, ".git"));
    expect(commandCwd(root, cwd)).toBeNull();
  });

  it("refuses a symlink that leads out of the project", async () => {
    await symlink(tmpdir(), join(root, "out"));
    expect(commandCwd(root, "out")).toBeNull();
  });
});

