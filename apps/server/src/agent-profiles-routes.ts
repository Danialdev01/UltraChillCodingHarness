import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import {
  ProfileError,
  isDefaultRow,
  toRef,
  toView,
  type AgentProfiles,
  type ProfileProvider,
  type ProfileView,
} from "./agent-profiles.js";
import type { AgentProfile } from "@ucch/db";
import type { ProviderCard, ProfileRef } from "./providers.js";
import type { SessionQuota } from "./quotas.js";

/**
 * Settings → Harness: a subject's Claude Code and Codex accounts.
 *
 *   GET    /api/agent-profiles                    every account, with its status
 *   POST   /api/agent-profiles                    a new, signed-out account
 *   PATCH  /api/agent-profiles/:id                rename, or change its context
 *   DELETE /api/agent-profiles/:id                the account and its folder
 *   DELETE /api/agent-profiles/:id/credentials    sign out, keep the account
 *
 *   GET    /api/projects/:hash/accounts                  the caller's defaults, the required context
 *   PUT    /api/projects/:hash/accounts/default/:provider  the caller's default account there
 *   PUT    /api/projects/:hash/accounts/required-context   work | personal | null; admins only
 *
 * `?workspace=<id>` acts on that workspace's subscription accounts: any
 * member may list them, only an admin may change them. Signing in is a
 * terminal (`terminal.create` with `profileId`), never a route: the login
 * is the CLI's own flow.
 */

export interface AgentProfileRouteDeps {
  principal(request: FastifyRequest): Promise<{ userId: string } | null>;
  /** The subject a request acts on, or null when the caller may not. */
  subjectFor(userId: string, workspaceId: string | undefined, permission: "workspace.view" | "credentials.manage"): Promise<string | null>;
  profiles: AgentProfiles;
  /** The CLI's own status check, in the account's folder. */
  health(subject: string, provider: ProfileProvider, profile: ProfileRef, fresh: boolean): Promise<ProviderCard>;
  quota(subject: string, provider: ProfileProvider, profile: ProfileRef): Promise<SessionQuota>;
  signOut(subject: string, provider: ProfileProvider, profile: ProfileRef): Promise<void>;
  /** A project the caller can see, by hash. */
  project(hash: string, userId: string): Promise<{ id: string; workspaceId: string; requiredContext: string | null } | null>;
  allows(workspaceId: string, userId: string, permission: "workspace.manage"): Promise<boolean>;
  setRequiredContext(projectId: string, context: "work" | "personal" | null): Promise<void>;
}

export interface ProfileCardView extends ProfileView {
  installed: boolean;
  authenticated: boolean;
  /** `subscription`, or `api-key` when the CLI would bill an API key it found. */
  authMode: ProviderCard["authMode"];
  /** Display only: a masked email, never a token. */
  account?: string;
  error?: string;
  warnings?: string[];
  quota: SessionQuota | null;
}

const Query = z.object({ workspace: z.string().optional(), fresh: z.string().optional() });
const CreateBody = z.object({
  provider: z.enum(["claude", "codex"]),
  label: z.string().max(200),
  context: z.enum(["personal", "work"]).optional(),
});
const PatchBody = z
  .object({ label: z.string().max(200).optional(), context: z.enum(["personal", "work"]).optional() })
  .refine((b) => b.label !== undefined || b.context !== undefined, "Nothing to change");

const DefaultBody = z.object({ profileId: z.string().uuid().nullable() });
const ContextBody = z.object({ context: z.enum(["work", "personal"]).nullable() });

const STATUS: Record<ProfileError["code"], number> = { not_found: 404, invalid: 400, conflict: 409, forbidden: 403 };

