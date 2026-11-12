import { mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { NoteDoc } from "@ucch/protocol";

import {
  noteImageUploads,
  notePaths,
  NotesMirror,
  noteToMarkdown,
  renderNotes,
  type MirroredNote,
} from "./agent-notes.js";

const PROJECT = "33333333-3333-3333-3333-333333333333";
const UPLOAD = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const IMAGE_SRC = `/api/projects/abc123/uploads/${UPLOAD}/content`;

const doc = (...content: unknown[]) => ({ type: "doc", content }) as unknown as NoteDoc;
const p = (...content: unknown[]) => ({ type: "paragraph", content });
const text = (t: string, marks?: unknown[]) => ({ type: "text", text: t, ...(marks ? { marks } : {}) });

function note(over: Partial<MirroredNote> & { id: string }): MirroredNote {
  return {
    parentId: null,
    title: "Untitled",
    icon: null,
    position: 0,
    content: doc(),
    updatedAt: "2026-11-01T00:00:00.000Z",
    ...over,
  };
}

describe("noteToMarkdown", () => {
  it("renders the blocks the editor makes", () => {
    const md = noteToMarkdown(
      doc(
        { type: "heading", attrs: { level: 2 }, content: [text("Setup")] },
        p(text("bold", [{ type: "bold" }]), text(" and "), text("code", [{ type: "code" }])),
        p(text("site", [{ type: "link", attrs: { href: "https://x.dev" } }])),
        { type: "bulletList", content: [{ type: "listItem", content: [p(text("one"))] }] },
        { type: "orderedList", attrs: { start: 3 }, content: [{ type: "listItem", content: [p(text("three"))] }] },
        { type: "taskList", content: [{ type: "taskItem", attrs: { checked: true }, content: [p(text("done"))] }] },
        { type: "codeBlock", attrs: { language: "sh" }, content: [text("pnpm dev")] },
        { type: "blockquote", content: [p(text("quoted"))] },
        { type: "mermaid", attrs: { code: "graph TD; A-->B" } },
        { type: "horizontalRule" },
        {
          type: "table",
          content: [
            { type: "tableRow", content: [{ type: "tableHeader", content: [p(text("a|b"))] }] },
            { type: "tableRow", content: [{ type: "tableCell", content: [p(text("1"))] }] },
          ],
        },
        { type: "tldraw" },
      ),
    );
    expect(md).toContain("## Setup");
    expect(md).toContain("**bold** and `code`");
    expect(md).toContain("[site](https://x.dev)");
    expect(md).toContain("- one");
    expect(md).toContain("3. three");
    expect(md).toContain("- [x] done");
    expect(md).toContain("```sh\npnpm dev\n```");
    expect(md).toContain("> quoted");
    expect(md).toContain("```mermaid\ngraph TD; A-->B\n```");
    expect(md).toContain("---");
    expect(md).toContain("| a\\|b |\n| --- |\n| 1 |");
    expect(md).toContain("whiteboard drawing");
  });
});

describe("notePaths", () => {
  it("nests children, and keeps sibling slugs unique", () => {
    const paths = notePaths([
      note({ id: "root", title: "Home" }),
      note({ id: "a", parentId: "root", title: "Guide", position: 0 }),
      note({ id: "b", parentId: "root", title: "Guide", position: 1 }),
      note({ id: "c", parentId: "a", title: "Deep Page" }),
      note({ id: "d", parentId: "root", title: "Index" }),
    ]);
    expect(paths.get("root")).toBe("index.md");
    expect(paths.get("a")).toBe("guide/index.md");
    expect(paths.get("b")).toBe("guide-2.md");
    expect(paths.get("c")).toBe("guide/deep-page.md");
    // "index" is the folder's own page.
    expect(paths.get("d")).toBe("index-2.md");
  });
});

describe("renderNotes", () => {
  const pageLink = (noteId: string) => ({ type: "pageLink", attrs: { noteId } });

  it("links pages to each other by relative path", () => {
    const files = renderNotes([
      note({ id: "root", title: "Home", content: doc(p(pageLink("c"))) }),
      note({ id: "a", parentId: "root", title: "Guide" }),
      note({ id: "c", parentId: "a", title: "Deep", content: doc(p(pageLink("root"))) }),
    ]);
    expect(files.get("index.md")).toContain("[Deep](guide/deep.md)");
    expect(files.get("guide/deep.md")).toContain("[Home](../index.md)");
    expect(files.get("guide/deep.md")).toContain('"title":"Deep"');
  });

  it("points an image at its copy when there is one, and keeps the URL when not", () => {
    const content = doc({ type: "image", attrs: { src: IMAGE_SRC, alt: "diagram" } });
    const notes = [note({ id: "root", title: "Home" }), note({ id: "a", parentId: "root", title: "Page", content })];
    expect(noteImageUploads(content)).toEqual([UPLOAD]);

    const copied = renderNotes(notes, new Map([[UPLOAD, `references/notes/a/${UPLOAD}.png`]]));
    expect(copied.get("page.md")).toContain(`![diagram](../references/notes/a/${UPLOAD}.png)`);

    expect(renderNotes(notes).get("page.md")).toContain(`![diagram](${IMAGE_SRC})`);
  });
});

describe("NotesMirror", () => {
  let root: string;
  let notes: MirroredNote[];
  let errors: unknown[];
  let mirror: NotesMirror;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ucch-notes-"));
    await mkdir(join(root, ".git"));
    notes = [];
    errors = [];
    mirror = new NotesMirror({
      notes: async () => notes,
      uploads: {
        readBytes: async (_p, id) => (id === UPLOAD ? { bytes: Buffer.from("png"), contentType: "image/png" } : null),
      },
      rootOf: () => root,
      onError: (error) => errors.push(error),
    });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("writes each note, copies its images, and removes what was renamed or deleted", async () => {
    notes = [
      note({ id: "root", title: "Home" }),
      note({ id: "a", parentId: "root", title: "Old name", content: doc({ type: "image", attrs: { src: IMAGE_SRC } }) }),
    ];
    await mirror.flush(PROJECT);
    expect(errors).toEqual([]);
    expect(await readFile(join(root, ".agent/notes/old-name.md"), "utf8")).toContain(
      `](../references/notes/a/${UPLOAD}.png)`,
    );
    expect(await readFile(join(root, ".agent/references/notes/a", `${UPLOAD}.png`), "utf8")).toBe("png");

    notes = [note({ id: "root", title: "Home" }), note({ id: "a", parentId: "root", title: "New name" })];
    await mirror.flush(PROJECT);
    expect((await readdir(join(root, ".agent/notes"))).sort()).toEqual(["index.md", "new-name.md"]);
    expect(await readdir(join(root, ".agent/references/notes"))).toEqual([]);
  });
});
