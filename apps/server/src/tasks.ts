import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { staleFields } from "./field-guard.js";
import { notes, projects, projectTasks, type Database, type ProjectTaskRow } from "@ucch/db";
import {
  DEFAULT_TASK_AUTO_RUN,
  ProviderId,
  type ProjectTask,
  type TaskAutoRun,
  type TaskFeedback,
  type TaskReference,
  type TaskSettings,
  type TaskStage,
  type TaskStatus,
  type TaskVerification,
} from "@ucch/protocol";

export interface TaskInput {
  title: string;
  description?: string;
  references?: TaskReference[];
}

export type TaskPatch = Partial<TaskInput>;

/** What the pipeline writes as it carries a card along. */
export interface TaskProgress {
  stage?: TaskStage;
  status?: TaskStatus;
  research?: string | null;
  verification?: TaskVerification | null;
  feedback?: TaskFeedback[];
  threadId?: string | null;
  attempts?: number;
  lastError?: string | null;
}

export type TaskWriteOutcome = { task: ProjectTask } | { conflict: ProjectTask } | null;

/** How much of the Documentation pages the agent is handed, at most. */
export const DOCS_DIGEST_MAX = 20_000;

/**
 * A project's Tasks board: the cards, and the board's own settings.
 *
 * Scoped like `TimelineService`: every method takes the project id first and
 * filters by it, so a card id from another project is simply not found.
 */
export class TasksService {
  constructor(private readonly db: Database) {}

  /** Every card, column by column, top to bottom. */
  async list(projectId: string): Promise<ProjectTask[]> {
    const rows = await this.db
      .select()
      .from(projectTasks)
      .where(eq(projectTasks.projectId, projectId))
      .orderBy(asc(projectTasks.position), asc(projectTasks.createdAt));
    return rows.map(toTask);
  }

