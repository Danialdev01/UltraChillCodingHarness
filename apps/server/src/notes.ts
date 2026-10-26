import { and, asc, desc, eq, ilike, isNull, or, sql } from "drizzle-orm";
import { noteYdocs, notes, type Database, type Note, type Transaction } from "@ucch/db";
import { NOTE_TITLE_MAX, noteText, snippetAround, type NoteDoc } from "@ucch/protocol";

/**
 * A note as the tree lists it: everything but the body, which can be large
 * and is fetched one page at a time.
 */
export interface NoteSummary {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  cover: string | null;
  position: number;
  updatedAt: string;
}

/** A page a search found, with the text around the match when it was in the body. */
export interface NoteSearchHit {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  snippet: string;
}

/** A note with its body, as the editor opens it. */
export interface NoteRecord extends NoteSummary {
  content: NoteDoc;
  createdAt: string;
}

export type NoteWriteOutcome =
  /** `before` is the title and text as they were, for the activity log. */
  | { note: NoteRecord; before: { title: string; text: string } }
  | { conflict: NoteRecord }
  | null;

/**
 * A project's notes: a tree of pages with one root.
 *
 * Every method takes the project id first and scopes its query by it, so a
 * note id from another project is simply not found -- the route resolves
 * the project through `findByHash` and the ownership check happens once,
 * there.
 */
export class NotesService {
  constructor(private readonly db: Database) {}

  /**
   * The project's root page, created on first sight.
   *
   * Insert-then-select rather than select-then-insert: the partial unique
   * index on `(project_id) where parent_id is null` makes the insert a no-op
   * when two tabs open the notes at once, and neither ends up with a second
   * root.
   */
  async ensureRoot(projectId: string, projectName: string): Promise<NoteSummary> {
    await this.db
      .insert(notes)
      .values({
        projectId,
        parentId: null,
        title: projectName.slice(0, NOTE_TITLE_MAX),
        updatedAt: stamp(),
      })
      .onConflictDoNothing();
    const [row] = await this.db
      .select(summaryColumns)
      .from(notes)
      .where(and(eq(notes.projectId, projectId), isNull(notes.parentId)))
      .limit(1);
    return summary(row!);
  }

  /** Every page in the project, parents before children within a level. */
  async list(projectId: string, db: Database | Transaction = this.db): Promise<NoteSummary[]> {
    const rows = await db
      .select(summaryColumns)
      .from(notes)
      .where(eq(notes.projectId, projectId))
      .orderBy(asc(notes.parentId), asc(notes.position), asc(notes.createdAt));
    return rows.map(summary);
  }

  async get(projectId: string, noteId: string): Promise<NoteRecord | null> {
    const [row] = await this.db
      .select()
      .from(notes)
      .where(and(eq(notes.projectId, projectId), eq(notes.id, noteId)))
      .limit(1);
    return row ? record(row) : null;
  }

  /**
   * A new page under `parentId`, at the end of its siblings or right after
   * `afterId`. Null when the parent is not in this project.
   */
  async create(
    projectId: string,
    input: { parentId: string; title?: string; afterId?: string },
  ): Promise<NoteRecord | null> {
    return this.db.transaction(async (tx) => {
      const [parent] = await tx
        .select({ id: notes.id })
        .from(notes)
        .where(and(eq(notes.projectId, projectId), eq(notes.id, input.parentId)))
        .limit(1);
      if (!parent) return null;

      const siblings = await tx
        .select(summaryColumns)
        .from(notes)
        .where(and(eq(notes.projectId, projectId), eq(notes.parentId, input.parentId)))
        .orderBy(asc(notes.position), asc(notes.createdAt));

      const afterIndex = input.afterId ? siblings.findIndex((s) => s.id === input.afterId) : -1;
      const position = afterIndex === -1 ? siblings.length : afterIndex + 1;

      const [row] = await tx
        .insert(notes)
        .values({
          projectId,
          parentId: input.parentId,
          title: (input.title ?? "Untitled").slice(0, NOTE_TITLE_MAX) || "Untitled",
          position,
          updatedAt: stamp(),
        })
        .returning();

      // Make room when inserted in the middle: everything from the slot on
      // moves down one. Renumbering the whole level keeps positions dense.
      if (position < siblings.length) {
        const order = [...siblings.map((s) => s.id)];
        order.splice(position, 0, row!.id);
        await renumberRows(tx, order);
      }
      return record(row!);
    });
  }

