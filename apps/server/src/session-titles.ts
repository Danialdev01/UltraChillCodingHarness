import { and, eq, inArray, sql } from "drizzle-orm";
import { events, projects, threads, workspaces, type Database } from "@ucch/db";
import { PLACEHOLDER_TITLES, titleFromPrompt } from "@ucch/protocol";

/** A placeholder-named session and the first thing said in it. */
export interface UntitledSession {
  threadId: string;
  projectId: string;
  /** Whether its project is a session workspace's card, named after it. */
  sessionCard: boolean;
  projectName: string;
  firstText: string;
}

/**
 * The titles to give sessions still named "Untitled" though something was
 * said in them: those whose first message predates the engine titling them
 * (`user.message` in `engine.ts`). Pure, so the rule is the engine's own.
 */
export function backfilledTitles(rows: readonly UntitledSession[]): {
  threads: { id: string; title: string }[];
  projects: { id: string; name: string }[];
} {
  const out = { threads: [] as { id: string; title: string }[], projects: [] as { id: string; name: string }[] };
  const named = new Set<string>();
  for (const row of rows) {
    const title = titleFromPrompt(row.firstText);
    if (!title) continue;
    out.threads.push({ id: row.threadId, title });
    if (row.sessionCard && PLACEHOLDER_TITLES.includes(row.projectName.trim()) && !named.has(row.projectId)) {
      named.add(row.projectId);
      out.projects.push({ id: row.projectId, name: title });
    }
  }
  return out;
}

/**
 * Titles, once, every session left "Untitled" by a server that did not
 * title them yet. Idempotent: a titled session no longer matches. Returns
 * how many it named.
 */
export async function backfillSessionTitles(db: Database): Promise<number> {
  const placeholders = [...PLACEHOLDER_TITLES];
  const first = db
    .selectDistinctOn([events.threadId], {
      threadId: events.threadId,
      text: sql<string>`${events.payload}->>'text'`.as("text"),
    })
    .from(events)
    .where(eq(events.type, "user.message"))
    .orderBy(events.threadId, events.seq)
    .as("first");

  const rows = await db
    .select({
      threadId: threads.id,
      projectId: threads.projectId,
      projectName: projects.name,
      kind: workspaces.kind,
      firstText: first.text,
    })
    .from(threads)
    .innerJoin(first, eq(first.threadId, threads.id))
    .innerJoin(projects, eq(projects.id, threads.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(inArray(threads.title, placeholders));

  const { threads: titled, projects: named } = backfilledTitles(
    rows
      .filter((r) => typeof r.firstText === "string")
      .map((r) => ({
        threadId: r.threadId,
        projectId: r.projectId,
        projectName: r.projectName,
        sessionCard: r.kind === "session",
        firstText: r.firstText,
      })),
  );
  if (titled.length === 0) return 0;

  await db.transaction(async (tx) => {
    for (const t of titled) {
      await tx
        .update(threads)
        .set({ title: t.title })
        .where(and(eq(threads.id, t.id), inArray(threads.title, placeholders)));
    }
    for (const p of named) {
      await tx
        .update(projects)
        .set({ name: p.name })
        .where(and(eq(projects.id, p.id), inArray(projects.name, placeholders)));
    }
  });
  return titled.length;
}
