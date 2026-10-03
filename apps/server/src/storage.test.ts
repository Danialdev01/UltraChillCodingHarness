import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { directoryBytes } from "./storage.js";

let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-storage-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("directoryBytes", () => {
  it("sums every file, however deep", async () => {
    await writeFile(join(root, "a.txt"), "12345");
    await mkdir(join(root, "sub/deeper"), { recursive: true });
    await writeFile(join(root, "sub/b.txt"), "123");
    await writeFile(join(root, "sub/deeper/c.txt"), "1234567");
    expect(await directoryBytes(root)).toBe(15);
  });

  it("includes node_modules and dotfiles", async () => {
    // The file panel hides these; the bill must not.
    await mkdir(join(root, "node_modules/pkg"), { recursive: true });
    await writeFile(join(root, "node_modules/pkg/index.js"), "12");
    await writeFile(join(root, ".env"), "123");
    expect(await directoryBytes(root)).toBe(5);
  });

  it("counts a symlink as itself and does not follow it", async () => {
    await mkdir(join(root, "outside"));
    await writeFile(join(root, "outside/big.bin"), "x".repeat(1000));
    await mkdir(join(root, "project"));
    await symlink(join(root, "outside"), join(root, "project/link"));
    const bytes = await directoryBytes(join(root, "project"));
    expect(bytes).toBeLessThan(1000);
  });

  it("is zero for a directory that does not exist", async () => {
    expect(await directoryBytes(join(root, "missing"))).toBe(0);
  });
});
