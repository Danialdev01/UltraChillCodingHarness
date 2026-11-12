import { readFile, readdir, rm, rmdir } from "node:fs/promises";
import { join } from "node:path";

import type { NoteDoc } from "@ucch/protocol";

import { agentPath, Debouncer, hasCheckout, slugify, writeIfChanged } from "./agent-sync.js";
import { richMarkdown } from "./note-markdown.js";
import { digest, noteDigest, readNoteFiles, reconcileNotes, saveNoteState, type NoteFileChanges } from "./note-files.js";
import { refreshIndexFiles } from "./dev-database.js";

/**
 * `.agent/notes/`: the Knowledge section's notes as Markdown, for agents.
 *
 * Markdown and the editor synchronize in both directions, with persisted
 * baselines detecting concurrent changes before exporting.
 */

export const NOTES_DIR = "notes";
/** Images placed in notes, copied out of the app's uploads, one folder per note. */
export const NOTE_REFERENCES = "references/notes";

/** An image placed in a note: the app serves it at `/api/projects/<hash>/uploads/<uuid>/content`. */
const UPLOAD_SRC = /\/api\/projects\/[^/\s)]+\/uploads\/([0-9a-f-]{36})\/content(?:\?[^\s)]*)?/gi;

const IMAGE_EXT: Record<string, string> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/gif": ".gif",
  "image/webp": ".webp",
  "image/svg+xml": ".svg",
  "image/avif": ".avif",
  "image/bmp": ".bmp",
};

/** The file name an uploaded image gets under `references/notes/<note id>/`. */
export function noteImageName(uploadId: string, contentType: string): string {
  return `${uploadId}${IMAGE_EXT[contentType.split(";")[0]!.trim().toLowerCase()] ?? ""}`;
}

/** The uploads a note's image blocks show, in order, each once. */
export function noteImageUploads(doc: NoteDoc): string[] {
  const ids = new Set<string>();
  const walk = (node: Node) => {
    if (node.type === "image") {
      for (const match of str(node.attrs?.src).matchAll(UPLOAD_SRC)) ids.add(match[1]!.toLowerCase());
    }
    children(node).forEach(walk);
  };
  walk(doc as Node);
  return [...ids];
}

export interface MirroredNote {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  cover?: string | null;
  position: number;
  content: NoteDoc;
  updatedAt: string;
}

interface Node {
  type?: string;
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type?: string; attrs?: Record<string, unknown> }[];
  content?: Node[];
}

/** Turns a note id into the link to its file, relative to the note being rendered, and its title. */
export type LinkFor = (noteId: string) => { href: string; title: string } | null;

const str = (value: unknown): string => (typeof value === "string" ? value : "");

function children(node: Node): Node[] {
  return Array.isArray(node.content) ? node.content.filter((c): c is Node => !!c && typeof c === "object") : [];
}

function plain(node: Node): string {
  if (typeof node.text === "string") return node.text;
  return children(node).map(plain).join("");
}

function inlineText(nodes: Node[], linkFor: LinkFor): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text": {
        let text = node.text ?? "";
        const marks = new Set((node.marks ?? []).map((m) => m.type));
        if (marks.has("code")) text = `\`${text}\``;
        else {
          if (marks.has("bold")) text = `**${text}**`;
          if (marks.has("italic")) text = `*${text}*`;
          if (marks.has("strike")) text = `~~${text}~~`;
          if (marks.has("highlight")) text = `==${text}==`;
        }
        const link = node.marks?.find((m) => m.type === "link");
        if (link) text = `[${text}](${str(link.attrs?.href)})`;
        out += text;
        break;
      }
      case "hardBreak":
        out += "  \n";
        break;
      case "pageLink": {
        const id = str(node.attrs?.noteId);
        const target = id ? linkFor(id) : null;
        const label = target?.title || str(node.attrs?.title) || plain(node) || "page";
        out += target ? `[${label}](${target.href})` : label;
        break;
      }
      case "mention":
        out += `@${str(node.attrs?.label) || str(node.attrs?.id)}`;
        break;
      case "emoji":
        out += str(node.attrs?.emoji) || str(node.attrs?.name);
        break;
      default:
        out += plain(node);
    }
  }
  return out;
}

