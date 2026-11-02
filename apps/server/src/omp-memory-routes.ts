import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { clearMemory, memoryStats } from "./omp-memory.js";

type Principal = { userId: string };

/**
 * The memory card (solution §7.3, OM7.3): one project's mnemopi bank,
 * under the subject that pays for it -- the caller's own, or with
 * `?workspace=<id>` that workspace's dedicated subscription, as the
 * provider routes have it. Any member may look; clearing a workspace's
 * bank takes `credentials.manage`. Only counts are shown, never the
 * memories themselves.
 */
export interface OmpMemoryRouteDeps {
  principalFor(cookies: Record<string, string | undefined>): Promise<Principal | null>;
  /** `providerSubject` in `index.ts`: null when the caller may not act for that workspace. */
  subjectFor(userId: string, workspaceId: string | undefined, permission: "workspace.view" | "credentials.manage"): Promise<string | null>;
  /** The project's workspace, if the caller can see the project at all. */
  visibleProject(projectId: string, userId: string): Promise<{ workspaceId: string } | null>;
  /** `ProviderService.ompMemoryDb`. */
  memoryDb(subject: string, projectId: string): string;
}

const Params = z.object({ projectId: z.string().uuid() });

export function registerOmpMemoryRoutes(app: FastifyInstance, deps: OmpMemoryRouteDeps): void {
  async function bank(
    request: { cookies: Record<string, string | undefined>; params: unknown; query: { workspace?: string } },
    permission: "workspace.view" | "credentials.manage",
  ): Promise<{ path: string } | { status: 401 | 403 | 404; error: string }> {
    const principal = await deps.principalFor(request.cookies);
    if (!principal) return { status: 401, error: "unauthorized" };
    const params = Params.safeParse(request.params);
    if (!params.success) return { status: 404, error: "project not found" };
    const project = await deps.visibleProject(params.data.projectId, principal.userId);
    if (!project) return { status: 404, error: "project not found" };
    const workspaceId = request.query.workspace;
    // A workspace's bank only holds its own projects.
    if (workspaceId && workspaceId !== project.workspaceId) return { status: 404, error: "project not found" };
    const subject = await deps.subjectFor(principal.userId, workspaceId, permission);
    if (!subject) {
      return permission === "credentials.manage"
        ? { status: 403, error: "only a workspace admin can clear its memory" }
        : { status: 404, error: "workspace not found" };
    }
    return { path: deps.memoryDb(subject, params.data.projectId) };
  }

  app.get<{ Params: { projectId: string }; Querystring: { workspace?: string } }>(
    "/api/omp-memory/:projectId",
    async (request, reply) => {
      const found = await bank(request, "workspace.view");
      if ("error" in found) return reply.code(found.status).send({ error: found.error });
      try {
        return await memoryStats(found.path);
      } catch (error) {
        request.log.error({ err: error }, "could not read an OMP memory bank");
        return reply.code(500).send({ error: "the memory file could not be read" });
      }
    },
  );

  app.delete<{ Params: { projectId: string }; Querystring: { workspace?: string } }>(
    "/api/omp-memory/:projectId",
    async (request, reply) => {
      const found = await bank(request, "credentials.manage");
      if ("error" in found) return reply.code(found.status).send({ error: found.error });
      await clearMemory(found.path);
      return reply.code(204).send();
    },
  );
}
