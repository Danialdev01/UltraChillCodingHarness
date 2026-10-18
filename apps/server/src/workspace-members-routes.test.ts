import Fastify from "fastify";
import cookie from "@fastify/cookie";
import { describe, expect, it } from "vitest";
import { canAssignRole, canManageMember, type Membership } from "@ucch/protocol";
import { registerWorkspaceMemberRoutes, type WorkspaceMemberRouteDeps } from "./workspace-members-routes.js";

const WS = "00000000-0000-4000-8000-000000000001";
const OWNER = "00000000-0000-4000-8000-0000000000a1";
const ADMIN = "00000000-0000-4000-8000-0000000000a2";
const MEMBER = "00000000-0000-4000-8000-0000000000a3";
const STRANGER = "00000000-0000-4000-8000-0000000000a4";

/** The service's contract, in memory, using the same role rules the real one does. */
function fakeMembers() {
  const roster = new Map<string, Membership>([
    [OWNER, { role: "owner", canCreateProject: null, canCreateSession: null }],
    [ADMIN, { role: "admin", canCreateProject: null, canCreateSession: null }],
    [MEMBER, { role: "member", canCreateProject: null, canCreateSession: null }],
  ]);
  const invites = new Map<string, { role: "admin" | "member" | "viewer"; used: boolean }>();
  const members: WorkspaceMemberRouteDeps["members"] = {
    async list(_ws, actor) {
      if (!roster.has(actor)) return null;
      return [...roster].map(([userId, m]) => ({
        userId, login: userId, name: null, email: null, avatarUrl: null, joinedAt: new Date(), ...m,
      }));
    },
    async add(_ws, actor, identifier, role) {
      const a = roster.get(actor);
      if (!a) return { error: "not_found", message: "workspace not found" };
      if (!canAssignRole(a, role)) return { error: "forbidden", message: "no" };
      if (roster.has(identifier)) return { error: "conflict", message: "already" };
      roster.set(identifier, { role, canCreateProject: null, canCreateSession: null });
      return { userId: identifier };
    },
    async update(_ws, actor, target, patch) {
      const a = roster.get(actor);
      const t = roster.get(target);
      if (!a || !t) return { error: "not_found", message: "missing" };
      if (!canManageMember(a, t)) return { error: "forbidden", message: "no" };
      if (patch.role && !canAssignRole(a, patch.role)) return { error: "forbidden", message: "no" };
      roster.set(target, { ...t, ...patch } as Membership);
      return { ok: true };
    },
    async remove(_ws, actor, target) {
      const a = roster.get(actor);
      const t = roster.get(target);
      if (!a || !t) return { error: "not_found", message: "missing" };
      if (actor === target ? t.role === "owner" : !canManageMember(a, t)) {
        return { error: "forbidden", message: "no" };
      }
      roster.delete(target);
      return { ok: true };
    },
    async listInvites() {
      return [];
    },
    async createInvite(_ws, actor, input) {
      const a = roster.get(actor);
      if (!a || !canAssignRole(a, input.role)) return { error: "forbidden", message: "no" };
      const token = `tok${invites.size}`;
      invites.set(token, { role: input.role, used: false });
      return {
        token,
        invite: { id: WS, role: input.role, expiresAt: new Date(), uses: 0, maxUses: input.maxUses, createdAt: new Date(), createdBy: actor },
      };
    },
    async revokeInvite() {
      return true;
    },
    async previewInvite(token) {
      const invite = invites.get(token);
      return invite && !invite.used
        ? { workspaceId: WS, workspaceHash: "wkspc0hash00", workspaceName: "Acme", ownerName: "o", role: invite.role, alreadyMember: false }
        : null;
    },
    async acceptInvite(token, userId) {
      const invite = invites.get(token);
      if (!invite || invite.used) return null;
      invite.used = true;
      roster.set(userId, { role: invite.role, canCreateProject: null, canCreateSession: null });
      return { workspaceId: WS, workspaceHash: "wkspc0hash00" };
    },
    async settings(_ws, actor) {
      return roster.has(actor)
        ? { credentialPolicy: "member", credentials: { openrouter: false, claudeToken: false, claudeTokenIssuedAt: null } }
        : null;
    },
    async setPolicy(_ws, actor) {
      const role = roster.get(actor)?.role;
      return role === "owner" || role === "admin";
    },
    async setCredential(_ws, actor) {
      const role = roster.get(actor)?.role;
      return role === "owner" || role === "admin" ? { ok: true } : { error: "forbidden" };
    },
  };
  return { members, roster };
}

