import type { FastifyInstance } from "fastify";
import { z } from "zod";
import {
  ProviderId,
  TASK_DESCRIPTION_MAX,
  TASK_FEEDBACK_MAX,
  TASK_REFERENCES_MAX,
  TASK_STAGES,
  TASK_TITLE_MAX,
  type ChangeOrigin,
  type DomainEvent,
  type ProjectTask,
} from "@ucch/protocol";
import type { AuditInput } from "./audit.js";
import type { TaskPipeline } from "./task-pipeline.js";
import type { TasksService } from "./tasks.js";
import type { UploadStore } from "./uploads.js";
import type { ProjectSummary } from "./workspaces.js";

export type TaskChangedEvent = Extract<DomainEvent, { type: "task.changed" }>;

type ProjectRequest = {
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  params: { hash: string };
};

export interface TaskRouteDeps {
  projectFor(request: ProjectRequest): Promise<ProjectSummary | null>;
  tasks: TasksService;
  pipeline: Pick<TaskPipeline, "enqueue" | "cancel" | "holds">;
  uploads: Pick<UploadStore, "retain">;
  announce(event: TaskChangedEvent): Promise<void>;
  originOf(request: ProjectRequest): Promise<ChangeOrigin | undefined>;
  audit(input: AuditInput): Promise<unknown>;
}

const TaskId = z.string().uuid();
const Title = z.string().trim().min(1).max(TASK_TITLE_MAX);
const Description = z.string().max(TASK_DESCRIPTION_MAX);
const Reference = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("url"), url: z.string().url().max(2000) }),
  z.object({ kind: z.literal("file"), path: z.string().min(1).max(1000) }),
  z.object({ kind: z.literal("upload"), uploadId: z.string().min(1).max(100), name: z.string().min(1).max(300) }),
]);
const References = z.array(Reference).max(TASK_REFERENCES_MAX);

const TaskCreate = z.object({ title: Title, description: Description.optional(), references: References.optional() });

const TaskPatch = z
  .object({
    title: Title.optional(),
    description: Description.optional(),
    references: References.optional(),
    ifUpdatedAt: z.string().datetime().optional(),
    /**
     * What the fields being changed held when the edit began. A field
     * somebody else has changed since is a conflict; any other is not.
     */
    base: z
      .object({
        title: z.string().max(TASK_TITLE_MAX).optional(),
        description: Description.optional(),
        references: References.optional(),
      })
      .optional(),
  })
  .refine(({ ifUpdatedAt: _, base: __, ...p }) => Object.values(p).some((v) => v !== undefined), {
    message: "nothing to change",
  });

/**
 * The columns a person may put a card in. Ongoing and Verification are the
 * pipeline's: a card gets there by being worked on, not by being dragged.
 */
const ManualStage = z.enum(["idea", "research", "done"]);
const AnyStage = z.enum(TASK_STAGES);
const TaskMove = z.object({ stage: AnyStage, position: z.number().finite().optional() });

const Feedback = z.object({ answer: z.string().trim().min(1).max(TASK_FEEDBACK_MAX) });

const Time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);
const Settings = z.object({
  provider: ProviderId.nullable(),
  model: z.string().trim().min(1).max(200).nullable(),
  autoRun: z.object({
    enabled: z.boolean(),
    days: z.array(z.number().int().min(0).max(6)).max(7),
    time: Time,
    timezone: z.string().min(1).max(100).refine(isTimeZone, "unknown time zone"),
  }),
});

