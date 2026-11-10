import { mkdtempSync, mkdirSync, readFileSync, readlinkSync, realpathSync, writeFileSync, existsSync } from "node:fs";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { RuntimeInUseError, RuntimeManager, readSelections, writeSelections } from "./manager.js";
import type { RuntimeProvider, RuntimeRelease } from "./types.js";

const PROJECT = "11111111-2222-3333-4444-555555555555";
const OTHER = "99999999-2222-3333-4444-555555555555";

function fakeProvider(versions: string[]) {
  const installs: string[] = [];
  let gate: Promise<void> = Promise.resolve();
  const provider: RuntimeProvider & { installs: string[]; hold(p: Promise<void>): void } = {
    id: "php",
    binaries: ["php"],
    installs,
    hold(p) {
      gate = p;
    },
    async listAvailable() {
      return versions.map((version): RuntimeRelease => ({ version, url: `https://example.test/${version}` }));
    },
    async install(release, dir, context) {
      installs.push(release.version);
      context.onProgress?.(5, 10);
      await gate;
      await mkdir(join(dir, "bin"), { recursive: true });
      await writeFile(join(dir, "bin", "php"), `#!/bin/sh\necho ${release.version}\n`);
      await chmod(join(dir, "bin", "php"), 0o755);
    },
    async versionOf() {
      return null;
    },
    constraintOf(root) {
      try {
        return (JSON.parse(readFileSync(join(root, "composer.json"), "utf8")) as { require: { php: string } }).require.php;
      } catch {
        return null;
      }
    },
  };
  return provider;
}

let dir: string;
let workspaces: string;
let project: string;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "ucch-runtimes-")));
  workspaces = join(dir, "workspaces");
  project = join(workspaces, PROJECT);
  mkdirSync(project, { recursive: true });
});

afterEach(() => {
  vi.useRealTimers();
});

function manager(provider: RuntimeProvider, autoInstall = false) {
  const changed = vi.fn();
  const m = new RuntimeManager({
    root: join(dir, "runtimes"),
    workspaceRoot: workspaces,
    providers: { php: provider },
    autoInstall,
    changed,
  });
  return { m, changed };
}

const linkOf = (projectId = PROJECT) => readlinkSync(join(dir, "runtimes", "projects", projectId, "bin", "php"));

it("removes project runtime links and prevents an in-flight install recreating them", async () => {
  const provider = fakeProvider(["8.4.1"]);
  let release!: () => void;
  provider.hold(new Promise<void>((resolve) => { release = resolve; }));
  const { m } = manager(provider);
  mkdirSync(m.binDir(PROJECT), { recursive: true });
  mkdirSync(m.binDir(OTHER), { recursive: true });
  const installing = m.install("php", "8.4.1", PROJECT);
  await m.removeProject(PROJECT);
  release();
  await installing;
  expect(existsSync(m.binDir(PROJECT))).toBe(false);
  expect(existsSync(m.binDir(OTHER))).toBe(true);
});

