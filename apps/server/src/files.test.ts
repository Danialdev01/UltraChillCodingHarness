import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConflictError, PathError, WorkspaceFiles } from "./files.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";

let root: string;
let files: WorkspaceFiles;
/** The project's own directory inside the workspace root. */
let dir: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "ucch-files-"));
  files = new WorkspaceFiles(root);
  dir = await files.ensureRoot(PROJECT);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolve", () => {
  const refused = [
    "../escape",
    "a/../../b",
    "/etc/hosts",
    "sub/../../../etc/passwd",
    "with\0nul",
    "",
    ".",
  ];

  it.each(refused)("refuses %j", (path) => {
    expect(() => files.resolve(PROJECT, path)).toThrow(PathError);
  });

  it("keeps an ordinary path inside the project", () => {
    expect(files.resolve(PROJECT, "src/index.ts")).toBe(join(dir, "src/index.ts"));
    // Normalised on the way through, rather than refused for being untidy.
    expect(files.resolve(PROJECT, "./src/./index.ts")).toBe(join(dir, "src/index.ts"));
    expect(files.resolve(PROJECT, "src/nested/../index.ts")).toBe(join(dir, "src/index.ts"));
  });

  it("cannot reach another project's workspace", () => {
    // The neighbour is a sibling directory, which is exactly what `..` would
    // reach if the normalisation let it.
    expect(() => files.resolve(PROJECT, "../44444444-4444-4444-4444-444444444444/x")).toThrow(
      PathError,
    );
  });
});

describe("tree", () => {
  it("lists folders before files, each sorted by name", async () => {
    await mkdir(join(dir, "src/lib"), { recursive: true });
    await writeFile(join(dir, "README.md"), "# hi");
    await writeFile(join(dir, "package.json"), "{}");
    await writeFile(join(dir, "src/index.ts"), "export {}");

    const { tree, truncated } = await files.tree(PROJECT);
    expect(truncated).toBe(false);
    // Folders first, then files by name -- `localeCompare`, so the ordering
    // is the reader's ("package.json" before "README.md"), not ASCII's.
    expect(tree.map((n) => n.name)).toEqual(["src", "package.json", "README.md"]);
    expect(tree[0]!.children!.map((n) => n.name)).toEqual(["lib", "index.ts"]);
  });

  it("hides .git, which is thousands of entries nobody opened a tree to read", async () => {
    await mkdir(join(dir, ".git/objects"), { recursive: true });
    await writeFile(join(dir, ".gitignore"), "node_modules");

    const { tree } = await files.tree(PROJECT);
    expect(tree.map((n) => n.name)).toEqual([".gitignore"]);
  });

  it("shows node_modules but does not walk into it", async () => {
    await mkdir(join(dir, "node_modules/react"), { recursive: true });
    const { tree } = await files.tree(PROJECT);
    expect(tree[0]).toEqual({ name: "node_modules", children: [] });
  });

  it("lists a symlinked directory as a file rather than following it", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ucch-outside-"));
    await writeFile(join(outside, "secret.txt"), "s3cret");
    await symlink(outside, join(dir, "link"));

    const { tree } = await files.tree(PROJECT);
    expect(tree).toEqual([{ name: "link" }]);
    await rm(outside, { recursive: true, force: true });
  });

  it("creates the project directory when a clone never made one", async () => {
    const fresh = new WorkspaceFiles(root);
    const { tree } = await fresh.tree("55555555-5555-5555-5555-555555555555");
    expect(tree).toEqual([]);
  });
});

describe("read", () => {
  it("returns text", async () => {
    await writeFile(join(dir, "a.txt"), "hello");
    expect(await files.read(PROJECT, "a.txt")).toEqual({ kind: "text", content: "hello" });
  });

  it("reports what it will not open", async () => {
    await mkdir(join(dir, "folder"));
    await writeFile(join(dir, "image.png"), Buffer.from([0x89, 0x50, 0x00, 0x01]));

    expect(await files.read(PROJECT, "folder")).toEqual({ kind: "directory" });
    expect(await files.read(PROJECT, "image.png")).toEqual({ kind: "binary" });
    expect(await files.read(PROJECT, "nope.txt")).toEqual({ kind: "missing" });
  });

  it("refuses to follow a symlink out of the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ucch-outside-"));
    await writeFile(join(outside, "secret.txt"), "s3cret");
    await symlink(join(outside, "secret.txt"), join(dir, "innocent.txt"));

    await expect(files.read(PROJECT, "innocent.txt")).rejects.toThrow(PathError);
    await rm(outside, { recursive: true, force: true });
  });
});