  /**
   * Writes the fields given. With `ifUpdatedAt`, only if the note has not
   * changed since -- a stale tab then gets the current note back as a
   * conflict rather than overwriting what another one saved.
   */
  async update(
    projectId: string,
    noteId: string,
    patch: {
      title?: string;
      icon?: string | null;
      cover?: string | null;
      content?: NoteDoc;
      ifUpdatedAt?: string;
    },
  ): Promise<NoteWriteOutcome> {
    const set: Partial<typeof notes.$inferInsert> = { updatedAt: stamp() };
    if (patch.title !== undefined) set.title = patch.title.slice(0, NOTE_TITLE_MAX) || "Untitled";
    if (patch.icon !== undefined) set.icon = patch.icon;
    if (patch.cover !== undefined) set.cover = patch.cover;
    if (patch.content !== undefined) {
      set.content = patch.content;
      // Kept in step with the body on every write, so search reads a column.
      set.searchText = noteText(patch.content);
    }

    const conditions = [eq(notes.projectId, projectId), eq(notes.id, noteId)];
    if (patch.ifUpdatedAt) conditions.push(eq(notes.updatedAt, new Date(patch.ifUpdatedAt)));

    const [before] = await this.db
      .select({ title: notes.title, text: notes.searchText })
      .from(notes)
      .where(and(eq(notes.projectId, projectId), eq(notes.id, noteId)))
      .limit(1);
    const [row] = await this.db.update(notes).set(set).where(and(...conditions)).returning();
    if (row && patch.content !== undefined) {
      // Written past the collab service (it was down): its stored state no
      // longer matches, and is seeded again from this body when next opened.
      await this.db.delete(noteYdocs).where(eq(noteYdocs.noteId, noteId));
    }
    if (row) return { note: record(row), before: before ?? { title: row.title, text: "" } };

    const current = await this.get(projectId, noteId);
    return current ? { conflict: current } : null;
  }

  /**
   * Reparents and/or reorders a page.
   *
   * Refused for the root, and for a destination inside the page's own
   * subtree -- a page under itself is unreachable from the root, and the
   * cascade on delete would have nothing to hang it from.
   */
  async move(
    projectId: string,
    noteId: string,
    to: { parentId: string; position: number; ifParentId?: string },
  ): Promise<NoteSummary[] | "root" | "cycle" | "conflict" | null> {
    return this.db.transaction(async (tx) => {
      const rows = (
        await tx.select(summaryColumns).from(notes).where(eq(notes.projectId, projectId))
      ).map(summary);
      const note = rows.find((n) => n.id === noteId);
      if (!note) return null;
      if (note.parentId === null) return "root";
      // Dragged from where this tab last saw it; somebody has since moved it
      // somewhere else, and dropping it here would undo that unseen.
      if (to.ifParentId && note.parentId !== to.ifParentId) return "conflict";
      if (!rows.some((n) => n.id === to.parentId)) return null;
      if (to.parentId === noteId || isDescendant(rows, noteId, to.parentId)) return "cycle";

      const siblings = rows
        .filter((n) => n.parentId === to.parentId && n.id !== noteId)
        .sort((a, b) => a.position - b.position)
        .map((n) => n.id);
      const order = renumber(siblings, noteId, to.position);

      await tx
        .update(notes)
        .set({ parentId: to.parentId })
        .where(and(eq(notes.projectId, projectId), eq(notes.id, noteId)));
      await renumberRows(tx, order);

      // The old level keeps its order; only the gap closes, which the next
      // renumber there does. Positions need only be monotonic, not dense.
      return this.list(projectId, tx);
    });
  }

