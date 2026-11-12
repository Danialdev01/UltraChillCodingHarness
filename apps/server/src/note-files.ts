import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { NOTE_CONTENT_MAX_BYTES } from "@ucch/protocol";
import type { MirroredNote } from "./agent-notes.js";
import { agentPath, writeIfChanged } from "./agent-sync.js";
import { markdownToNote } from "./note-markdown.js";

export const digest = (value: unknown): string => createHash("sha256").update(typeof value === "string" ? value : JSON.stringify(value)).digest("hex");
export const noteDigest = (note: MirroredNote): string => digest([note.title, note.icon, note.cover ?? null, note.parentId, note.position, note.content]);
export type FileState = Record<string, { id: string; file: string; note: string; conflict?: string }>;
export interface NoteFileChanges {
  put(projectId: string, note: Partial<MirroredNote> & { title: string; content: MirroredNote["content"] }, previous?: MirroredNote): Promise<MirroredNote>;
  remove(projectId: string, note: MirroredNote): Promise<void>;
}

export async function readNoteFiles(root: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  const walk = async (dir: string) => {
    const path = await agentPath(root, `notes/${dir}`);
    for (const entry of await readdir(path, { withFileTypes: true }).catch((error) => { if (error.code === "ENOENT") return []; throw error; })) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(`Refusing note symlink: ${rel}`);
      if (entry.isDirectory()) await walk(rel);
      else if (entry.isFile() && rel.endsWith(".md")) {
        const text = await readFile(await agentPath(root, `notes/${rel}`), "utf8");
        if (Buffer.byteLength(text) > 8 * 1024 * 1024) throw new Error(`Note too large: ${rel}`);
        files.set(rel, text);
      }
    }
  };
  await walk("");
  return files;
}

export function parseNoteFile(text: string, path: string): Partial<MirroredNote> & { title: string; content: MirroredNote["content"] } {
  let metadata: Partial<MirroredNote> = {};
  const front = /^---\r?\nucch: (.+)\r?\n---\r?\n/.exec(text);
  if (front) { metadata = JSON.parse(front[1]!); text = text.slice(front[0].length); }
  else if (text.startsWith("---\n")) throw new Error(`Invalid note frontmatter: ${path}`);
  if (metadata.id !== undefined && (typeof metadata.id !== "string" || !/^[0-9a-f-]{36}$/i.test(metadata.id))) throw new Error(`Invalid note id: ${path}`);
  if (metadata.title !== undefined && typeof metadata.title !== "string") throw new Error(`Invalid note title: ${path}`);
  if (metadata.parentId !== undefined && metadata.parentId !== null && typeof metadata.parentId !== "string") throw new Error(`Invalid note parent: ${path}`);
  if (metadata.position !== undefined && (!Number.isInteger(metadata.position) || metadata.position < 0)) throw new Error(`Invalid note position: ${path}`);
  for (const key of ["icon", "cover"] as const) if (metadata[key] !== undefined && metadata[key] !== null && typeof metadata[key] !== "string") throw new Error(`Invalid note ${key}: ${path}`);
  const legacy = /<!-- note:([^\s]+) ·[^]*?-->/;
  const id = text.match(legacy)?.[1];
  text = text.replace(legacy, "");
  const heading = front ? null : /^\s*# (.+)\n*/.exec(text);
  if (heading) text = text.slice(heading[0].length);
  const content = markdownToNote(text.trim());
  if (Buffer.byteLength(JSON.stringify(content)) > NOTE_CONTENT_MAX_BYTES) throw new Error(`Documentation exceeds the content limit: ${path}`);
  return { ...metadata, ...(id && !metadata.id ? { id } : {}), title: metadata.title ?? heading?.[1] ?? basename(path, ".md"), content };
}

