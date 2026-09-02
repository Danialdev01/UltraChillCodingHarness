import { and, asc, eq, sql } from "drizzle-orm";
import { projects, workspaces, type Database } from "@ucch/db";

export interface ProjectSummary {
  id: string;
  hash: string;
  name: string;
  stack: string;
  containerState: string;
  workspaceId?: string;
}

export interface WorkspaceSummary {
  id: string;
  slug: string;
  name: string;
  projectCount: number;
}

/**
 * Workspaces are organisation, not project activity, so they live outside the
 * event log alongside users and sessions and are served over REST. See the
 * scope note at the top of `packages/protocol/src/events.ts`.
 */
export class WorkspaceService {
  constructor(private readonly db: Database) {}

  async list(userId: string): Promise<WorkspaceSummary[]> {
    const rows = await this.db
      .select({
        id: workspaces.id,
        slug: workspaces.slug,
        name: workspaces.name,
        projectCount: sql<number>`count(${projects.id})::int`,
      })
      .from(workspaces)
      .leftJoin(projects, eq(projects.workspaceId, workspaces.id))
      .where(eq(workspaces.ownerUserId, userId))
      .groupBy(workspaces.id)
      .orderBy(asc(workspaces.createdAt));

    return rows;
  }

  async create(userId: string, name: string): Promise<WorkspaceSummary | { conflict: true }> {
    const trimmed = name.trim();
    const slug = await this.#uniqueSlug(userId, trimmed);
    if (!slug) return { conflict: true };

    const [row] = await this.db
      .insert(workspaces)
      .values({ ownerUserId: userId, name: trimmed, slug })
      .returning();

    return { id: row!.id, slug: row!.slug, name: row!.name, projectCount: 0 };
  }

  /**
   * A project by its public hash, scoped to the caller.
   *
   * The ownership check is part of the query rather than a second lookup, so
   * a hash belonging to someone else is indistinguishable from one that does
   * not exist.
   */
  async findByHash(hash: string, userId: string): Promise<ProjectSummary | null> {
    const [row] = await this.db
      .select({
        id: projects.id,
        hash: projects.hash,
        name: projects.name,
        stack: projects.stack,
        containerState: projects.containerState,
        workspaceId: projects.workspaceId,
      })
      .from(projects)
      .innerJoin(workspaces, eq(projects.workspaceId, workspaces.id))
      .where(and(eq(projects.hash, hash), eq(workspaces.ownerUserId, userId)))
      .limit(1);

    return row ?? null;
  }

  /** Projects in a workspace, for the sidebar. Ownership is checked first. */
  async listProjects(workspaceId: string, userId: string): Promise<ProjectSummary[] | null> {
    if (!(await this.ownedBy(workspaceId, userId))) return null;

    return this.db
      .select({
        id: projects.id,
        hash: projects.hash,
        name: projects.name,
        stack: projects.stack,
        containerState: projects.containerState,
      })
      .from(projects)
      .where(eq(projects.workspaceId, workspaceId))
      .orderBy(asc(projects.name));
  }

  /**
   * Confirms the workspace exists AND belongs to this user -- both conditions
   * in one predicate. Checking them separately would let any user who owns
   * some workspace pass the check for somebody else's.
   */
  async ownedBy(workspaceId: string, userId: string): Promise<boolean> {
    const [row] = await this.db
      .select({ id: workspaces.id })
      .from(workspaces)
      .where(and(eq(workspaces.id, workspaceId), eq(workspaces.ownerUserId, userId)))
      .limit(1);
    return Boolean(row);
  }

  /**
   * The first workspace for a new account. Named after the person rather than
   * left blank, so the switcher has something meaningful in it on first load.
   */
  async ensureDefault(userId: string, name = "Personal"): Promise<WorkspaceSummary> {
    const existing = await this.list(userId);
    if (existing.length > 0) return existing[0]!;

    const created = await this.create(userId, name);
    if ("conflict" in created) {
      // Another boot won the race; whichever landed first is fine.
      return (await this.list(userId))[0]!;
    }
    return created;
  }

  /**
   * Slugs are unique per owner, so a second "Acme" becomes "acme-2". Gives up
   * after a bounded number of attempts rather than looping forever.
   */
  async #uniqueSlug(userId: string, name: string): Promise<string | null> {
    const base = slugify(name);
    const taken = new Set((await this.list(userId)).map((w) => w.slug));

    if (!taken.has(base)) return base;
    for (let i = 2; i <= 50; i++) {
      const candidate = `${base}-${i}`;
      if (!taken.has(candidate)) return candidate;
    }
    return null;
  }
}

export function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
  // A name of only punctuation or non-Latin script would slugify to nothing.
  return slug || "workspace";
}
