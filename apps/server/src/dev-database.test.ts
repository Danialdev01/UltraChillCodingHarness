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
  firstParagraph,
  migrateLegacyFolder,
  readProjectDescription,
  refreshIndexFiles,
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

describe(".agent/index.md", () => {
  const index = () => readFile(join(dir, ".agent", "index.md"), "utf8");

  it("is written once and then left to whoever edits it, but for its file list", async () => {
    await ensureProjectInfo(dir, () => "first\n");
    await ensureProjectInfo(dir, () => "second\n");
    const text = await index();
    expect(text.startsWith("first\n")).toBe(true);
    expect(text).not.toContain("second");
    expect(text).toContain("- `index.md`: this file");
    expect((await stat(join(dir, ".agent", "diagrams"))).isDirectory()).toBe(true);
  });

  it("explains the folder when nothing else is known about the project", async () => {
    await ensureProjectInfo(dir);
    expect(await index()).toContain("## The .agent folder");
  });

  it("keeps its file list in step with the folder, and touches nothing outside it", async () => {
    await ensureProjectInfo(dir, () => "# Shop\n\nSells hats.\n");
    await writeFile(join(dir, ".agent", "env.val"), "{}");
    await writeFile(join(dir, ".agent", "diagrams", "database.mmd"), "erDiagram\n");
    await mkdir(join(dir, ".agent", "doc-cache", "pages"), { recursive: true });
    await writeFile(join(dir, ".agent", "doc-cache", "pages", "p-1.png"), "");
    await refreshIndexFiles(dir);
    const text = await index();
    expect(text.startsWith("# Shop\n\nSells hats.\n")).toBe(true);
    expect(text).toContain("- `env.val`: the project's environment variables");
    expect(text).toContain("- `diagrams/database.mmd`: Mermaid diagram: the database schema");
    expect(text).toContain("- `doc-cache/`");
    expect(text).not.toContain("p-1.png");
    expect(text.match(/agent:files:start/g)).toHaveLength(1);

    await rm(join(dir, ".agent", "env.val"));
    await writeFile(join(dir, ".agent", "index.md"), text.replace("Sells hats.", "Sells caps."));
    await refreshIndexFiles(dir);
    const after = await index();
    expect(after).toContain("Sells caps.");
    expect(after).not.toContain("env.val");
  });

  it("promotes an older INFO.md or context.md rather than writing over its settings", async () => {
    await mkdir(join(dir, ".agent"));
    await writeFile(join(dir, ".agent", "context.md"), "settings\n");
    await ensureProjectInfo(dir, () => "fresh\n");
    expect((await index()).startsWith("settings\n")).toBe(true);
    await expect(stat(join(dir, ".agent", "context.md"))).rejects.toThrow();
  });

  it("carries an older diagram over once and leaves the original", async () => {
    await mkdir(join(dir, "docs", "diagrams"), { recursive: true });
    await writeFile(join(dir, "docs", "diagrams", "database.mmd"), "erDiagram\n");
    await ensureProjectInfo(dir);
    await writeFile(join(dir, ".agent", "diagrams", "database.mmd"), "erDiagram\n  %% edited\n");
    await ensureProjectInfo(dir);
    expect(await readFile(join(dir, ".agent", "diagrams", "database.mmd"), "utf8")).toContain("edited");
    expect(await readFile(join(dir, "docs", "diagrams", "database.mmd"), "utf8")).toBe("erDiagram\n");
  });

  it("refuses a .agent that is a symlink", async () => {
    await symlink(tmpdir(), join(dir, ".agent"));
    await expect(ensureProjectInfo(dir)).rejects.toThrow(/symlink/);
  });
});

