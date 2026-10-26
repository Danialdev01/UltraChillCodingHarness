import { eq, sql } from "drizzle-orm";
import { noteYdocs, notes, type Database } from "@ucch/db";
import { noteText, type NoteDoc } from "@ucch/protocol";

import type { NoteDocuments } from "./server.js";

/** Notes' collaborative documents in Postgres: `note_ydocs`, projected to `notes`. */
export function noteDocuments(db: Database): NoteDocuments {
  return {
    async load(noteId) {
      const [row] = await db
        .select({ content: notes.content, state: noteYdocs.state })
        .from(notes)
        .leftJoin(noteYdocs, eq(noteYdocs.noteId, notes.id))
        .where(eq(notes.id, noteId))
        .limit(1);
      return row ? { content: row.content, state: row.state ?? null } : null;
    },

    async seed(noteId, state) {
      await db.insert(noteYdocs).values({ noteId, state }).onConflictDoNothing();
      const [row] = await db.select({ state: noteYdocs.state }).from(noteYdocs).where(eq(noteYdocs.noteId, noteId));
      return row?.state ?? state;
    },

    async store(noteId, state, content: NoteDoc) {
      return db.transaction(async (tx) => {
        const [note] = await tx
          .update(notes)
          .set({ content, searchText: noteText(content), updatedAt: sql`now()` })
          .where(eq(notes.id, noteId))
          .returning({ projectId: notes.projectId });
        // Deleted while open: the cascade took the state too, and there is nothing to keep.
        if (!note) return null;
        await tx
          .insert(noteYdocs)
          .values({ noteId, state })
          .onConflictDoUpdate({ target: noteYdocs.noteId, set: { state, updatedAt: sql`now()` } });
        return { projectId: note.projectId };
      });
    },
  };
}