function indent(text: string, by: string): string {
  return text
    .split("\n")
    .map((line, i) => (i === 0 || !line ? line : by + line))
    .join("\n");
}

function blocks(nodes: Node[], linkFor: LinkFor): string {
  return nodes
    .map((n) => block(n, linkFor))
    .filter((b) => b.trim() !== "")
    .join("\n\n");
}

function listItems(node: Node, linkFor: LinkFor, marker: (i: number) => string): string {
  return children(node)
    .map((item, i) => {
      const prefix =
        item.type === "taskItem" ? `${marker(i)}[${item.attrs?.checked ? "x" : " "}] ` : marker(i);
      const body = blocks(children(item), linkFor);
      return prefix + indent(body, " ".repeat(prefix.length));
    })
    .join("\n");
}

function block(node: Node, linkFor: LinkFor): string {
  const kids = children(node);
  switch (node.type) {
    case "doc":
      return blocks(kids, linkFor);
    case "paragraph":
      return inlineText(kids, linkFor);
    case "heading": {
      const level = Math.min(Math.max(Number(node.attrs?.level) || 1, 1), 6);
      return `${"#".repeat(level)} ${inlineText(kids, linkFor)}`;
    }
    case "bulletList":
    case "taskList":
      return listItems(node, linkFor, () => "- ");
    case "orderedList": {
      const start = Number(node.attrs?.start) || 1;
      return listItems(node, linkFor, (i) => `${start + i}. `);
    }
    case "codeBlock": {
      const code = plain(node);
      const fence = code.includes("```") ? "~~~~" : "```";
      return `${fence}${str(node.attrs?.language)}\n${code}\n${fence}`;
    }
    case "mermaid":
      return `\`\`\`mermaid\n${str(node.attrs?.code)}\n\`\`\``;
    case "blockquote":
      return blocks(kids, linkFor)
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    case "callout": {
      const body = blocks(kids, linkFor);
      return `${str(node.attrs?.emoji) || "💡"} ${body}`
        .split("\n")
        .map((l) => (l ? `> ${l}` : ">"))
        .join("\n");
    }
    case "horizontalRule":
      return "---";
    case "image": {
      const alt = str(node.attrs?.alt) || str(node.attrs?.caption);
      const caption = str(node.attrs?.caption);
      const image = `![${alt}](${str(node.attrs?.src)})`;
      return caption ? `${image}\n*${caption}*` : image;
    }
    case "embed": {
      const url = str(node.attrs?.original) || str(node.attrs?.src);
      return url ? `<${url}>` : "";
    }
    case "details": {
      const summary = kids.find((k) => k.type === "detailsSummary");
      const content = kids.find((k) => k.type === "detailsContent");
      const title = summary ? inlineText(children(summary), linkFor) : "Details";
      return `<details><summary>${title}</summary>\n\n${content ? blocks(children(content), linkFor) : ""}\n\n</details>`;
    }
    case "table":
      return table(node, linkFor);
    case "tldraw":
      return "_[whiteboard drawing; open the note in the app to see it]_";
    case "drawio":
      return "_[draw.io diagram; open the note in the app to see it]_";
    default:
      // columns, column, detailsContent and anything newer: their blocks, in order.
      return kids.length > 0 && kids.some((k) => k.type !== "text") ? blocks(kids, linkFor) : inlineText(kids, linkFor);
  }
}

function table(node: Node, linkFor: LinkFor): string {
  const rows = children(node).map((row) =>
    children(row).map((cell) => blocks(children(cell), linkFor).replace(/\n+/g, " ").replace(/\|/g, "\\|")),
  );
  if (rows.length === 0) return "";
  const width = Math.max(...rows.map((r) => r.length));
  const pad = (r: string[]) => [...r, ...Array(width - r.length).fill("")];
  const line = (r: string[]) => `| ${pad(r).join(" | ")} |`;
  return [line(rows[0]!), line(Array(width).fill("---")), ...rows.slice(1).map(line)].join("\n");
}

/** A note's body as Markdown. */
export function noteToMarkdown(doc: NoteDoc, linkFor: LinkFor = () => null): string {
  return block(doc as Node, linkFor).trim();
}