describe("the description in index.md", () => {
  const index = () => readFile(join(dir, ".agent", "index.md"), "utf8");

  it("prefers package.json over the README", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ description: "Sells  hats\nonline." }));
    await writeFile(join(dir, "README.md"), "# Shop\n\nFrom the README.\n");
    await ensureProjectInfo(dir);
    expect(await index()).toContain("## About\n\nSells hats online.\n");
  });

  it("falls back to the README when package.json says nothing or is broken", async () => {
    await writeFile(join(dir, "package.json"), "{ not json");
    await writeFile(join(dir, "README.md"), "# Shop\n\nSells hats\nonline.\n\nMore.\n");
    expect(await readProjectDescription(dir)).toBe("Sells hats online.");
  });

  it("finds the prose past titles, badges, HTML, lists and code", () => {
    const readme = [
      "---",
      "title: Shop",
      "---",
      "Shop",
      "====",
      "[![ci](https://x/b.svg)](https://x)",
      "<p align=center><img src=a.png></p>",
      "",
      "- [Contents](#contents)",
      "```",
      "not this",
      "```",
      "> Sells hats.",
    ].join("\n");
    expect(firstParagraph(readme)).toBe("Sells hats.");
    expect(firstParagraph("# Only a title\n")).toBeNull();
  });

  it("is cut to one short line, and cannot carry the file list's markers", async () => {
    await writeFile(join(dir, "package.json"), JSON.stringify({ description: `<!-- agent:files:start --> ${"x".repeat(900)}` }));
    const line = await readProjectDescription(dir);
    expect(line).not.toContain("<!--");
    expect(line!.length).toBeLessThanOrEqual(301);
  });

  it("does not follow a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ucch-outside-"));
    await writeFile(join(outside, "secret"), "host file\n");
    await symlink(join(outside, "secret"), join(dir, "README.md"));
    expect(await readProjectDescription(dir)).toBeNull();
    await rm(outside, { recursive: true, force: true });
  });

  it("leaves a placeholder when there is nothing to detect", async () => {
    await ensureProjectInfo(dir);
    expect(await index()).toMatch(/## About\n\n_No description yet/);
  });

  it("never rewrites an index.md that exists", async () => {
    await ensureProjectInfo(dir, () => "# Mine\n");
    await writeFile(join(dir, "package.json"), JSON.stringify({ description: "Later." }));
    await ensureProjectInfo(dir);
    expect(await index()).not.toContain("Later.");
  });
});

describe("moving .ucch to .agent", () => {
  it("renames the folder and its INFO.md", async () => {
    await mkdir(join(dir, ".ucch", "diagrams"), { recursive: true });
    await writeFile(join(dir, ".ucch", "INFO.md"), "# Old\n");
    await writeFile(join(dir, ".ucch", "diagrams", "user-flow.mmd"), "flowchart\n");
    await ensureProjectInfo(dir, () => "fresh\n");
    await ensureProjectInfo(dir, () => "fresh\n");
    await expect(stat(join(dir, ".ucch"))).rejects.toThrow();
    expect((await readFile(join(dir, ".agent", "index.md"), "utf8")).startsWith("# Old\n")).toBe(true);
    expect(await readFile(join(dir, ".agent", "diagrams", "user-flow.mmd"), "utf8")).toBe("flowchart\n");
    await expect(stat(join(dir, ".agent", "INFO.md"))).rejects.toThrow();
  });

  it("merges into an existing .agent, which wins every conflict", async () => {
    await mkdir(join(dir, ".ucch", "diagrams"), { recursive: true });
    await mkdir(join(dir, ".agent", "diagrams"), { recursive: true });
    await writeFile(join(dir, ".ucch", "notes.md"), "old notes\n");
    await writeFile(join(dir, ".ucch", "diagrams", "database.mmd"), "old\n");
    await writeFile(join(dir, ".ucch", "diagrams", "architecture.mmd"), "arch\n");
    await writeFile(join(dir, ".agent", "diagrams", "database.mmd"), "new\n");
    await migrateLegacyFolder(dir);
    await expect(stat(join(dir, ".ucch"))).rejects.toThrow();
    expect(await readFile(join(dir, ".agent", "notes.md"), "utf8")).toBe("old notes\n");
    expect(await readFile(join(dir, ".agent", "diagrams", "database.mmd"), "utf8")).toBe("new\n");
    expect(await readFile(join(dir, ".agent", "diagrams", "architecture.mmd"), "utf8")).toBe("arch\n");
  });

  it("leaves a .ucch that is a symlink where it is, and follows nothing", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ucch-outside-"));
    await writeFile(join(outside, "INFO.md"), "host\n");
    await symlink(outside, join(dir, ".ucch"));
    await ensureProjectInfo(dir, () => "fresh\n");
    expect((await readFile(join(dir, ".agent", "index.md"), "utf8")).startsWith("fresh\n")).toBe(true);
    expect(await readFile(join(outside, "INFO.md"), "utf8")).toBe("host\n");
    await rm(outside, { recursive: true, force: true });
  });
});