describe("readBytes", () => {
  it("returns the bytes exactly as they are on disk", async () => {
    // The point of this method: `read` would call these bytes binary and
    // hand back nothing, because a preview needs the file, not a string.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0xff]);
    await writeFile(join(dir, "logo.png"), png);

    const result = await files.readBytes(PROJECT, "logo.png");
    expect(result.kind).toBe("file");
    if (result.kind === "file") expect(result.bytes.equals(png)).toBe(true);
  });

  it("reports what it will not serve", async () => {
    await mkdir(join(dir, "folder"));
    expect(await files.readBytes(PROJECT, "folder")).toEqual({ kind: "directory" });
    expect(await files.readBytes(PROJECT, "nope.png")).toEqual({ kind: "missing" });
  });

  it("is held to the same paths as every other read", async () => {
    for (const path of ["../escape.png", "/etc/hosts", "a/../../out.png"]) {
      await expect(files.readBytes(PROJECT, path)).rejects.toThrow(PathError);
    }
  });

  it("refuses to follow a symlink out of the workspace", async () => {
    // The one that matters most here: a link planted by the agent must not
    // become a way to serve the host's files to the browser.
    const outside = await mkdtemp(join(tmpdir(), "ucch-outside-"));
    await writeFile(join(outside, "secret.png"), "s3cret");
    await symlink(join(outside, "secret.png"), join(dir, "innocent.png"));

    await expect(files.readBytes(PROJECT, "innocent.png")).rejects.toThrow(PathError);
    await rm(outside, { recursive: true, force: true });
  });
});

describe("write", () => {
  it("creates a file, and says so", async () => {
    expect(await files.write(PROJECT, "src/new.ts", "export {}")).toBe("added");
    expect(await readFile(join(dir, "src/new.ts"), "utf8")).toBe("export {}");
  });

  it("overwrites an existing one, and says that instead", async () => {
    await writeFile(join(dir, "a.txt"), "old");
    expect(await files.write(PROJECT, "a.txt", "new")).toBe("modified");
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("new");
  });

  it("refuses a path outside the workspace", async () => {
    await expect(files.write(PROJECT, "../escaped.txt", "x")).rejects.toThrow(PathError);
  });

  it("refuses to write through a symlink that leaves the workspace", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ucch-outside-"));
    await writeFile(join(outside, "target.txt"), "original");
    await symlink(join(outside, "target.txt"), join(dir, "link.txt"));

    await expect(files.write(PROJECT, "link.txt", "overwritten")).rejects.toThrow(PathError);
    expect(await readFile(join(outside, "target.txt"), "utf8")).toBe("original");
    await rm(outside, { recursive: true, force: true });
  });
});

describe("create", () => {
  it("makes an empty file and a directory", async () => {
    await files.create(PROJECT, "empty.ts", "file");
    await files.create(PROJECT, "src/components", "directory");

    expect(await readFile(join(dir, "empty.ts"), "utf8")).toBe("");
    expect((await files.tree(PROJECT)).tree.find((n) => n.name === "src")?.children).toEqual([
      { name: "components", children: [] },
    ]);
  });

  it("refuses to clobber what is already there", async () => {
    await writeFile(join(dir, "a.txt"), "keep me");
    await expect(files.create(PROJECT, "a.txt", "file")).rejects.toThrow(ConflictError);
    expect(await readFile(join(dir, "a.txt"), "utf8")).toBe("keep me");
  });
});

describe("remove", () => {
  it("deletes a file and reports a path that was not there", async () => {
    await writeFile(join(dir, "a.txt"), "x");
    expect(await files.remove(PROJECT, "a.txt")).toBe(true);
    expect(await files.remove(PROJECT, "a.txt")).toBe(false);
  });

  it("deletes a directory and everything in it", async () => {
    await mkdir(join(dir, "src/lib"), { recursive: true });
    await writeFile(join(dir, "src/lib/x.ts"), "x");

    expect(await files.remove(PROJECT, "src")).toBe(true);
    expect((await files.tree(PROJECT)).tree).toEqual([]);
  });

  it("will not delete the project root", async () => {
    // Deleting the project is a different act, with its own confirmation.
    await expect(files.remove(PROJECT, ".")).rejects.toThrow(PathError);
  });

  it("removes a symlink without touching what it points at", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ucch-outside-"));
    await writeFile(join(outside, "keep.txt"), "keep");
    await symlink(join(outside, "keep.txt"), join(dir, "link.txt"));

    await expect(files.remove(PROJECT, "link.txt")).rejects.toThrow(PathError);
    expect(await readFile(join(outside, "keep.txt"), "utf8")).toBe("keep");
    await rm(outside, { recursive: true, force: true });
  });
});