async function server() {
  const app = Fastify();
  await app.register(cookie);
  const fake = fakeMembers();
  const changed: string[] = [];
  registerWorkspaceMemberRoutes(app, {
    principalFor: async (cookies) => (cookies.who ? { userId: cookies.who } : null),
    members: fake.members,
    credentialsChanged: (id) => changed.push(id),
  });
  return { app, ...fake, changed };
}

const as = (userId: string) => ({ cookie: `who=${userId}` });

describe("workspace member routes", () => {
  it("requires a session", async () => {
    const { app } = await server();
    const res = await app.inject({ method: "GET", url: `/api/workspaces/${WS}/members` });
    expect(res.statusCode).toBe(401);
  });

  it("hides the workspace from a non-member", async () => {
    const { app } = await server();
    const res = await app.inject({ method: "GET", url: `/api/workspaces/${WS}/members`, headers: as(STRANGER) });
    expect(res.statusCode).toBe(404);
  });

  it("lets an admin add a member but not another admin", async () => {
    const { app } = await server();
    const ok = await app.inject({
      method: "POST", url: `/api/workspaces/${WS}/members`, headers: as(ADMIN),
      payload: { identifier: STRANGER, role: "viewer" },
    });
    expect(ok.statusCode).toBe(201);
    const refused = await app.inject({
      method: "POST", url: `/api/workspaces/${WS}/members`, headers: as(ADMIN),
      payload: { identifier: "someone", role: "admin" },
    });
    expect(refused.statusCode).toBe(403);
  });

  it("refuses an owner role in the body outright", async () => {
    const { app } = await server();
    const res = await app.inject({
      method: "POST", url: `/api/workspaces/${WS}/members`, headers: as(OWNER),
      payload: { identifier: STRANGER, role: "owner" },
    });
    expect(res.statusCode).toBe(400);
  });

  it("never lets the owner be demoted or removed", async () => {
    const { app } = await server();
    const demote = await app.inject({
      method: "PATCH", url: `/api/workspaces/${WS}/members/${OWNER}`, headers: as(ADMIN),
      payload: { role: "viewer" },
    });
    expect(demote.statusCode).toBe(403);
    const leave = await app.inject({
      method: "DELETE", url: `/api/workspaces/${WS}/members/${OWNER}`, headers: as(OWNER),
    });
    expect(leave.statusCode).toBe(403);
  });

  it("lets a member leave", async () => {
    const { app, roster } = await server();
    const res = await app.inject({
      method: "DELETE", url: `/api/workspaces/${WS}/members/${MEMBER}`, headers: as(MEMBER),
    });
    expect(res.statusCode).toBe(204);
    expect(roster.has(MEMBER)).toBe(false);
  });

  it("toggles a per-member override", async () => {
    const { app, roster } = await server();
    const res = await app.inject({
      method: "PATCH", url: `/api/workspaces/${WS}/members/${MEMBER}`, headers: as(OWNER),
      payload: { canCreateSession: false },
    });
    expect(res.statusCode).toBe(200);
    expect(roster.get(MEMBER)?.canCreateSession).toBe(false);
  });

  it("joins by an invite link exactly once", async () => {
    const { app, roster } = await server();
    const created = await app.inject({
      method: "POST", url: `/api/workspaces/${WS}/invites`, headers: as(OWNER), payload: { role: "viewer" },
    });
    expect(created.statusCode).toBe(201);
    const { token } = created.json() as { token: string };

    const preview = await app.inject({ method: "GET", url: `/api/invites/${token}`, headers: as(STRANGER) });
    expect(preview.json()).toMatchObject({ workspaceName: "Acme", role: "viewer" });

    const accepted = await app.inject({ method: "POST", url: `/api/invites/${token}/accept`, headers: as(STRANGER) });
    expect(accepted.statusCode).toBe(200);
    expect(roster.get(STRANGER)?.role).toBe("viewer");

    const again = await app.inject({ method: "POST", url: `/api/invites/${token}/accept`, headers: as(STRANGER) });
    expect(again.statusCode).toBe(404);
  });

  it("keeps the harness subscription an admin's to change", async () => {
    const { app, changed } = await server();
    const refused = await app.inject({
      method: "PUT", url: `/api/workspaces/${WS}/credentials/openrouter`, headers: as(MEMBER),
      payload: { value: "sk-or-x" },
    });
    expect(refused.statusCode).toBe(403);
    const ok = await app.inject({
      method: "PUT", url: `/api/workspaces/${WS}/credentials/openrouter`, headers: as(ADMIN),
      payload: { value: "sk-or-x" },
    });
    expect(ok.statusCode).toBe(200);
    expect(changed).toEqual([WS]);

    const policy = await app.inject({
      method: "PATCH", url: `/api/workspaces/${WS}/settings`, headers: as(MEMBER),
      payload: { credentialPolicy: "workspace" },
    });
    expect(policy.statusCode).toBe(403);
  });
});