/**
 * Where each note goes under `.agent/notes/`: the root page is `index.md`, a
 * page with children is `<slug>/index.md`, any other `<slug>.md`. Slugs are
 * unique among siblings.
 */
export function notePaths(notes: readonly MirroredNote[]): Map<string, string> {
  const byParent = new Map<string | null, MirroredNote[]>();
  for (const note of notes) {
    const list = byParent.get(note.parentId) ?? [];
    list.push(note);
    byParent.set(note.parentId, list);
  }
  const paths = new Map<string, string>();
  const place = (parentId: string, dir: string, depth: number) => {
    if (depth > 32) return;
    const siblings = (byParent.get(parentId) ?? []).sort((a, b) => a.position - b.position);
    const used = new Set<string>(["index"]);
    for (const note of siblings) {
      const base = slugify(note.title, "untitled");
      let slug = base;
      for (let n = 2; used.has(slug); n++) slug = `${base}-${n}`;
      used.add(slug);
      const hasKids = (byParent.get(note.id) ?? []).length > 0;
      const prefix = dir ? `${dir}/` : "";
      paths.set(note.id, hasKids ? `${prefix}${slug}/index.md` : `${prefix}${slug}.md`);
      if (hasKids) place(note.id, `${prefix}${slug}`, depth + 1);
    }
  };
  for (const root of byParent.get(null) ?? []) {
    paths.set(root.id, "index.md");
    place(root.id, "", 0);
  }
  return paths;
}

/** The relative link from one file under `notes/` to another. */
function relativeLink(from: string, to: string): string {
  const fromParts = from.split("/").slice(0, -1);
  const toParts = to.split("/");
  let common = 0;
  while (common < fromParts.length && fromParts[common] === toParts[common]) common++;
  const up = fromParts.length - common;
  return encodeURI([...Array(up).fill(".."), ...toParts.slice(common)].join("/") || to);
}

/**
 * Every note's file, path to contents. `images` maps an upload id to where
 * its copy is, relative to `.agent/`; an image without one keeps the app's URL.
 */
export function renderNotes(
  notes: readonly MirroredNote[],
  images: ReadonlyMap<string, string> = new Map(),
  legacy = false,
): Map<string, string> {
  const paths = notePaths(notes);
  const files = new Map<string, string>();
  for (const note of notes) {
    const path = paths.get(note.id);
    if (!path) continue;
    const linkFor: LinkFor = (id) => {
      const target = paths.get(id);
      const linked = notes.find((n) => n.id === id);
      return target && linked ? { href: relativeLink(path, target), title: linked.title || "Untitled" } : null;
    };
    const title = `${note.icon ? `${note.icon} ` : ""}${note.title.replace(/\s+/g, " ").trim() || "Untitled"}`;
    const render = (doc: NoteDoc) => noteToMarkdown(doc, linkFor).replace(UPLOAD_SRC, (url, id: string) => {
      const copy = images.get(id.toLowerCase());
      return copy ? relativeLink(`${NOTES_DIR}/${path}`, copy) : url;
    });
    const body = legacy ? render(note.content) : richMarkdown(note.content, render);
    files.set(
      path,
      legacy ? `# ${title}\n\n<!-- note:${note.id} · generated from the app's Knowledge notes; edit it there, changes made here are overwritten -->\n${body ? `\n${body}\n` : ""}` : `---\nucch: ${JSON.stringify({ id: note.id, title: note.title, parentId: note.parentId, icon: note.icon, cover: note.cover ?? null, position: note.position })}\n---\n\n${body}\n`,
    );
  }
  return files;
}

export interface NotesMirrorDeps {
  notes(projectId: string): Promise<MirroredNote[]>;
  uploads: { readBytes(projectId: string, uploadId: string): Promise<{ bytes: Buffer; contentType: string } | null> };
  rootOf(projectId: string): string;
  onError(error: unknown, projectId: string): void;
  delayMs?: number;
  changes?: NoteFileChanges;
}

/** Keeps `.agent/notes/` in step with a project's notes. */
export class NotesMirror {
  readonly #debounce: Debouncer;
  readonly errors = new Map<string, string>();