  /**
   * Pages whose title or body contains `query`, title matches first and the
   * most recently edited before the rest. A body match brings the text
   * around it; a title match brings the start of the page.
   */
  async search(projectId: string, query: string, limit = 20): Promise<NoteSearchHit[]> {
    const q = query.trim();
    if (!q) return [];
    const pattern = `%${escapeLike(q)}%`;
    const titleMatch = ilike(notes.title, pattern);
    const rows = await this.db
      .select({
        id: notes.id,
        parentId: notes.parentId,
        title: notes.title,
        icon: notes.icon,
        searchText: notes.searchText,
        inTitle: sql<boolean>`${titleMatch}`,
      })
      .from(notes)
      .where(and(eq(notes.projectId, projectId), or(titleMatch, ilike(notes.searchText, pattern))))
      .orderBy(desc(sql`${titleMatch}`), desc(notes.updatedAt))
      .limit(limit);
    return rows.map((row) => ({
      id: row.id,
      parentId: row.parentId,
      title: row.title,
      icon: row.icon,
      snippet: snippetAround(row.searchText, row.inTitle ? "" : q),
    }));
  }

  /**
   * Deletes a page and, through the cascade, everything under it. Returns
   * where it was, so readers of it can be sent to its parent.
   */
  async remove(
    projectId: string,
    noteId: string,
  ): Promise<{ parentId: string; title: string } | false | "root"> {
    const [row] = await this.db
      .select({ parentId: notes.parentId, title: notes.title })
      .from(notes)
      .where(and(eq(notes.projectId, projectId), eq(notes.id, noteId)))
      .limit(1);
    if (!row) return false;
    if (row.parentId === null) return "root";
    await this.db.delete(notes).where(and(eq(notes.projectId, projectId), eq(notes.id, noteId)));
    return { parentId: row.parentId, title: row.title };
  }
}

/**
 * Whether `id` sits somewhere below `ancestorId` in the tree.
 *
 * Walks up from `id` rather than down from the ancestor: the path to the
 * root is short and there is exactly one of it. A cycle already in the
 * data -- which the checks here exist to prevent -- terminates on the
 * visited set instead of looping.
 */
export function isDescendant(
  rows: readonly { id: string; parentId: string | null }[],
  ancestorId: string,
  id: string,
): boolean {
  const parentOf = new Map(rows.map((r) => [r.id, r.parentId]));
  const seen = new Set<string>();
  let current = parentOf.get(id) ?? null;
  while (current !== null && !seen.has(current)) {
    if (current === ancestorId) return true;
    seen.add(current);
    current = parentOf.get(current) ?? null;
  }
  return false;
}

/**
 * The sibling order with `movedId` placed at `position`, clamped to the
 * ends. `siblings` is the level without the moved page.
 */
export function renumber(siblings: readonly string[], movedId: string, position: number): string[] {
  const order = siblings.filter((id) => id !== movedId);
  const at = Math.max(0, Math.min(Math.floor(position), order.length));
  order.splice(at, 0, movedId);
  return order;
}

/**
 * A search term as a LIKE pattern fragment: the wildcards a person types
 * are letters to find, not patterns to match.
 */
export function escapeLike(text: string): string {
  return text.replace(/[\\%_]/g, (c) => `\\${c}`);
}

/**
 * Now, at millisecond precision.
 *
 * `updated_at` is compared for equality against an ISO string a client sends
 * back, and an ISO string carries milliseconds. Postgres's `now()` carries
 * microseconds, so a row stamped by the default would never match its own
 * timestamp on the way back in. Every write stamps the column from here.
 */
function stamp(): Date {
  return new Date();
}

const summaryColumns = {
  id: notes.id,
  parentId: notes.parentId,
  title: notes.title,
  icon: notes.icon,
  cover: notes.cover,
  position: notes.position,
  updatedAt: notes.updatedAt,
};

function summary(row: {
  id: string;
  parentId: string | null;
  title: string;
  icon: string | null;
  cover: string | null;
  position: number;
  updatedAt: Date;
}): NoteSummary {
  return {
    id: row.id,
    parentId: row.parentId,
    title: row.title,
    icon: row.icon,
    cover: row.cover,
    position: row.position,
    updatedAt: row.updatedAt.toISOString(),
  };
}

function record(row: Note): NoteRecord {
  return { ...summary(row), content: row.content, createdAt: row.createdAt.toISOString() };
}

/** Writes dense positions 0..n over one level, in the order given. */
async function renumberRows(
  tx: Transaction,
  order: readonly string[],
): Promise<void> {
  for (const [index, id] of order.entries()) {
    await tx.update(notes).set({ position: index }).where(eq(notes.id, id));
  }
}
