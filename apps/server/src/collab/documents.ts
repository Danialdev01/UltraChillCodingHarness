/**
 * What a collaborative document's name says it is. The name is the only
 * thing a client sends to say what it wants to edit, so it is parsed
 * strictly: anything else is refused before a hook touches the database.
 */
export type DocumentRef =
  | { kind: "note"; noteId: string }
  | { kind: "file"; projectId: string; worktreeId: string; path: string };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export function parseDocumentName(name: string): DocumentRef | null {
  const note = /^note:(.+)$/.exec(name);
  if (note) return UUID.test(note[1]!) ? { kind: "note", noteId: note[1]! } : null;
  return null;
}

export function noteDocumentName(noteId: string): string {
  return `note:${noteId}`;
}

/** The Collaboration extension's default field: where Tiptap keeps the document. */
export const NOTE_FIELD = "default";