describe("RuntimeManager", () => {
  it("installs once however many ask, and tells the waiting projects", async () => {
    const provider = fakeProvider(["8.3.30", "8.4.12"]);
    let release!: () => void;
    provider.hold(new Promise<void>((r) => (release = r)));
    const { m, changed } = manager(provider);

    const a = m.install("php", "8.4.12", PROJECT);
    const b = m.install("php", "8.4.12", OTHER);
    await vi.waitFor(() => expect(m.installing("php")).toEqual([{ version: "8.4.12", received: 5, total: 10 }]));
    release();
    await Promise.all([a, b]);

    expect(provider.installs).toEqual(["8.4.12"]);
    expect(m.installed("php")).toEqual(["8.4.12"]);
    expect(m.installing("php")).toEqual([]);
    await vi.waitFor(() => expect(changed.mock.calls.map((c) => c[0])).toEqual(expect.arrayContaining([PROJECT, OTHER])));
  });

  it("refuses a version nobody offers, and remembers why", async () => {
    const { m } = manager(fakeProvider(["8.4.12"]));
    await expect(m.install("php", "7.4.1")).rejects.toThrow(/not offered/);
    await vi.waitFor(async () => expect((await m.status(PROJECT, project)).runtimes[0]?.lastError).toMatch(/7\.4\.1/));
  });

  it("links the newest installed version for latest, and re-points on a change of selection", async () => {
    const { m } = manager(fakeProvider(["8.3.30", "8.4.12"]));
    await m.install("php", "8.3.30");
    await m.install("php", "8.4.12");

    // No file: latest.
    expect(m.reconcile(PROJECT, project)).toEqual({ php: "8.4.12" });
    expect(linkOf()).toBe("../../../php/8.4.12/bin/php");

    // A hand edit (or a pull) of the file is seen at the next spawn.
    await writeSelections(project, { php: "8.3" });
    expect(m.pathFor(join(project, "src"))).toBe(join(dir, "runtimes", "projects", PROJECT, "bin"));
    expect(linkOf()).toBe("../../../php/8.3.30/bin/php");

    // system: no link at all, PATH falls through.
    await writeSelections(project, { php: "system" });
    expect(m.reconcile(PROJECT, project)).toEqual({ php: null });
    expect(existsSync(join(dir, "runtimes", "projects", PROJECT, "bin", "php"))).toBe(false);
  });

  it("finds the project from a session worktree too, and nothing outside", () => {
    const { m } = manager(fakeProvider([]));
    const tree = join(workspaces, ".worktrees", PROJECT, "abc123");
    mkdirSync(tree, { recursive: true });
    expect(m.pathFor(tree)).toBe(join(dir, "runtimes", "projects", PROJECT, "bin"));
    expect(m.pathFor(workspaces)).toBeNull();
    expect(m.pathFor("/etc")).toBeNull();
  });

  it("will not uninstall a version a project uses", async () => {
    const { m } = manager(fakeProvider(["8.3.30", "8.4.12"]));
    await m.install("php", "8.3.30");
    await m.install("php", "8.4.12");
    m.reconcile(PROJECT, project);
    expect(m.projectsUsing("php", "8.4.12")).toEqual([PROJECT]);
    await expect(m.uninstall("php", "8.4.12")).rejects.toBeInstanceOf(RuntimeInUseError);
    await m.uninstall("php", "8.3.30");
    expect(m.installed("php")).toEqual(["8.4.12"]);
  });

  it("reports an update for a line, none for a pin, and the composer check", async () => {
    const { m } = manager(fakeProvider(["8.3.30", "8.4.11", "8.4.12"]));
    await m.install("php", "8.4.11");
    writeFileSync(join(project, "composer.json"), JSON.stringify({ require: { php: "^8.2" } }));

    await writeSelections(project, { php: "8.4" });
    let php = (await m.status(PROJECT, project)).runtimes[0]!;
    expect(php).toMatchObject({ selection: "8.4", resolved: "8.4.11", update: "8.4.12", missing: null, satisfies: true });

    await writeSelections(project, { php: "8.4.11" });
    php = (await m.status(PROJECT, project)).runtimes[0]!;
    expect(php.update).toBeNull();

    await writeSelections(project, { php: "8.3" });
    php = (await m.status(PROJECT, project)).runtimes[0]!;
    expect(php).toMatchObject({ resolved: null, missing: "8.3.30" });
  });

  it("installs a missing selection on its own when allowed, and only once", async () => {
    const provider = fakeProvider(["8.3.30", "8.4.12"]);
    const { m } = manager(provider, true);
    await writeSelections(project, { php: "8.3" });
    expect(m.reconcile(PROJECT, project)).toEqual({ php: null });
    m.reconcile(PROJECT, project);
    await vi.waitFor(() => expect(m.installed("php")).toEqual(["8.3.30"]));
    expect(provider.installs).toEqual(["8.3.30"]);
    expect(m.reconcile(PROJECT, project)).toEqual({ php: "8.3.30" });
  });

  it("keeps what else the file holds, and reports a broken one", async () => {
    mkdirSync(join(project, ".agent"));
    writeFileSync(join(project, ".agent", "runtimes.json"), JSON.stringify({ node: { version: "22" } }));
    await writeSelections(project, { php: "8.4" });
    expect(JSON.parse(readFileSync(join(project, ".agent", "runtimes.json"), "utf8"))).toEqual({
      node: { version: "22" },
      php: { version: "8.4" },
    });
    writeFileSync(join(project, ".agent", "runtimes.json"), JSON.stringify({ php: { version: "eight" } }));
    expect(readSelections(project).error).toMatch(/php\.version/);
  });
});
