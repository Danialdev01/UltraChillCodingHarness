import type { FastifyInstance } from "fastify";
import { z } from "zod";

import { RUNTIME_IDS, RuntimeSelection, type ProjectRuntimesResponse, type RuntimeId } from "@ucch/protocol";

import type { ProjectSummary } from "./workspaces.js";
import { RuntimeInUseError, writeSelections, type RuntimeManager } from "./runtimes/manager.js";
import { parseVersion, pickVersion } from "./runtimes/version.js";

type ProjectRequest = {
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
  params: { hash: string };
};

export interface RuntimeRouteDeps {
  projectFor(request: ProjectRequest): Promise<ProjectSummary | null>;
  /** The project's main checkout, where `.agent/runtimes.json` lives. */
  rootOf(projectId: string): string;
  runtimes: RuntimeManager;
  /** After a save: every open page refetches. */
  changed(projectId: string): void;
}

const RuntimeIdParam = z.enum(RUNTIME_IDS);
const SaveBody = z.object({ runtimes: z.object({ php: RuntimeSelection.optional() }) });
const InstallBody = z.object({ version: z.string().trim().optional() }).default({});

/**
 * A project's runtime versions, under `/api/projects/:hash/runtimes`.
 *
 * Reads are for every member. Writes -- the selection, an install, an
 * uninstall -- are for members who may change the project: the shared
 * preHandler in index.ts answers 403 to a viewer before any of these run.
 * Installs are shared by the whole server, so one project's install is
 * every project's to use; an uninstall is refused while any project's
 * link points at that version.
 */
export function registerRuntimeRoutes(app: FastifyInstance, deps: RuntimeRouteDeps): void {
  const status = (projectId: string): Promise<ProjectRuntimesResponse> =>
    deps.runtimes.status(projectId, deps.rootOf(projectId));

  app.get<{ Params: { hash: string } }>("/api/projects/:hash/runtimes", async (request, reply) => {
    const project = await deps.projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    return status(project.id);
  });

  app.put<{ Params: { hash: string } }>("/api/projects/:hash/runtimes", async (request, reply) => {
    const project = await deps.projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const parsed = SaveBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: issue(parsed.error) });
    const root = deps.rootOf(project.id);
    try {
      await writeSelections(root, parsed.data.runtimes);
    } catch (error) {
      request.log.warn({ err: error }, "could not write .agent/runtimes.json");
      return reply.code(409).send({ error: "could not write .agent/runtimes.json" });
    }
    // Links the new choice at once when it is installed; starts the
    // download when it is not (and auto-install is on).
    deps.runtimes.reconcile(project.id, root);
    // Explicitly asked for, so installed even with auto-install off.
    for (const [id, selection] of Object.entries(parsed.data.runtimes) as [RuntimeId, string][]) {
      void startWanted(deps.runtimes, id, selection, project.id, request.log);
    }
    deps.changed(project.id);
    return status(project.id);
  });

  /** Installs a version: the one named, or -- with none -- what the selection's "Update" would take. */
  app.post<{ Params: { hash: string; runtime: string } }>(
    "/api/projects/:hash/runtimes/:runtime/install",
    async (request, reply) => {
      const project = await deps.projectFor(request);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const id = RuntimeIdParam.safeParse(request.params.runtime);
      if (!id.success) return reply.code(404).send({ error: "unknown runtime" });
      const body = InstallBody.safeParse(request.body ?? {});
      if (!body.success) return reply.code(400).send({ error: issue(body.error) });

      let version = body.data.version;
      if (version !== undefined && !parseVersion(version)) return reply.code(400).send({ error: "version: x.y.z" });
      if (version === undefined) {
        const current = (await status(project.id)).runtimes.find((r) => r.id === id.data);
        version = current?.update ?? current?.missing ?? undefined;
        if (!version) return reply.code(409).send({ error: "nothing newer to install" });
      }
      try {
        const release = (await deps.runtimes.available(id.data)).find((r) => r.version === version);
        if (!release) return reply.code(404).send({ error: `${version} is not offered for download` });
      } catch (error) {
        return reply.code(502).send({ error: error instanceof Error ? error.message : "the download list is unavailable" });
      }
      // In the background; the page follows its progress.
      deps.runtimes.install(id.data, version, project.id).catch(() => undefined);
      return reply.code(202).send(await status(project.id));
    },
  );

  app.delete<{ Params: { hash: string; runtime: string; version: string } }>(
    "/api/projects/:hash/runtimes/:runtime/:version",
    async (request, reply) => {
      const project = await deps.projectFor(request);
      if (!project) return reply.code(404).send({ error: "project not found" });
      const id = RuntimeIdParam.safeParse(request.params.runtime);
      if (!id.success) return reply.code(404).send({ error: "unknown runtime" });
      try {
        await deps.runtimes.uninstall(id.data, request.params.version);
      } catch (error) {
        if (error instanceof RuntimeInUseError) return reply.code(409).send({ error: error.message });
        return reply.code(400).send({ error: error instanceof Error ? error.message : "could not uninstall" });
      }
      deps.changed(project.id);
      return status(project.id);
    },
  );
}

async function startWanted(
  runtimes: RuntimeManager,
  id: RuntimeId,
  selection: string,
  projectId: string,
  log: { warn(obj: unknown, msg: string): void },
): Promise<void> {
  try {
    const want = await runtimes.wanted(id, selection);
    // Already satisfied by something installed: nothing to fetch. An
    // update is its own button, never a side effect of saving.
    if (!want || pickVersion(selection, runtimes.installed(id))) return;
    await runtimes.install(id, want, projectId);
  } catch (error) {
    log.warn({ err: error }, `could not install ${id} ${selection}`);
  }
}

function issue(error: z.ZodError): string {
  const first = error.issues[0];
  return `${first?.path.join(".") || "body"}: ${first?.message ?? "invalid"}`;
}