/** The Tasks board, under `/api/projects/:hash/tasks`, and its settings. */
export function registerTaskRoutes(app: FastifyInstance, deps: TaskRouteDeps): void {
  const { projectFor, tasks, pipeline, uploads, announce, originOf, audit } = deps;

  const by = (projectId: string, origin: ChangeOrigin | undefined) => ({
    projectId,
    userId: origin?.userId ?? null,
    clientId: origin?.clientId ?? null,
    targetType: "task",
  });

  type Hash = { hash: string };
  type HashAndTask = { hash: string; taskId: string };

  const notFound = { error: "project not found" };
  const noTask = { error: "task not found" };

  /** Tells the other tabs; a saved card goes along whole, so they put it in place without a refetch. */
  const changed = async (
    projectId: string,
    task: Pick<ProjectTask, "id" | "updatedAt"> | ProjectTask,
    change: TaskChangedEvent["change"],
    origin: ChangeOrigin | undefined,
  ) =>
    announce({
      type: "task.changed",
      projectId,
      taskId: task.id,
      change,
      updatedAt: task.updatedAt,
      ...(origin ? { origin } : {}),
      ...(change !== "deleted" && "stage" in task ? { task } : {}),
    });

  /** Attached files outlive the upload sweep for as long as the card names them. */
  const retain = async (projectId: string, references: ProjectTask["references"] | undefined) => {
    for (const ref of references ?? []) {
      if (ref.kind === "upload") await uploads.retain(projectId, ref.uploadId).catch(() => {});
    }
  };

  app.get<{ Params: Hash }>("/api/projects/:hash/tasks", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    return { tasks: await tasks.list(project.id) };
  });

  app.post<{ Params: Hash }>("/api/projects/:hash/tasks", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const parsed = TaskCreate.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describe(parsed.error) });

    await retain(project.id, parsed.data.references);
    const task = await tasks.create(project.id, parsed.data);
    const origin = await originOf(request);
    await changed(project.id, task, "created", origin);
    void audit({
      ...by(project.id, origin),
      action: "task.create",
      targetId: task.id,
      summary: `Added todo “${task.title}”`,
    });
    return reply.code(201).send({ task });
  });

  app.patch<{ Params: HashAndTask }>("/api/projects/:hash/tasks/:taskId", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!TaskId.safeParse(request.params.taskId).success) return reply.code(404).send(noTask);
    const parsed = TaskPatch.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describe(parsed.error) });

    const { ifUpdatedAt, base, ...patch } = parsed.data;
    await retain(project.id, patch.references);
    const outcome = await tasks.update(project.id, request.params.taskId, patch, { ifUpdatedAt, base });
    if (outcome === null) return reply.code(404).send(noTask);
    if ("conflict" in outcome) {
      return reply.code(409).send({ error: "this task was changed elsewhere", task: outcome.conflict });
    }
    const origin = await originOf(request);
    await changed(project.id, outcome.task, "updated", origin);
    void audit({
      ...by(project.id, origin),
      action: "task.update",
      targetId: outcome.task.id,
      summary: `Changed todo “${outcome.task.title}”`,
      details: { fields: Object.keys(patch) },
      coalesce: true,
    });
    return { task: outcome.task };
  });

  app.post<{ Params: HashAndTask }>("/api/projects/:hash/tasks/:taskId/move", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!TaskId.safeParse(request.params.taskId).success) return reply.code(404).send(noTask);
    const parsed = TaskMove.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describe(parsed.error) });

    const current = await tasks.get(project.id, request.params.taskId);
    if (!current) return reply.code(404).send(noTask);
    const { stage, position } = parsed.data;

    let task: ProjectTask | null;
    if (stage === current.stage) {
      // Reordering within a column: the card's place, nothing else.
      task = position === undefined ? current : await tasks.reorder(project.id, current.id, position);
    } else {
      if (!ManualStage.safeParse(stage).success) {
        return reply.code(400).send({ error: "only the AI moves a task into Ongoing or Verification" });
      }
      // Whatever the pipeline was doing with it is over.
      pipeline.cancel(current.id);
      task = await tasks.move(project.id, current.id, stage, position);
      if (task && stage === "research") pipeline.enqueue(project.id, task.id);
    }
    if (!task) return reply.code(404).send(noTask);

    const origin = await originOf(request);
    await changed(project.id, task, "updated", origin);
    if (stage !== current.stage) {
      void audit({
        ...by(project.id, origin),
        action: "task.move",
        targetId: task.id,
        summary: `Moved todo “${task.title}” to ${stage}`,
        details: { from: current.stage, to: stage },
      });
    }
    return { task };
  });

  app.post<{ Params: HashAndTask }>(
    "/api/projects/:hash/tasks/:taskId/feedback",
    async (request, reply) => {
      const project = await projectFor(request);
      if (!project) return reply.code(404).send(notFound);
      if (!TaskId.safeParse(request.params.taskId).success) return reply.code(404).send(noTask);
      const parsed = Feedback.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: describe(parsed.error) });

      const current = await tasks.get(project.id, request.params.taskId);
      if (!current) return reply.code(404).send(noTask);
      if (current.status !== "needs_input") {
        return reply.code(409).send({ error: "this task is not waiting for an answer", task: current });
      }
      const round = {
        reason: current.verification?.reason ?? "",
        answer: parsed.data.answer,
        at: new Date().toISOString(),
      };
      // Back to Research with both sides of the failed round on the card:
      // the next brief is written knowing what went wrong.
      await tasks.move(project.id, current.id, "research");
      const task = await tasks.progress(project.id, current.id, {
        feedback: [...current.feedback, round],
      });
      if (!task) return reply.code(404).send(noTask);
      pipeline.enqueue(project.id, task.id);

      const origin = await originOf(request);
      await changed(project.id, task, "updated", origin);
      void audit({
        ...by(project.id, origin),
        action: "task.feedback",
        targetId: task.id,
        summary: `Sent todo “${task.title}” back to research`,
      });
      return { task };
    },
  );

  app.post<{ Params: HashAndTask }>("/api/projects/:hash/tasks/:taskId/retry", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!TaskId.safeParse(request.params.taskId).success) return reply.code(404).send(noTask);
    const current = await tasks.get(project.id, request.params.taskId);
    if (!current) return reply.code(404).send(noTask);
    if (current.stage === "idea" || current.stage === "done") {
      return reply.code(409).send({ error: "there is nothing to run for this task", task: current });
    }
    if (pipeline.holds(current.id)) return { task: current };

    const task = await tasks.progress(project.id, current.id, { status: "idle", lastError: null });
    if (!task) return reply.code(404).send(noTask);
    pipeline.enqueue(project.id, task.id);
    await changed(project.id, task, "updated", await originOf(request));
    return { task };
  });

  app.delete<{ Params: HashAndTask }>("/api/projects/:hash/tasks/:taskId", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    if (!TaskId.safeParse(request.params.taskId).success) return reply.code(404).send(noTask);
    pipeline.cancel(request.params.taskId);
    const removed = await tasks.remove(project.id, request.params.taskId);
    if (!removed) return reply.code(404).send(noTask);
    const origin = await originOf(request);
    await changed(
      project.id,
      { id: request.params.taskId, updatedAt: new Date().toISOString() },
      "deleted",
      origin,
    );
    void audit({
      ...by(project.id, origin),
      action: "task.delete",
      targetId: request.params.taskId,
      summary: `Deleted todo “${removed.title}”`,
    });
    return reply.code(204).send();
  });

  // -- Settings --------------------------------------------------------------

  app.get<{ Params: Hash }>("/api/projects/:hash/task-settings", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const settings = await tasks.settings(project.id);
    if (!settings) return reply.code(404).send(notFound);
    return { settings };
  });

  app.put<{ Params: Hash }>("/api/projects/:hash/task-settings", async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send(notFound);
    const parsed = Settings.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: describe(parsed.error) });
    const { provider, model, autoRun } = parsed.data;
    const settings = await tasks.saveSettings(project.id, {
      provider,
      model,
      autoRun: { ...autoRun, days: [...new Set(autoRun.days)].sort() },
    });
    if (!settings) return reply.code(404).send(notFound);
    return { settings };
  });
}

function isTimeZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

/** The first thing wrong with the body, in the words of the field it is about. */
function describe(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return "invalid request";
  const field = issue.path.join(".");
  return field ? `${field}: ${issue.message}` : issue.message;
}
