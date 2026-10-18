import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { AssignableRole, CredentialPolicy } from "@ucch/protocol";
import type { WorkspaceMemberService } from "./workspace-members.js";

type Principal = { userId: string };

export interface WorkspaceMemberRouteDeps {
  /** Who is asking, from the request's cookies, or null. */
  principalFor(cookies: Record<string, string | undefined>): Promise<Principal | null>;
  members: Pick<
    WorkspaceMemberService,
    | "list"
    | "add"
    | "update"
    | "remove"
    | "listInvites"
    | "createInvite"
    | "revokeInvite"
    | "previewInvite"
    | "acceptInvite"
    | "settings"
    | "setPolicy"
    | "setCredential"
  >;
  /** A dedicated credential changed: cached provider probes for the workspace are stale. */
  credentialsChanged(workspaceId: string): void;
  /** A member was removed or their role changed: what their open sockets may watch is re-checked. */
  accessChanged?(userId: string): void;
}

const STATUS = { not_found: 404, forbidden: 403, invalid: 400, conflict: 409 } as const;

const AddBody = z.object({
  identifier: z.string().trim().min(1).max(320),
  role: AssignableRole.default("member"),
});

const PatchBody = z
  .object({
    role: AssignableRole.optional(),
    canCreateProject: z.boolean().nullable().optional(),
    canCreateSession: z.boolean().nullable().optional(),
  })
  .refine((p) => Object.values(p).some((v) => v !== undefined), { message: "nothing to change" });

const InviteBody = z.object({
  role: AssignableRole.default("member"),
  expiresInDays: z.number().int().min(1).max(30).default(7),
  maxUses: z.number().int().min(1).max(1000).nullable().default(null),
});

const SettingsBody = z.object({ credentialPolicy: CredentialPolicy });

const CredentialBody = z.object({
  /** null clears it. */
  value: z.string().trim().min(1).max(4000).nullable(),
});

const Uuid = z.string().uuid();

/**
 * Sharing a workspace: its members and their roles, invite links, and the
 * harness subscription its turns run on.
 *
 * Every check lives in `WorkspaceMemberService`, against the caller's own
 * membership; these routes parse, ask, and translate the answer.
 */