  async get(projectId: string, taskId: string): Promise<ProjectTask | null> {
    const [row] = await this.db
      .select()
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.id, taskId)))
      .limit(1);
    return row ? toTask(row) : null;
  }

  /** A new card at the bottom of Idea. */
  async create(projectId: string, input: TaskInput): Promise<ProjectTask> {
    const position = await this.#bottomOf(projectId, "idea");
    const [row] = await this.db
      .insert(projectTasks)
      .values({
        projectId,
        title: input.title,
        description: input.description ?? "",
        references: input.references ?? [],
        stage: "idea",
        position,
      })
      .returning();
    return toTask(row!);
  }

  /**
   * The person's edits: what the card says, not where it is. Only the
   * fields in `patch` are written. A conflict when the card changed since
   * `ifUpdatedAt` (a tab from before per-field writes), or when a field
   * being written no longer has its `base` value (`staleFields`); a change
   * to some other field is not one.
   */
  async update(
    projectId: string,
    taskId: string,
    patch: TaskPatch,
    guard: { ifUpdatedAt?: string; base?: TaskPatch } = {},
  ): Promise<TaskWriteOutcome> {
    return this.db.transaction(async (tx) => {
      // Locked, so the check and the write see the same card.
      const [locked] = await tx
        .select()
        .from(projectTasks)
        .where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.id, taskId)))
        .for("update");
      if (!locked) return null;
      const current = toTask(locked);
      const { ifUpdatedAt, base } = guard;
      if (ifUpdatedAt && new Date(current.updatedAt).getTime() !== new Date(ifUpdatedAt).getTime()) {
        return { conflict: current };
      }
      if (staleFields(current, base).length > 0) return { conflict: current };
      const [row] = await tx
        .update(projectTasks)
        .set({
          ...(patch.title !== undefined && { title: patch.title }),
          ...(patch.description !== undefined && { description: patch.description }),
          ...(patch.references !== undefined && { references: patch.references }),
          updatedAt: new Date(),
        })
        .where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.id, taskId)))
        .returning();
      return row ? { task: toTask(row) } : null;
    });
  }

  /**
   * Puts a card in a column. With no `position` it goes to the bottom. A
   * card moved by hand starts that column afresh: whatever the pipeline was
   * doing with it is over, so the status goes back to idle.
   */
  async move(
    projectId: string,
    taskId: string,
    stage: TaskStage,
    position?: number,
  ): Promise<ProjectTask | null> {
    const slot = position ?? (await this.#bottomOf(projectId, stage));
    const [row] = await this.db
      .update(projectTasks)
      .set({ stage, position: slot, status: "idle", lastError: null, updatedAt: new Date() })
      .where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.id, taskId)))
      .returning();
    return row ? toTask(row) : null;
  }

  /** A new place in the same column; nothing else about the card changes. */
  async reorder(projectId: string, taskId: string, position: number): Promise<ProjectTask | null> {
    const [row] = await this.db
      .update(projectTasks)
      .set({ position, updatedAt: new Date() })
      .where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.id, taskId)))
      .returning();
    return row ? toTask(row) : null;
  }

  /** The pipeline's writes. Null when the card is gone. */
  async progress(projectId: string, taskId: string, progress: TaskProgress): Promise<ProjectTask | null> {
    const position =
      progress.stage !== undefined ? await this.#bottomOf(projectId, progress.stage) : undefined;
    const [row] = await this.db
      .update(projectTasks)
      .set({ ...progress, ...(position !== undefined && { position }), updatedAt: new Date() })
      .where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.id, taskId)))
      .returning();
    return row ? toTask(row) : null;
  }

  async remove(projectId: string, taskId: string): Promise<{ title: string } | false> {
    const [deleted] = await this.db
      .delete(projectTasks)
      .where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.id, taskId)))
      .returning({ title: projectTasks.title });
    return deleted ?? false;
  }

  /** Cards that are waiting in Idea, oldest first: what a scheduled run picks up. */
  async ideas(projectId: string): Promise<ProjectTask[]> {
    const rows = await this.db
      .select()
      .from(projectTasks)
      .where(
        and(
          eq(projectTasks.projectId, projectId),
          eq(projectTasks.stage, "idea"),
          eq(projectTasks.status, "idle"),
        ),
      )
      .orderBy(asc(projectTasks.position), asc(projectTasks.createdAt));
    return rows.map(toTask);
  }

  /**
   * Cards the pipeline was carrying when the server stopped. Nothing is
   * carrying them now; they are marked failed so the board offers a retry
   * rather than showing a spinner for ever.
   */
  async recoverInterrupted(): Promise<number> {
    const rows = await this.db
      .update(projectTasks)
      .set({ status: "failed", lastError: "interrupted by a server restart", updatedAt: new Date() })
      .where(eq(projectTasks.status, "running"))
      .returning({ id: projectTasks.id });
    return rows.length;
  }

  /**
   * The Documentation pages as plain text, page by page, for the agent's
   * prompt. Capped: a large wiki is summarised by its first pages rather
   * than crowding out the task.
   */
  async docsDigest(projectId: string): Promise<string> {
    const pages = await this.db
      .select({ title: notes.title, text: notes.searchText })
      .from(notes)
      .where(eq(notes.projectId, projectId))
      .orderBy(asc(notes.parentId), asc(notes.position));
    let digest = "";
    for (const page of pages) {
      const body = page.text.trim();
      if (!body) continue;
      const chunk = `## ${page.title || "Untitled"}\n${body}\n\n`;
      if (digest.length + chunk.length > DOCS_DIGEST_MAX) {
        digest += chunk.slice(0, Math.max(0, DOCS_DIGEST_MAX - digest.length));
        digest += "\n[documentation truncated]";
        break;
      }
      digest += chunk;
    }
    return digest.trim();
  }

  // -- Settings --------------------------------------------------------------

  async settings(projectId: string): Promise<TaskSettings | null> {
    const [row] = await this.db
      .select({
        provider: projects.taskAgentProvider,
        model: projects.taskAgentModel,
        autoRun: projects.taskAutoRun,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    if (!row) return null;
    return toSettings(row);
  }

  async saveSettings(
    projectId: string,
    input: { provider: ProviderId | null; model: string | null; autoRun: TaskAutoRun },
  ): Promise<TaskSettings | null> {
    // The bookkeeping of the last run is the scheduler's, not the form's:
    // carried over so saving the form does not make today's slot run twice.
    const previous = await this.settings(projectId);
    if (!previous) return null;
    const autoRun: TaskAutoRun = {
      ...input.autoRun,
      lastRunAt: previous.autoRun.lastRunAt ?? null,
      lastOutcome: previous.autoRun.lastOutcome ?? null,
    };
    const [row] = await this.db
      .update(projects)
      .set({ taskAgentProvider: input.provider, taskAgentModel: input.model, taskAutoRun: autoRun })
      .where(eq(projects.id, projectId))
      .returning({
        provider: projects.taskAgentProvider,
        model: projects.taskAgentModel,
        autoRun: projects.taskAutoRun,
      });
    return row ? toSettings(row) : null;
  }

  /** The scheduler's note of a slot it handled. */
  async recordAutoRun(projectId: string, at: string, outcome: string): Promise<void> {
    await this.db
      .update(projects)
      .set({
        taskAutoRun: sql`coalesce(${projects.taskAutoRun}, '{}'::jsonb) || ${JSON.stringify({
          lastRunAt: at,
          lastOutcome: outcome,
        })}::jsonb`,
      })
      .where(eq(projects.id, projectId));
  }

  /** Every project with auto-run on, with the account it belongs to. */
  async autoRunProjects(): Promise<
    { projectId: string; userId: string; provider: string | null; autoRun: TaskAutoRun }[]
  > {
    const rows = await this.db
      .select({
        projectId: projects.id,
        userId: projects.userId,
        provider: projects.taskAgentProvider,
        autoRun: projects.taskAutoRun,
      })
      .from(projects)
      .where(sql`(${projects.taskAutoRun} ->> 'enabled')::boolean is true`);
    return rows.flatMap((r) => (r.autoRun ? [{ ...r, autoRun: r.autoRun }] : []));
  }

  /** Cards in any of these stages, for the pipeline to resume. */
  async inStages(projectId: string, stages: TaskStage[]): Promise<ProjectTask[]> {
    const rows = await this.db
      .select()
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, projectId), inArray(projectTasks.stage, stages)));
    return rows.map(toTask);
  }

  async #bottomOf(projectId: string, stage: TaskStage): Promise<number> {
    const [slot] = await this.db
      .select({ next: sql<number>`coalesce(max(${projectTasks.position}), -1) + 1` })
      .from(projectTasks)
      .where(and(eq(projectTasks.projectId, projectId), eq(projectTasks.stage, stage)));
    return Number(slot?.next ?? 0);
  }
}

function toSettings(row: {
  provider: string | null;
  model: string | null;
  autoRun: TaskAutoRun | null;
}): TaskSettings {
  const provider = ProviderId.safeParse(row.provider);
  return {
    provider: provider.success ? provider.data : null,
    model: row.model,
    autoRun: { ...DEFAULT_TASK_AUTO_RUN, ...(row.autoRun ?? {}) },
  };
}

export function toTask(row: ProjectTaskRow): ProjectTask {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    references: row.references,
    stage: row.stage as TaskStage,
    status: row.status as TaskStatus,
    position: row.position,
    research: row.research,
    verification: row.verification ?? null,
    feedback: row.feedback,
    threadId: row.threadId,
    attempts: row.attempts,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
