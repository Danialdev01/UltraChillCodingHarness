import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { emptyTrash, forceRemove, removeProjectFolders, stopProjectProcesses } from "./project-files.js";

const PROJECT = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-files-"));
});
afterEach(() => forceRemove(root));

const exited = (child: ReturnType<typeof spawn>) =>
  new Promise<string | null>((done) => child.once("exit", (_code, signal) => done(signal)));

describe("removing a project's folders", () => {
  it("removes all of one project's and none of another's", async () => {
    for (const id of [PROJECT, OTHER]) {
      for (const dir of [id, `.worktrees/${id}/s1`, `.snapshots/${id}`, `.uploads/${id}`]) {
        await mkdir(join(root, dir), { recursive: true });
        await writeFile(join(root, dir, "f"), "x");
      }
    }
    expect(await removeProjectFolders(root, PROJECT)).toEqual([]);
    for (const dir of ["", ".worktrees", ".snapshots", ".uploads"]) {
      const names = await readdir(join(root, dir));
      expect(names).not.toContain(PROJECT);
      expect(names).toContain(OTHER);
    }
    expect(await readdir(join(root, ".trash"))).toEqual([]);
  });

  it("gets through read-only folders, at any depth", async () => {
    const deep = join(root, PROJECT, "go/pkg/mod");
    await mkdir(deep, { recursive: true });
    await writeFile(join(deep, "f"), "x");
    for (const dir of [deep, join(root, PROJECT, "go"), join(root, PROJECT)]) await chmod(dir, 0o555);
    expect(await removeProjectFolders(root, PROJECT)).toEqual([]);
    expect(existsSync(join(root, PROJECT))).toBe(false);
    expect(await readdir(join(root, ".trash"))).toEqual([]);
  });

  it("never follows a link out of the project", async () => {
    const outside = join(root, "outside");
    await mkdir(outside);
    await writeFile(join(outside, "keep"), "x");
    await chmod(outside, 0o555);
    const locked = join(root, PROJECT, "locked");
    await mkdir(locked, { recursive: true });
    await symlink(outside, join(locked, "link"));
    await chmod(locked, 0o555);
    expect(await removeProjectFolders(root, PROJECT)).toEqual([]);
    expect((await stat(outside)).mode & 0o777).toBe(0o555);
    expect(existsSync(join(outside, "keep"))).toBe(true);
  });

  it("gets past something still writing", async () => {
    await mkdir(join(root, PROJECT));
    const writer = spawn("sh", ["-c", "i=0; while [ $i -lt 400 ]; do mkdir -p d; : > d/$i; i=$((i+1)); done"], {
      cwd: join(root, PROJECT),
    });
    expect(await removeProjectFolders(root, PROJECT)).toEqual([]);
    writer.kill("SIGKILL");
    expect(existsSync(join(root, PROJECT))).toBe(false);
  });

  it("is fine with nothing there, and empties what was left before", async () => {
    expect(await removeProjectFolders(root, PROJECT)).toEqual([]);
    await mkdir(join(root, ".trash", "old"), { recursive: true });
    expect(await emptyTrash(root)).toEqual([]);
    expect(await readdir(join(root, ".trash"))).toEqual([]);
  });
});

describe.skipIf(process.platform !== "linux")("stopping a project's processes", () => {
  const run = (env: Record<string, string>, command = "sleep 30", cwd = root) =>
    spawn("sh", ["-c", command], { cwd, env: { PATH: process.env.PATH ?? "", ...env } });

  it("stops its terminals' and agents', even one that ignores SIGTERM, and nobody else's", async () => {
    const bin = join(root, "runtimes", PROJECT, "bin");
    await mkdir(join(root, PROJECT));
    const gone = [
      run({ UCCH_ROOT: join(root, PROJECT) }),
      run({ UCCH_ROOT: join(root, ".worktrees", PROJECT, "s1") }),
      run({ PATH: `${bin}:${process.env.PATH}` }),
      run({ UCCH_ROOT: join(root, PROJECT) }, "trap '' TERM; while :; do sleep 0.05; done"),
    ];
    const kept = [run({ UCCH_ROOT: join(root, OTHER) }), run({}, "sleep 30", join(root, PROJECT))];
    const ends = Promise.all(gone.map(exited));
    await new Promise((done) => setTimeout(done, 200));
    await stopProjectProcesses(root, PROJECT, bin, 500);
    expect((await ends).every(Boolean)).toBe(true);
    for (const child of kept) {
      expect(child.exitCode ?? child.signalCode).toBeNull();
      child.kill("SIGKILL");
    }
  });
});
