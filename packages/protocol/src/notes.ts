/**
 * A note's body: a ProseMirror document as the editor's `getJSON()` gives it.
 *
 * Opaque on purpose. The editor's own schema is what decides which nodes are
 * valid, and it is the only thing that parses this; the server stores and
 * returns it without looking inside, beyond checking that it is a document.
 */
export interface NoteDoc {
  type: "doc";
  content?: unknown[];
}

export const EMPTY_NOTE_DOC: NoteDoc = { type: "doc", content: [] };

/** A title is a line in a tree row, not a paragraph. */
export const NOTE_TITLE_MAX = 200;

/**
 * The most a note body may be, as its JSON. Generous because embedded
 * whiteboard snapshots and diagram SVGs live inside the document, but bounded
 * because every autosave sends the whole thing.
 */
export const NOTE_CONTENT_MAX_BYTES = 2 * 1024 * 1024;