  constructor(private readonly deps: NotesMirrorDeps) {
    this.#debounce = new Debouncer(deps.delayMs ?? 500, async (id) => { await this.#write(id); this.errors.delete(id); }, (error, id) => { this.errors.set(id, String(error)); deps.onError(error, id); });
  }

  schedule(projectId: string): void {
    this.#debounce.schedule(projectId);
  }

  flush(projectId: string): Promise<void> {
    return this.#debounce.flush(projectId);
  }

  async #write(projectId: string): Promise<void> {
    const root = this.deps.rootOf(projectId);
    if (!(await hasCheckout(root))) return;
    let notes = await this.deps.notes(projectId);

    // Images first, so the Markdown can point at the copies.
    let changed = false;
    const images = new Map<string, string>();
    const keep = new Map<string, Set<string>>();
    for (const note of notes) {
      for (const uploadId of noteImageUploads(note.content)) {
        const upload = await this.deps.uploads.readBytes(projectId, uploadId);
        if (!upload) continue;
        const name = noteImageName(uploadId, upload.contentType);
        const rel = `${NOTE_REFERENCES}/${note.id}/${name}`;
        if (await writeIfChanged(await agentPath(root, rel), upload.bytes)) changed = true;
        // The first note to show an image is where the one copy lives.
        if (!images.has(uploadId)) images.set(uploadId, rel);
        const names = keep.get(note.id) ?? new Set<string>();
        names.add(name);
        keep.set(note.id, names);
      }
    }
    const refsDir = await agentPath(root, NOTE_REFERENCES);
    for (const entry of this.deps.changes ? [] : await readdir(refsDir, { withFileTypes: true }).catch(() => [])) {
      const wanted = entry.isDirectory() ? keep.get(entry.name) : undefined;
      if (!wanted) {
        await rm(join(refsDir, entry.name), { recursive: true, force: true });
        changed = true;
        continue;
      }
      for (const file of await readdir(join(refsDir, entry.name)).catch(() => [])) {
        if (!wanted.has(file)) {
          await rm(join(refsDir, entry.name, file), { force: true });
          changed = true;
        }
      }
    }

    let before: Map<string, string> | undefined;
    if (this.deps.changes) {
      // Seed the migration baseline only for byte-identical legacy exports.
      const existing = await readNoteFiles(root);
      const statePath = await agentPath(root, "cache/notes-sync.json");
      if (!(await readFile(statePath).catch(() => null))) {
        const legacy = renderNotes(notes, images, true);
        const state: Record<string, { id: string; file: string; note: string }> = {};
        const paths = notePaths(notes);
        for (const note of notes) {
          const path = paths.get(note.id)!;
          if (existing.get(path) === legacy.get(path)) state[path] = { id: note.id, file: digest(existing.get(path)!), note: noteDigest(note) };
        }
        await writeIfChanged(statePath, JSON.stringify(state));
      }
      before = await reconcileNotes(root, projectId, notes, this.deps.changes);
      notes = await this.deps.notes(projectId);
    }
    const files = renderNotes(notes, images);
    if (before) {
      const now = await readNoteFiles(root);
      if (JSON.stringify([...now]) !== JSON.stringify([...before])) throw new Error("Documentation changed during synchronization; retrying is required");
    }
    for (const [path, content] of files) {
      if (await writeIfChanged(await agentPath(root, `${NOTES_DIR}/${path}`), content)) changed = true;
    }

    // Deleted, renamed or moved notes: whatever the folder holds that is no longer a note goes.
    const base = await agentPath(root, NOTES_DIR);
    const sweep = async (rel: string): Promise<void> => {
      const entries = await readdir(join(base, rel), { withFileTypes: true }).catch(() => []);
      for (const entry of entries) {
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          await sweep(path);
          await rmdir(join(base, path)).catch(() => {});
        } else if (!files.has(path) && (!before || before.has(path))) {
          await rm(join(base, path), { force: true });
          changed = true;
        }
      }
    };
    await sweep("");

    if (this.deps.changes) await saveNoteState(root, files, notes);
    if (changed) await refreshIndexFiles(root);
  }
}
