import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sessionFilesBeyondAgent } from "./session-settle.js";
import { projectRoot } from "./trees.js";

const PROJECT = "00000000-0000-4000-8000-000000000001";
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-settle-"));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("sessionFilesBeyondAgent", () => {
  it("counts nothing for a missing folder, or one with only .agent/ and .git/", async () => {
    expect(await sessionFilesBeyondAgent(root, PROJECT)).toEqual({ count: 0, names: [] });
    const dir = projectRoot(root, PROJECT);
    await mkdir(join(dir, ".agent", "diagrams"), { recursive: true });
    await mkdir(join(dir, ".git"), { recursive: true });
    await writeFile(join(dir, "README.md"), "# New session\n");
    expect(await sessionFilesBeyondAgent(root, PROJECT)).toEqual({ count: 0, names: [] });
  });

  it("lists anything else at the top level", async () => {
    const dir = projectRoot(root, PROJECT);
    await mkdir(join(dir, ".agent"), { recursive: true });
    await mkdir(join(dir, "src"), { recursive: true });
    await writeFile(join(dir, "README.md"), "# New session\n\nNotes the agent wrote.\n");
    await writeFile(join(dir, ".env"), "X=1");
    expect(await sessionFilesBeyondAgent(root, PROJECT, 2)).toEqual({ count: 3, names: [".env", "README.md"] });
  });
});