/** Reconcile before exporting; a conflict leaves both the database and file untouched. */
export async function reconcileNotes(root: string, projectId: string, notes: MirroredNote[], changes: NoteFileChanges): Promise<Map<string, string>> {
  const files = await readNoteFiles(root);
  const statePath = await agentPath(root, "cache/notes-sync.json");
  const state: FileState = JSON.parse(await readFile(statePath, "utf8").catch((e) => { if (e.code === "ENOENT") return "{}"; throw e; }));
  const parsed = new Map([...files].map(([path, text]) => [path, parseNoteFile(text, path)]));
  const seen = new Set<string>();
  for (const [path, note] of parsed) {
    if (note.id && seen.has(note.id)) throw new Error(`Duplicate note id in ${path}`);
    if (note.id) seen.add(note.id);
    const previous = notes.find(n => n.id === note.id);
    const baseline = Object.values(state).find(s => s.id === note.id);
    const changed = !baseline || baseline.file !== digest(files.get(path)!) || Object.keys(state).find(key => state[key]?.id === note.id) !== path;
    if (baseline?.conflict === digest(files.get(path)!)) throw new Error(`Documentation conflict in ${path}. Compare .agent/conflicts/ and edit the Markdown file to resolve it.`);
    if (changed && previous && baseline && baseline.note !== noteDigest(previous)) {
      const saved = `---\nucch: ${JSON.stringify({ id: previous.id, title: previous.title, parentId: previous.parentId, icon: previous.icon, cover: previous.cover, position: previous.position })}\n---\n\n` + (previous.content.content ?? []).map(node => `\`\`\`ucch-node\n${JSON.stringify(node)}\n\`\`\``).join("\n\n");
      await writeIfChanged(await agentPath(root, `conflicts/${previous.id}-editor.md`), saved);
      await writeIfChanged(await agentPath(root, `conflicts/${previous.id}-file.md`), files.get(path)!);
      baseline.note = noteDigest(previous);
      baseline.conflict = digest(files.get(path)!);
      await writeIfChanged(statePath, JSON.stringify(state));
      throw new Error(`Documentation conflict in ${path}. Both versions saved in .agent/conflicts/; edit the Markdown file to resolve it.`);
    }
  }
  for (const [path, baseline] of Object.entries(state)) {
    const previous = notes.find(n => n.id === baseline.id);
    if (!files.has(path) && !seen.has(baseline.id) && previous && (noteDigest(previous) !== baseline.note || previous.parentId === null)) throw new Error(`Documentation deletion conflict: ${path}`);
  }
  // Import parents before children. Metadata is authoritative for existing pages.
  for (const [path, input] of [...parsed].sort(([a], [b]) => a.split("/").length - b.split("/").length || (a.endsWith("index.md") ? -1 : 1))) {
    if (!input.id) {
      const hex = digest(`${projectId}/${path}`).slice(0, 32);
      input.id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
    }
    const previous = notes.find(n => n.id === input.id);
    const baseline = Object.values(state).find(s => s.id === input.id);
    const oldPath = Object.keys(state).find(key => state[key]?.id === input.id);
    const moved = oldPath !== undefined && oldPath !== path;
    if (baseline?.file === digest(files.get(path)!) && !moved) continue;
    if (moved) {
      input.title = basename(path) === "index.md" ? basename(dirname(path)) : basename(path, ".md");
      const container = basename(path) === "index.md" ? dirname(dirname(path)) : dirname(path);
      input.parentId = parsed.get(container === "." ? "index.md" : `${container}/index.md`)?.id ?? notes.find(n => n.parentId === null)?.id;
    }
    // Legacy generated files can be upgraded without parsing their lossy representation.
    if (!baseline && previous && files.get(path)!.includes("generated from the app's Knowledge notes") && files.get(path)!.includes("changes made here are overwritten")) {
      throw new Error(`Legacy documentation needs review before migration: ${path}`);
    }
    const parentPath = dirname(path) === "." ? "index.md" : `${dirname(path)}/index.md`;
    const parent = parsed.get(parentPath)?.id ?? notes.find(n => n.parentId === null)?.id;
    const note = await changes.put(projectId, { ...input, parentId: input.parentId === undefined ? previous?.parentId ?? parent : input.parentId }, previous);
    input.id = note.id;
    if (previous) notes.splice(notes.indexOf(previous), 1, note); else notes.push(note);
  }
  for (const [path, baseline] of Object.entries(state)) {
    if (files.has(path) || seen.has(baseline.id)) continue;
    const previous = notes.find(n => n.id === baseline.id);
    if (!previous) continue;
    if (noteDigest(previous) !== baseline.note) throw new Error(`Documentation deletion conflict: ${path}`);
    if (previous.parentId === null) throw new Error("The root documentation page cannot be deleted");
    await changes.remove(projectId, previous);
  }
  return files;
}

export async function saveNoteState(root: string, files: Map<string, string>, notes: MirroredNote[]): Promise<void> {
  const state: FileState = {};
  for (const [path, text] of files) {
    const id = parseNoteFile(text, path).id;
    const note = notes.find(n => n.id === id);
    if (note) state[path] = { id: note.id, file: digest(text), note: noteDigest(note) };
  }
  await writeIfChanged(await agentPath(root, "cache/notes-sync.json"), JSON.stringify(state));
}
