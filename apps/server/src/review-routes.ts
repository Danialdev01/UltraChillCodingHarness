import type { FastifyInstance } from "fastify";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { reviews, type Database } from "@ucch/db";
import { ThreadHash, type ReviewRecord } from "@ucch/protocol";
import type { ProjectSummary } from "./workspaces.js";

type ProjectRequest = { cookies: Record<string, string | undefined>; params: { hash: string }; query?: unknown };

export interface ReviewRouteDeps {
  db: Database;
  /** The caller's project for `:hash`, or null: the gate every project route uses. */
  projectFor(request: ProjectRequest): Promise<ProjectSummary | null>;
  /** The threads working in the tree `?session=` names; empty for a session not in the project. */
  threadsOfTree(projectId: string, sessionHash: string): Promise<string[]>;
}

/** How many reviews the Git view is given: the latest. */
export const REVIEW_PAGE = 20;

/**
 * The reviews of a tree (solution §9.3, OM7.8), newest first:
 * `?session=<hash>` for a project session's worktree, none for the
 * project's checkout. Every thread working in that tree counts: a session a
 * handoff started works in the old one's worktree, and reviews either ran.
 * Running ones are included, so a reload shows a review still going.
 */
export function registerReviewRoutes(app: FastifyInstance, deps: ReviewRouteDeps): void {
  app.get<{ Params: { hash: string } }>("/api/projects/:hash/reviews", async (request, reply) => {
    const project = await deps.projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const query = request.query as { session?: unknown } | undefined;
    const session = typeof query?.session === "string" && query.session ? query.session : null;
    let threadIds: string[] | null = null;
    if (session) {
      if (!ThreadHash.safeParse(session).success) return reply.code(404).send({ error: "session not found" });
      threadIds = await deps.threadsOfTree(project.id, session);
      if (threadIds.length === 0) return reply.code(404).send({ error: "session not found" });
    }
    const rows = await deps.db
      .select()
      .from(reviews)
      .where(and(eq(reviews.projectId, project.id), threadIds ? inArray(reviews.threadId, threadIds) : isNull(reviews.threadId)))
      .orderBy(desc(reviews.createdAt))
      .limit(REVIEW_PAGE);
    return { reviews: rows.map(toRecord) };
  });
}

export function toRecord(row: typeof reviews.$inferSelect): ReviewRecord {
  return {
    id: row.id,
    threadId: row.threadId,
    scope: row.scope,
    ref: row.ref,
    focus: row.focus,
    status: row.status === "completed" || row.status === "failed" ? row.status : "running",
    verdict: row.verdict ?? null,
    findings: row.findings,
    excluded: row.excluded,
    model: row.model,
    costUsd: row.costUsd,
    error: row.error,
    createdAt: row.createdAt.toISOString(),
    completedAt: row.completedAt ? row.completedAt.toISOString() : null,
  };
}
