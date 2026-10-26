import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ISO_DATE,
  TIMELINE_COLOURS,
  TIMELINE_TITLE_MAX,
  type ChangeOrigin,
  type DomainEvent,
} from "@ucch/protocol";
import type { AuditInput } from "./audit.js";
import type { TimelineService } from "./timeline.js";
import type { ProjectSummary } from "./workspaces.js";

export type TimelineChangedEvent = Extract<DomainEvent, { type: "timeline.changed" }>;

type ProjectRequest = {
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  params: { hash: string };
};

export interface TimelineRouteDeps {
  /** The caller's project for `:hash`, or null -- the same gate every project route uses. */
  projectFor(request: ProjectRequest): Promise<ProjectSummary | null>;
  timeline: TimelineService;
  /** Tells the project's other open tabs something changed. Never throws. */
  announce(event: TimelineChangedEvent): Promise<void>;
  /** Who is asking, and from which tab. */
  originOf(request: ProjectRequest): Promise<ChangeOrigin | undefined>;
  /** Writes a line to the project's activity log. Never throws. */
  audit(input: AuditInput): Promise<unknown>;
}

const TaskId = z.string().uuid();

const Title = z.string().trim().min(1).max(TIMELINE_TITLE_MAX);
const Day = z.string().regex(ISO_DATE);
const Progress = z.number().int().min(0).max(100);
const Colour = z.enum(TIMELINE_COLOURS);

const TaskCreate = z.object({
  title: Title,
  startsOn: Day,
  endsOn: Day,
  progress: Progress.optional(),
  colour: Colour.optional(),
  dependsOnId: TaskId.nullable().optional(),
});

const TaskPatch = z
  .object({
    title: Title.optional(),
    startsOn: Day.optional(),
    endsOn: Day.optional(),
    progress: Progress.optional(),
    colour: Colour.optional(),
    dependsOnId: TaskId.nullable().optional(),
    /** The version this tab last saw; a task saved since is a conflict. */
    ifUpdatedAt: z.string().datetime().optional(),
    /**
     * What the fields being changed held when the edit (or the drag) began.
     * A field somebody else has changed since is a conflict; any other is not.
     */
    base: z
      .object({
        title: z.string().max(TIMELINE_TITLE_MAX).optional(),
        startsOn: Day.optional(),
        endsOn: Day.optional(),
        progress: Progress.optional(),
        colour: Colour.optional(),
        dependsOnId: TaskId.nullable().optional(),
      })
      .optional(),
  })
  .refine(
    ({ ifUpdatedAt: _, base: __, ...p }) => Object.values(p).some((v) => v !== undefined),
    { message: "nothing to change" },
  );

/**
 * A project's timeline tasks, under `/api/projects/:hash/timeline/tasks`.
 *
 * Its own module for the same reason the notes have one: a small complete
 * API rather than a single route, kept out of `index.ts`.
 */
export function registerTimelineRoutes(app: FastifyInstance, deps: TimelineRouteDeps): void {
  const { projectFor, timeline, announce, originOf, audit } = deps;

  const by = (projectId: string, origin: ChangeOrigin | undefined) => ({
    projectId,
    userId: origin?.userId ?? null,
    clientId: origin?.clientId ?? null,
    targetType: "timeline_task",
  });

  type Hash = { hash: string };
  type HashAndTask = { hash: string; taskId: string };

  const notFound = { error: "project not found" };
  const noTask = { error: "task not found" };

  app.get<{ Params: Hash }>("/api/projects/:hash/timeline/tasks", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    return { tasks: await timeline.list(project.id) };
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/timeline/tasks", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const parsed = TaskCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describe(parsed.error) });

    const outcome = await timeline.create(project.id, parsed.data);
    if (outcome === null) return reply.code(404).send(noTask);
    if ("error" in outcome) return reply.code(400).send({ error: outcome.error });
    if ("conflict" in outcome) return reply.code(409).send({ error: "changed elsewhere", task: outcome.conflict });
    const origin = await originOf(request);
    await announce({
      type: "timeline.changed",
      projectId: project.id,
      taskId: outcome.task.id,
      change: "created",
      updatedAt: outcome.task.updatedAt,
      ...(origin ? { origin } : {}),
    });
    void audit({
      ...by(project.id, origin),
      action: "timeline.create",
      targetId: outcome.task.id,
      summary: `Added task “${outcome.task.title}”`,
      details: { startsOn: outcome.task.startsOn, endsOn: outcome.task.endsOn },
    });
    return reply.code(201).send({ task: outcome.task });
  });

  app.patch<{ Params: HashAndTask }>(
    "/api/projects/:hash/timeline/tasks/:taskId",
    async (request, reply) => {
      const project = await projectFor(request);
      if (!project) return reply.code(404).send(notFound);
      if (!TaskId.safeParse(request.params.taskId).success) return reply.code(404).send(noTask);
      const parsed = TaskPatch.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: describe(parsed.error) });

      const { ifUpdatedAt, base, ...patch } = parsed.data;
      const outcome = await timeline.update(project.id, request.params.taskId, patch, { ifUpdatedAt, base });
      if (outcome === null) return reply.code(404).send(noTask);
      if ("error" in outcome) return reply.code(400).send({ error: outcome.error });
      const origin = await originOf(request);
      if ("conflict" in outcome) {
        void audit({
          ...by(project.id, origin),
          action: "timeline.conflict",
          targetId: outcome.conflict.id,
          summary: `Change to “${outcome.conflict.title}” refused: changed elsewhere, reverted`,
          details: { fields: Object.keys(patch) },
        });
        return reply.code(409).send({ error: "this task was changed elsewhere", task: outcome.conflict });
      }
      await announce({
        type: "timeline.changed",
        projectId: project.id,
        taskId: outcome.task.id,
        change: "updated",
        updatedAt: outcome.task.updatedAt,
        ...(origin ? { origin } : {}),
        // Whole, so the other tabs put this row in place without a refetch.
        task: outcome.task,
      });
      void audit({
        ...by(project.id, origin),
        action: "timeline.update",
        targetId: outcome.task.id,
        summary: `Changed task “${outcome.task.title}”`,
        details: { fields: Object.keys(patch), ...patch },
        coalesce: true,
      });
      return { task: outcome.task };
    },
  );

  app.delete<{ Params: HashAndTask; Querystring: { ifUpdatedAt?: string } }>(
    "/api/projects/:hash/timeline/tasks/:taskId",
    async (request, reply) => {
      const project = await projectFor(request);
      if (!project) return reply.code(404).send(notFound);
      if (!TaskId.safeParse(request.params.taskId).success) return reply.code(404).send(noTask);
      const ifUpdatedAt = z.string().datetime().safeParse(request.query.ifUpdatedAt);
      const removed = await timeline.remove(
        project.id,
        request.params.taskId,
        ifUpdatedAt.success ? ifUpdatedAt.data : undefined,
      );
      if (!removed) return reply.code(404).send(noTask);
      if ("conflict" in removed) {
        return reply.code(409).send({ error: "this task was changed elsewhere", task: removed.conflict });
      }
      const origin = await originOf(request);
      await announce({
        type: "timeline.changed",
        projectId: project.id,
        taskId: request.params.taskId,
        change: "deleted",
        updatedAt: new Date().toISOString(),
        ...(origin ? { origin } : {}),
      });
      void audit({
        ...by(project.id, origin),
        action: "timeline.delete",
        targetId: request.params.taskId,
        summary: `Deleted task “${removed.title}”`,
      });
      return reply.code(204).send();
    },
  );
}

/** The first thing wrong with the body, in the words of the field it is about. */
function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid request";
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}
