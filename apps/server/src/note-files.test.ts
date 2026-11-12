import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtemp, mkdir, readFile, writeFile, rm, rename, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { NotesMirror, noteToMarkdown, renderNotes, type MirroredNote } from "./agent-notes.js";
import { markdownToNote, richMarkdown } from "./note-markdown.js";
import { parseNoteFile } from "./note-files.js";

const content = (text: string) => ({ type: "doc" as const, content: [{ type: "paragraph", content: [{ type: "text", text }] }] });

describe("editable Markdown", () => {
  it("round trips rich content, custom attributes, links and empty paragraphs", () => {
    const doc = { type: "doc" as const, content: [
      ...content("hello").content,
      { type: "paragraph", attrs: { textAlign: "center" }, content: [{ type: "pageLink", attrs: { noteId: "abc" } }] },
      { type: "paragraph" },
      { type: "tldraw", attrs: { snapshot: { shapes: ["a"] } } },
      { type: "drawio", attrs: { xml: "<diagram>```</diagram>" } },
      { type: "embed", attrs: { src: "https://example.com" } },
      { type: "image", attrs: { src: "/api/image", alt: "caption", width: 50 } },
    ] };
    const markdown = richMarkdown(doc, noteToMarkdown);
    expect(markdown).toContain("hello");
    expect(markdownToNote(markdown)).toEqual(doc);
    expect(markdownToNote(markdown.replace("hello", "updated")).content?.[0]).toEqual(content("updated").content[0]);
  });
  it("keeps a leading body heading distinct from frontmatter title", () => {
    expect(parseNoteFile('---\nucch: {"title":"Page"}\n---\n\n# Heading\n', "page.md").content.content?.[0]).toMatchObject({ type: "heading" });
  });
});

describe("two-way notes", () => {
  let root: string;
  let notes: MirroredNote[];
  let mirror: NotesMirror;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ucch-note-sync-"));
    await mkdir(join(root, ".git"));
    const home: MirroredNote = { id: randomUUID(), parentId: null, title: "Home", icon: null, position: 0, content: content("home"), updatedAt: "1" };
    notes = [home, { ...home, id: randomUUID(), parentId: home.id, title: "Page", content: content("original") }];
    mirror = new NotesMirror({ rootOf: () => root, notes: async () => notes, uploads: { readBytes: async () => null }, onError: () => {}, changes: {
      put: async (_project, input, previous) => {
        const next = { ...notes[0]!, ...input, id: previous?.id ?? randomUUID(), updatedAt: String(Date.now()) } as MirroredNote;
        notes = previous ? notes.map(n => n.id === previous.id ? next : n) : [...notes, next];
        return next;
      },
      remove: async (_project, note) => { notes = notes.filter(n => n.id !== note.id); },
    } });
  });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });
  const page = () => join(root, ".agent/notes/page.md");
  it("exports, imports edits, and remains stable on repeated synchronization", async () => {
    await mirror.flush("p");
    await writeFile(page(), (await readFile(page(), "utf8")).replace("original", "agent edit"));
    await mirror.flush("p");
    expect(mirror.errors.size).toBe(0);
    expect(notes[1]!.content).toEqual(content("agent edit"));
    const saved = await readFile(page(), "utf8");
    await mirror.flush("p");
    expect(await readFile(page(), "utf8")).toBe(saved);
  });
  it("imports new pages, renames and deletions", async () => {
    await mirror.flush("p");
    await writeFile(join(root, ".agent/notes/new.md"), "# New\n\nNew body");
    await mirror.flush("p");
    expect(notes.find(n => n.title === "New")?.content).toEqual(content("New body"));
    await rename(page(), join(root, ".agent/notes/renamed.md"));
    await mirror.flush("p");
    expect(mirror.errors.size).toBe(0);
    expect(notes.some(n => n.title === "renamed")).toBe(true);
    await rm(join(root, ".agent/notes/renamed.md"));
    await mirror.flush("p");
    expect(notes.some(n => n.title === "renamed")).toBe(false);
  });
  it("preserves both conflicting versions and requires an explicit file edit to resolve", async () => {
    await mirror.flush("p");
    notes[1] = { ...notes[1]!, content: content("editor edit") };
    await writeFile(page(), (await readFile(page(), "utf8")).replace("original", "file edit"));
    await mirror.flush("p");
    expect(mirror.errors.get("p")).toContain("conflict");
    expect(notes[1]!.content).toEqual(content("editor edit"));
    await mirror.flush("p");
    expect(mirror.errors.get("p")).toContain("conflict");
    expect(await readFile(join(root, `.agent/conflicts/${notes[1]!.id}-editor.md`), "utf8")).toContain("editor edit");
    await writeFile(page(), (await readFile(page(), "utf8")).replace("file edit", "resolved"));
    await mirror.flush("p");
    expect(mirror.errors.size).toBe(0);
    expect(notes[1]!.content).toEqual(content("resolved"));
  });
  it("upgrades unchanged legacy exports and protects modified legacy files", async () => {
    await mkdir(join(root, ".agent/notes"), { recursive: true });
    for (const [path, text] of renderNotes(notes, new Map(), true)) await writeFile(join(root, ".agent/notes", path), text);
    await mirror.flush("p");
    expect(mirror.errors.size).toBe(0);
    expect(await readFile(page(), "utf8")).toContain("ucch:");
  });
  it("does not overwrite modified legacy exports during migration", async () => {
    await mkdir(join(root, ".agent/notes"), { recursive: true });
    for (const [path, text] of renderNotes(notes, new Map(), true)) await writeFile(join(root, ".agent/notes", path), text.replace("original", "external legacy edit"));
    await mirror.flush("p");
    expect(mirror.errors.get("p")).toContain("Legacy documentation needs review");
    expect(await readFile(page(), "utf8")).toContain("external legacy edit");
    expect(notes[1]!.content).toEqual(content("original"));
  });
  it("refuses symlinks and retains files when importing fails", async () => {
    await mirror.flush("p");
    await symlink(page(), join(root, ".agent/notes/link.md"));
    await mirror.flush("p");
    expect(mirror.errors.get("p")).toContain("symlink");
    expect(await readFile(page(), "utf8")).toContain("original");
  });
  it("leaves invalid Markdown untouched", async () => {
    await mirror.flush("p");
    await writeFile(page(), "---\nucch: INVALID\n---\n");
    await mirror.flush("p");
    expect(mirror.errors.size).toBe(1);
    expect(await readFile(page(), "utf8")).toContain("INVALID");
  });
});