export function registerWorkspaceMemberRoutes(app: FastifyInstance, deps: WorkspaceMemberRouteDeps): void {
  const { principalFor, members } = deps;
  const unauthorized = { error: "unauthorized" };
  const notFound = { error: "workspace not found" };

  type Id = { id: string };
  type IdAndUser = { id: string; userId: string };

  app.get<{ Params: Id }>("/api/workspaces/:id/members", async (request, reply) => {
    const principal = await principalFor(request.cookies);
    if (!principal) return reply.code(401).send(unauthorized);
    if (!Uuid.safeParse(request.params.id).success) return reply.code(404).send(notFound);
    const list = await members.list(request.params.id, principal.userId);
    if (!list) return reply.code(404).send(notFound);
    return { members: list };
  });

  app.post<{ Params: Id }>("/api/workspaces/:id/members", async (request, reply) => {
    const principal = await principalFor(request.cookies);
    if (!principal) return reply.code(401).send(unauthorized);
    if (!Uuid.safeParse(request.params.id).success) return reply.code(404).send(notFound);
    const parsed = AddBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "a username or email and a role are required" });
    const result = await members.add(request.params.id, principal.userId, parsed.data.identifier, parsed.data.role);
    if ("error" in result) return reply.code(STATUS[result.error]).send({ error: result.message });
    return reply.code(201).send(result);
  });

  app.patch<{ Params: IdAndUser }>("/api/workspaces/:id/members/:userId", async (request, reply) => {
    const principal = await principalFor(request.cookies);
    if (!principal) return reply.code(401).send(unauthorized);
    if (!Uuid.safeParse(request.params.id).success || !Uuid.safeParse(request.params.userId).success) {
      return reply.code(404).send(notFound);
    }
    const parsed = PatchBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "a role or permission to change is required" });
    const result = await members.update(request.params.id, principal.userId, request.params.userId, parsed.data);
    if ("error" in result) return reply.code(STATUS[result.error]).send({ error: result.message });
    deps.accessChanged?.(request.params.userId);
    return { ok: true };
  });

  app.delete<{ Params: IdAndUser }>("/api/workspaces/:id/members/:userId", async (request, reply) => {
    const principal = await principalFor(request.cookies);
    if (!principal) return reply.code(401).send(unauthorized);
    if (!Uuid.safeParse(request.params.id).success || !Uuid.safeParse(request.params.userId).success) {
      return reply.code(404).send(notFound);
    }
    const result = await members.remove(request.params.id, principal.userId, request.params.userId);
    if ("error" in result) return reply.code(STATUS[result.error]).send({ error: result.message });
    deps.accessChanged?.(request.params.userId);
    return reply.code(204).send();
  });

  // -- Invite links -------------------------------------------------------------

  app.get<{ Params: Id }>("/api/workspaces/:id/invites", async (request, reply) => {
    const principal = await principalFor(request.cookies);
    if (!principal) return reply.code(401).send(unauthorized);
    if (!Uuid.safeParse(request.params.id).success) return reply.code(404).send(notFound);
    const invites = await members.listInvites(request.params.id, principal.userId);
    if (!invites) return reply.code(404).send(notFound);
    return { invites };
  });

  app.post<{ Params: Id }>("/api/workspaces/:id/invites", async (request, reply) => {
    const principal = await principalFor(request.cookies);
    if (!principal) return reply.code(401).send(unauthorized);
    if (!Uuid.safeParse(request.params.id).success) return reply.code(404).send(notFound);
    const parsed = InviteBody.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "invalid invite settings" });
    const result = await members.createInvite(request.params.id, principal.userId, parsed.data);
    if ("error" in result) return reply.code(STATUS[result.error]).send({ error: result.message });
    return reply.code(201).send(result);
  });

  app.delete<{ Params: { id: string; inviteId: string } }>(
    "/api/workspaces/:id/invites/:inviteId",
    async (request, reply) => {
      const principal = await principalFor(request.cookies);
      if (!principal) return reply.code(401).send(unauthorized);
      if (!Uuid.safeParse(request.params.id).success || !Uuid.safeParse(request.params.inviteId).success) {
        return reply.code(404).send({ error: "invite not found" });
      }
      const revoked = await members.revokeInvite(request.params.id, principal.userId, request.params.inviteId);
      if (!revoked) return reply.code(404).send({ error: "invite not found" });
      return reply.code(204).send();
    },
  );

  // Signed in, but not a member yet: the token is the whole grant.
  app.get<{ Params: { token: string } }>("/api/invites/:token", async (request, reply) => {
    const principal = await principalFor(request.cookies);
    if (!principal) return reply.code(401).send(unauthorized);
    const preview = await members.previewInvite(request.params.token, principal.userId);
    if (!preview) return reply.code(404).send({ error: "this invite link is invalid or has expired" });
    return preview;
  });

  app.post<{ Params: { token: string } }>("/api/invites/:token/accept", async (request, reply) => {
    const principal = await principalFor(request.cookies);
    if (!principal) return reply.code(401).send(unauthorized);
    const joined = await members.acceptInvite(request.params.token, principal.userId);
    if (!joined) return reply.code(404).send({ error: "this invite link is invalid or has expired" });
    return joined;
  });

  // -- Harness subscription -----------------------------------------------------

  app.get<{ Params: Id }>("/api/workspaces/:id/settings", async (request, reply) => {
    const principal = await principalFor(request.cookies);
    if (!principal) return reply.code(401).send(unauthorized);
    if (!Uuid.safeParse(request.params.id).success) return reply.code(404).send(notFound);
    const settings = await members.settings(request.params.id, principal.userId);
    if (!settings) return reply.code(404).send(notFound);
    return settings;
  });

  app.patch<{ Params: Id }>("/api/workspaces/:id/settings", async (request, reply) => {
    const principal = await principalFor(request.cookies);
    if (!principal) return reply.code(401).send(unauthorized);
    if (!Uuid.safeParse(request.params.id).success) return reply.code(404).send(notFound);
    const parsed = SettingsBody.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: "credentialPolicy must be member, workspace or either" });
    if (!(await members.setPolicy(request.params.id, principal.userId, parsed.data.credentialPolicy))) {
      return reply.code(403).send({ error: "only a workspace admin can change this" });
    }
    return members.settings(request.params.id, principal.userId);
  });

  app.put<{ Params: { id: string; kind: string } }>(
    "/api/workspaces/:id/credentials/:kind",
    async (request, reply) => {
      const principal = await principalFor(request.cookies);
      if (!principal) return reply.code(401).send(unauthorized);
      if (!Uuid.safeParse(request.params.id).success) return reply.code(404).send(notFound);
      const kind = request.params.kind;
      if (kind !== "openrouter" && kind !== "claude-token") {
        return reply.code(404).send({ error: "unknown credential" });
      }
      const parsed = CredentialBody.safeParse(request.body);
      if (!parsed.success) return reply.code(400).send({ error: "a value or null is required" });
      const result = await members.setCredential(request.params.id, principal.userId, kind, parsed.data.value);
      if ("error" in result) {
        if (result.error === "no_secret_key") {
          return reply.code(409).send({ error: "SECRET_KEY is not configured, so a key cannot be stored safely" });
        }
        return reply.code(403).send({ error: "only a workspace admin can change this" });
      }
      deps.credentialsChanged(request.params.id);
      return members.settings(request.params.id, principal.userId);
    },
  );
}