export function registerAgentProfileRoutes(app: FastifyInstance, deps: AgentProfileRouteDeps): void {
  async function card(subject: string, row: AgentProfile, fresh: boolean): Promise<ProfileCardView> {
    const provider = row.provider as ProfileProvider;
    const ref = toRef(row);
    const health = await deps.health(subject, provider, ref, fresh).catch((error: unknown) => ({
      installed: false,
      authenticated: false,
      error: error instanceof Error ? error.message : String(error),
    }) as Partial<ProviderCard>);
    const authenticated = Boolean(health.authenticated);
    const status = authenticated ? "signed_in" : health.installed ? "signed_out" : row.authStatus;
    if (status !== row.authStatus) await deps.profiles.setAuthStatus(row.id, status as "signed_in" | "signed_out" | "unknown");
    const quota = authenticated ? await deps.quota(subject, provider, ref).catch(() => null) : null;
    return {
      ...toView({ ...row, authStatus: status }),
      installed: Boolean(health.installed),
      authenticated,
      authMode: health.authMode ?? "none",
      ...(health.account ? { account: health.account } : {}),
      ...(health.error ? { error: health.error } : {}),
      ...(health.warnings?.length ? { warnings: health.warnings } : {}),
      quota,
    };
  }

  /** The caller's subject and the profile, when it is that subject's. */
  async function target(
    request: FastifyRequest<{ Params: { id: string }; Querystring: { workspace?: string } }>,
    permission: "workspace.view" | "credentials.manage",
  ): Promise<{ status: number; error: string } | { subject: string; row: AgentProfile }> {
    const principal = await deps.principal(request);
    if (!principal) return { status: 401, error: "unauthorized" }
    const subject = await deps.subjectFor(principal.userId, request.query.workspace, permission);
    if (!subject) return { status: 403, error: "only a workspace admin can change its subscription accounts" }
    if (!z.string().uuid().safeParse(request.params.id).success) return { status: 404, error: "account not found" }
    const row = await deps.profiles.owned(request.params.id, subject);
    if (!row) return { status: 404, error: "account not found" }
    return { subject, row }
  }

  app.get<{ Querystring: { workspace?: string; fresh?: string } }>("/api/agent-profiles", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const query = Query.safeParse(request.query);
    if (!query.success) return reply.code(400).send({ error: "bad query" });
    const subject = await deps.subjectFor(principal.userId, query.data.workspace, "workspace.view");
    if (!subject) return reply.code(404).send({ error: "workspace not found" });
    const rows = await deps.profiles.list(subject);
    const fresh = query.data.fresh === "1";
    return { profiles: await Promise.all(rows.map((row) => card(subject, row, fresh))) };
  });

  app.post<{ Querystring: { workspace?: string } }>("/api/agent-profiles", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const body = CreateBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Name the account and pick Claude Code or Codex." });
    const subject = await deps.subjectFor(principal.userId, request.query.workspace, "credentials.manage");
    if (!subject) return reply.code(403).send({ error: "only a workspace admin can add subscription accounts" });
    try {
      const row = await deps.profiles.create(subject, body.data.provider, body.data);
      return reply.code(201).send({ profile: toView(row) });
    } catch (error) {
      if (error instanceof ProfileError) return reply.code(STATUS[error.code]).send({ error: error.message });
      throw error;
    }
  });

  app.patch<{ Params: { id: string }; Querystring: { workspace?: string } }>("/api/agent-profiles/:id", async (request, reply) => {
    const found = await target(request, "credentials.manage");
    if ("error" in found) return reply.code(found.status).send({ error: found.error });
    const body = PatchBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Give a new name or context." });
    try {
      return { profile: toView(await deps.profiles.update(found.row, body.data)) };
    } catch (error) {
      if (error instanceof ProfileError) return reply.code(STATUS[error.code]).send({ error: error.message });
      throw error;
    }
  });

  app.delete<{ Params: { id: string }; Querystring: { workspace?: string } }>("/api/agent-profiles/:id", async (request, reply) => {
    const found = await target(request, "credentials.manage");
    if ("error" in found) return reply.code(found.status).send({ error: found.error });
    if (isDefaultRow(found.row)) return reply.code(403).send({ error: "The Default account cannot be deleted; sign it out instead." });
    await deps.profiles.remove(found.row);
    return reply.code(204).send();
  });

  app.delete<{ Params: { id: string }; Querystring: { workspace?: string } }>(
    "/api/agent-profiles/:id/credentials",
    async (request, reply) => {
      const found = await target(request, "credentials.manage");
      if ("error" in found) return reply.code(found.status).send({ error: found.error });
      await deps.signOut(found.subject, found.row.provider as ProfileProvider, toRef(found.row));
      await deps.profiles.setAuthStatus(found.row.id, "signed_out");
      return reply.code(204).send();
    },
  );

  app.get<{ Params: { hash: string } }>("/api/projects/:hash/accounts", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const project = await deps.project(request.params.hash, principal.userId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const [defaults, canManage] = await Promise.all([
      deps.profiles.projectDefaults(project.id, principal.userId),
      deps.allows(project.workspaceId, principal.userId, "workspace.manage"),
    ]);
    return { requiredContext: project.requiredContext, defaults, canManage };
  });

  app.put<{ Params: { hash: string; provider: string } }>(
    "/api/projects/:hash/accounts/default/:provider",
    async (request, reply) => {
      const principal = await deps.principal(request);
      if (!principal) return reply.code(401).send({ error: "unauthorized" });
      const provider = request.params.provider;
      if (provider !== "claude" && provider !== "codex") return reply.code(404).send({ error: "unknown provider" });
      const body = DefaultBody.safeParse(request.body);
      if (!body.success) return reply.code(400).send({ error: "Pick an account, or none." });
      const project = await deps.project(request.params.hash, principal.userId);
      if (!project) return reply.code(404).send({ error: "project not found" });
      if (body.data.profileId) {
        // The caller's own account, or the workspace's: whichever a session
        // of theirs here may bill. Turns still check it is the right one.
        const row = await deps.profiles.get(body.data.profileId);
        const mine = row && (row.subject === principal.userId || row.subject === `ws-${project.workspaceId}`);
        if (!row || !mine || row.provider !== provider) return reply.code(404).send({ error: "account not found" });
        if (project.requiredContext && row.context !== project.requiredContext) {
          return reply.code(400).send({ error: `This project runs only on ${project.requiredContext} accounts.` });
        }
      }
      await deps.profiles.setProjectDefault(project.id, principal.userId, provider, body.data.profileId);
      return reply.code(204).send();
    },
  );

  app.put<{ Params: { hash: string } }>("/api/projects/:hash/accounts/required-context", async (request, reply) => {
    const principal = await deps.principal(request);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const body = ContextBody.safeParse(request.body);
    if (!body.success) return reply.code(400).send({ error: "Pick work, personal, or none." });
    const project = await deps.project(request.params.hash, principal.userId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (!(await deps.allows(project.workspaceId, principal.userId, "workspace.manage"))) {
      return reply.code(403).send({ error: "only a workspace admin can set which accounts a project runs on" });
    }
    await deps.setRequiredContext(project.id, body.data.context);
    return reply.code(204).send();
  });
}
