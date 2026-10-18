import { mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  databaseUrl,
  devServerFromUrl,
  devServersFromConfig,
  ensureGitignored,
  ensureProjectInfo,
  writeDatabaseUrl,
} from "./dev-database.js";

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "ucch-devdb-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("dev servers", () => {
  it("reads a URL into a target, defaulting the port by engine", () => {
    expect(devServerFromUrl("mysql", "mysql://dev:s%3Acret@mysql/dev")).toEqual({
      engine: "mysql",
      host: "mysql",
      port: 3306,
      username: "dev",
      password: "s:cret",
      database: "dev",
    });
  });

  it("leaves out an engine that is not configured", () => {
    expect(Object.keys(devServersFromConfig({ DEV_POSTGRES_URL: "postgres://dev:dev@h:1/dev" }))).toEqual([
      "postgresql",
    ]);
  });

  it("round-trips the password through the URL it hands the project", () => {
    const server = devServerFromUrl("postgresql", "postgres://dev:a%2Fb@localhost:55432/dev");
    expect(databaseUrl(server, "shop")).toBe("postgres://dev:a%2Fb@localhost:55432/shop");
  });
});

describe(".env", () => {
  it("replaces an existing DATABASE_URL and keeps everything else", async () => {
    await writeFile(join(dir, ".env"), "A=1\nDATABASE_URL=old\nB=2");
    await writeDatabaseUrl(dir, "postgres://x/y");
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("A=1\nDATABASE_URL=postgres://x/y\nB=2");
  });

  it("appends to a file with no trailing newline", async () => {
    await writeFile(join(dir, ".env"), "A=1");
    await writeDatabaseUrl(dir, "u");
    expect(await readFile(join(dir, ".env"), "utf8")).toBe("A=1\nDATABASE_URL=u\n");
  });
});

describe(".gitignore", () => {
  it("adds the entry once", async () => {
    await writeFile(join(dir, ".gitignore"), "node_modules");
    await ensureGitignored(dir, ".env");
    await ensureGitignored(dir, ".env");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("node_modules\n.env\n");
  });

  it("treats a rooted entry as covering it", async () => {
    await writeFile(join(dir, ".gitignore"), "/.env\n");
    await ensureGitignored(dir, ".env");
    expect(await readFile(join(dir, ".gitignore"), "utf8")).toBe("/.env\n");
  });
});

describe(".ucch/INFO.md", () => {
  it("is written once and then left to whoever edits it", async () => {
    await ensureProjectInfo(dir, "first\n");
    await ensureProjectInfo(dir, "second\n");
    expect(await readFile(join(dir, ".ucch", "INFO.md"), "utf8")).toBe("first\n");
    expect((await stat(join(dir, ".ucch", "diagrams"))).isDirectory()).toBe(true);
  });

  it("explains the folder when nothing else is known about the project", async () => {
    await ensureProjectInfo(dir);
    expect(await readFile(join(dir, ".ucch", "INFO.md"), "utf8")).toContain("## The .ucch folder");
  });

  it("promotes an older context.md rather than writing over its settings", async () => {
    await mkdir(join(dir, ".ucch"));
    await writeFile(join(dir, ".ucch", "context.md"), "settings\n");
    await ensureProjectInfo(dir, "fresh\n");
    expect(await readFile(join(dir, ".ucch", "INFO.md"), "utf8")).toBe("settings\n");
    await expect(stat(join(dir, ".ucch", "context.md"))).rejects.toThrow();
  });

  it("carries an older diagram over once and leaves the original", async () => {
    await mkdir(join(dir, "docs", "diagrams"), { recursive: true });
    await writeFile(join(dir, "docs", "diagrams", "database.mmd"), "erDiagram\n");
    await ensureProjectInfo(dir);
    await writeFile(join(dir, ".ucch", "diagrams", "database.mmd"), "erDiagram\n  %% edited\n");
    await ensureProjectInfo(dir);
    expect(await readFile(join(dir, ".ucch", "diagrams", "database.mmd"), "utf8")).toContain("edited");
    expect(await readFile(join(dir, "docs", "diagrams", "database.mmd"), "utf8")).toBe("erDiagram\n");
  });

  it("refuses a .ucch that is a symlink", async () => {
    await symlink(tmpdir(), join(dir, ".ucch"));
    await expect(ensureProjectInfo(dir)).rejects.toThrow(/symlink/);
  });
});
