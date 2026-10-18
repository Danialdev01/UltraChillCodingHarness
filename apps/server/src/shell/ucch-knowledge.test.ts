import { execFile } from "node:child_process";
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
    await mkdir(join(root, ".ucch", "diagrams"), { recursive: true });
    await writeFile(join(root, ".ucch", "INFO.md"), '\n# Demo\n\nSay "hi" \\ there\n\n');
    await writeFile(join(root, ".ucch", "diagrams", "database.mmd"), "erDiagram\n");
    await writeFile(join(root, ".ucch", "notes.md"), "x\n");
    await symlink("/etc/passwd", join(root, ".ucch", "leak"));

    const expected = await readProjectKnowledge(root);
    expect(expected).toContain("--- .ucch/INFO.md ---");
    expect(await shell(root)).toBe(`${expected}\n`);
  });

  it("gives the same text as a TOML string for codex", async () => {
    await mkdir(join(root, ".ucch"), { recursive: true });
    await writeFile(join(root, ".ucch", "INFO.md"), 'a "quote"\tand \\ a\nsecond line\n');
    const expected = await readProjectKnowledge(root);
    expect(JSON.parse(await shell("--toml", root))).toBe(expected);
  });

  it("says nothing for a project without .ucch/", async () => {
    expect(await shell(root)).toBe("");
    expect(await shell("--toml", root)).toBe("");
  });
});
