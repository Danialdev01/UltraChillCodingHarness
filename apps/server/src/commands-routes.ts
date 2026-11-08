import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { PROJECT_COMMANDS_MAX, ProjectCommand, type ProjectCommandsResponse } from "@ucch/protocol";

import type { ProjectSummary } from "./workspaces.js";
import { readCommands, writeCommands } from "./project-commands.js";

type ProjectRequest = {
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  params: { hash: string };
};

export interface CommandRouteDeps {
  projectFor(request: ProjectRequest): Promise<ProjectSummary | null>;
  /** The project's main checkout, where `.agent/commands.json` lives. */
  rootOf(projectId: string): string;
  /** After a save: every open page refetches the buttons. */
  changed(projectId: string): void;
}

const Body = z.object({ commands: z.array(ProjectCommand).max(PROJECT_COMMANDS_MAX) });

/**
 * A project's command buttons, under `/api/projects/:hash/commands`.
 * Writes are for members who may change the project: the shared preHandler
 * in index.ts answers 403 to a viewer before this runs.
 */
export function registerCommandRoutes(app: FastifyInstance, deps: CommandRouteDeps): void {
  app.get<{ Params: { hash: string } }>("/api/projects/:hash/commands", async (request, reply) => {
    const project = await deps.projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const read = readCommands(deps.rootOf(project.id));
    return { commands: read.commands, error: read.error } satisfies ProjectCommandsResponse;
  });

  app.put<{ Params: { hash: string } }>("/api/projects/:hash/commands", async (request, reply) => {
    const project = await deps.projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const parsed = Body.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({ error: `${issue?.path.join(".") || "body"}: ${issue?.message ?? "invalid"}` });
    }
    const ids = parsed.data.commands.map((c) => c.id);
    if (new Set(ids).size !== ids.length) return reply.code(400).send({ error: "command ids must be unique" });
    try {
      await writeCommands(deps.rootOf(project.id), parsed.data.commands);
    } catch (error) {
      request.log.warn({ err: error }, "could not write .agent/commands.json");
      return reply.code(409).send({ error: "could not write .agent/commands.json" });
    }
    deps.changed(project.id);
    return { commands: parsed.data.commands, error: null } satisfies ProjectCommandsResponse;
  });
}
