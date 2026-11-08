import { lstat, mkdir, mkdtemp, readdir, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ProjectTask } from "@ucch/protocol";

import { attachmentPaths, renderTodoMarkdown, TodoMirror } from "./agent-todo.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const UPLOAD_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const UPLOAD_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

function task(over: Partial<ProjectTask> = {}): ProjectTask {
  return {
    id: "t1",
    title: "A task",
    description: "",
    references: [],
    stage: "idea",
    status: "idle",
    position: 0,
    research: null,
    verification: null,
    feedback: [],
    threadId: null,
    attempts: 0,
    lastError: null,
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

describe("attachmentPaths", () => {
  it("puts each upload under the card's folder, with unique names", () => {
    const paths = attachmentPaths(
      task({
        references: [
          { kind: "upload", uploadId: UPLOAD_A, name: "shot.png" },
          { kind: "upload", uploadId: UPLOAD_B, name: "Shot.png" },
          { kind: "url", url: "https://example.com" },
        ],
      }),
    );
    expect([...paths.values()]).toEqual(["references/todo/t1/shot.png", "references/todo/t1/Shot-2.png"]);
  });

  it("keeps a name from leaving the folder", () => {
    const paths = attachmentPaths(task({ references: [{ kind: "upload", uploadId: UPLOAD_A, name: "../../x.png" }] }));
    const path = paths.get(UPLOAD_A)!;
    expect(path.startsWith("references/todo/t1/")).toBe(true);
    // One segment after the card's folder: no separator survives.
    expect(path.slice("references/todo/t1/".length)).not.toMatch(/[/\\]/);
  });
});

describe("renderTodoMarkdown", () => {
  it("lists every stage, with the cards in order and their details", () => {
    const md = renderTodoMarkdown([
      task({ id: "b", title: "Second", position: 1 }),
      task({
        id: "a",
        title: "First\nline",
        position: 0,
        description: "Do the thing.",
        references: [
          { kind: "upload", uploadId: UPLOAD_A, name: "mock up.png" },
          { kind: "upload", uploadId: UPLOAD_B, name: "spec.pdf" },
          { kind: "file", path: "src/a.ts" },
          { kind: "url", url: "https://example.com" },
        ],
      }),
      task({ id: "c", stage: "done", title: "Shipped", research: "x".repeat(5000) }),
    ]);
    expect(md).toContain("## Idea (2)");
    expect(md).toContain("## Research (0)");
    expect(md).toContain("## Done (1)");
    expect(md.indexOf("### First line")).toBeLessThan(md.indexOf("### Second"));
    expect(md).toContain("Do the thing.");
    expect(md).toContain("![mock up.png](references/todo/a/mock%20up.png)");
    expect(md).toContain("[spec.pdf](references/todo/a/spec.pdf)");
    expect(md).toContain("- file: `src/a.ts`");
    expect(md).toContain("- <https://example.com>");
    expect(md).toContain("…(truncated)");
  });
});

describe("TodoMirror", () => {
  let root: string;
  let tasks: ProjectTask[];
  let bytes: Map<string, Buffer>;
  let errors: unknown[];
  let mirror: TodoMirror;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ucch-todo-"));
    await mkdir(join(root, ".git"));
    tasks = [];
    bytes = new Map();
    errors = [];
    mirror = new TodoMirror({
      tasks: { list: async () => tasks },
      uploads: { readBytes: async (_p, id) => (bytes.has(id) ? { bytes: bytes.get(id)! } : null) },
      rootOf: () => root,
      onError: (error) => errors.push(error),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes todo.md and copies attachments, then removes them with the card", async () => {
    bytes.set(UPLOAD_A, Buffer.from("png-bytes"));
    tasks = [task({ references: [{ kind: "upload", uploadId: UPLOAD_A, name: "shot.png" }] })];
    await mirror.flush(PROJECT);

    expect(errors).toEqual([]);
    expect(await readFile(join(root, ".agent/todo.md"), "utf8")).toContain("### A task");
    expect(await readFile(join(root, ".agent/references/todo/t1/shot.png"), "utf8")).toBe("png-bytes");

    tasks = [task({ id: "t2", title: "Another" })];
    await mirror.flush(PROJECT);
    expect(await readdir(join(root, ".agent/references/todo"))).toEqual([]);
    const md = await readFile(join(root, ".agent/todo.md"), "utf8");
    expect(md).not.toContain("### A task");
    expect(md).toContain("### Another");
  });

  it("drops an attachment taken off a card", async () => {
    bytes.set(UPLOAD_A, Buffer.from("a"));
    bytes.set(UPLOAD_B, Buffer.from("b"));
    tasks = [
      task({
        references: [
          { kind: "upload", uploadId: UPLOAD_A, name: "a.png" },
          { kind: "upload", uploadId: UPLOAD_B, name: "b.png" },
        ],
      }),
    ];
    await mirror.flush(PROJECT);
    tasks = [task({ references: [{ kind: "upload", uploadId: UPLOAD_A, name: "a.png" }] })];
    await mirror.flush(PROJECT);
    expect(await readdir(join(root, ".agent/references/todo/t1"))).toEqual(["a.png"]);
  });

  it("writes nothing before the project has a checkout", async () => {
    await rm(join(root, ".git"), { recursive: true });
    tasks = [task()];
    await mirror.flush(PROJECT);
    await expect(lstat(join(root, ".agent"))).rejects.toThrow();
  });

  it("refuses to write through a symlinked .agent", async () => {
    const outside = await mkdtemp(join(tmpdir(), "ucch-out-"));
    try {
      await symlink(outside, join(root, ".agent"));
      tasks = [task()];
      await mirror.flush(PROJECT);
      expect(String(errors[0])).toMatch(/symlink/);
      expect(await readdir(outside)).toEqual([]);
    } finally {
      await rm(outside, { recursive: true, force: true });
    }
  });
});
