/**
 * What a collaborative document's name says it is. The name is the only
 * thing a client sends to say what it wants to edit, so it is parsed
 * strictly: anything else is refused before a hook touches the database.
 */
export type DocumentRef =
  | { kind: "note"; noteId: string }
  | { kind: "file"; projectId: string; worktreeId: string; path: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A session's worktree, by its hash; empty for the project's own checkout. */
const WORKTREE = /^(|[a-z0-9]{12})$/;

/**
 * `note:{noteId}`, or `file:{projectId}:{worktreeId}:{path}`. The path is
 * the rest of the name, colons and all; it is checked by the API, which
 * reads and writes the file, against the same rules as every other path.
 */
export function parseDocumentName(name: string): DocumentRef | null {
  const note = /^note:(.+)$/.exec(name);
  if (note) return UUID.test(note[1]!) ? { kind: "note", noteId: note[1]! } : null;
  const file = /^file:([^:]+):([^:]*):(.+)$/.exec(name);
  if (file) {
    const [, projectId, worktreeId, path] = file as unknown as [string, string, string, string];
    if (!UUID.test(projectId) || !WORKTREE.test(worktreeId) || path.length > 1024) return null;
    return { kind: "file", projectId, worktreeId, path };
  }
  return null;
}

export function noteDocumentName(noteId: string): string {
  return `note:${noteId}`;
}

export function fileDocumentName(projectId: string, worktreeId: string, path: string): string {
  return `file:${projectId}:${worktreeId}:${path}`;
}

/** The `Y.Text` a file's document keeps its text in, which the code editor binds to. */
export const FILE_FIELD = "text";

/** The Collaboration extension's default field: where Tiptap keeps the document. */
export const NOTE_FIELD = "default";
