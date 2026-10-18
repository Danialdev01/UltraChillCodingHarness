import { createHash, randomBytes } from "node:crypto";
import { and, asc, desc, eq, isNull, or, sql } from "drizzle-orm";
import { users, workspaceInvites, workspaceMembers, workspaces, type Database } from "@ucch/db";
import {
  canAssignRole,
  canManageMember,
  type AssignableRole,
  type CredentialPolicy,
  type Membership,
} from "@ucch/protocol";
import { encryptSecret } from "./crypto.js";
import { toMembership, toPolicy, type MemberRow, type WorkspaceService } from "./workspaces.js";

export interface InviteSummary {
  id: string;
  role: AssignableRole;
  expiresAt: Date;
  uses: number;
  maxUses: number | null;
  createdAt: Date;
  createdBy: string | null;
}

/** What someone holding an invite link is shown before they join. */
export interface InvitePreview {
  workspaceId: string;
  /** The workspace's address, `/{hash}`: where "Open workspace" goes. */
  workspaceHash: string;
  workspaceName: string;
  ownerName: string;
  role: AssignableRole;
  /** True when the caller is already in the workspace. */
  alreadyMember: boolean;
}

export interface WorkspaceSettings {
  credentialPolicy: CredentialPolicy;
  /** Which dedicated credentials are stored -- booleans, never the keys. */
  credentials: { openrouter: boolean; claudeToken: boolean; claudeTokenIssuedAt: string | null };
}

export type MemberError = "not_found" | "forbidden" | "invalid" | "conflict";

const INVITE_DAYS_MAX = 30;

/** sha256, as `sessions.id` stores a session token: the raw token is shown once. */
export function hashInviteToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/**
 * Who is in a workspace, how they got there, and what the workspace's
 * harness subscription is. Every method takes the acting user and checks
 * their membership first, so a route cannot forget to.
 */
export class WorkspaceMemberService {
  constructor(
    private readonly db: Database,
    private readonly workspaces: WorkspaceService,
    private readonly secretKey: string | undefined,
  ) {}

  async list(workspaceId: string, actorId: string): Promise<MemberRow[] | null> {
    if (!(await this.workspaces.canView(workspaceId, actorId))) return null;
    const rows = await this.db
      .select({
        userId: users.id,
        login: users.login,
        name: users.name,
        email: users.email,
        avatarUrl: users.avatarUrl,
        role: workspaceMembers.role,
        canCreateProject: workspaceMembers.canCreateProject,
        canCreateSession: workspaceMembers.canCreateSession,
        joinedAt: workspaceMembers.createdAt,
      })
      .from(workspaceMembers)
      .innerJoin(users, eq(users.id, workspaceMembers.userId))
      .where(eq(workspaceMembers.workspaceId, workspaceId))
      .orderBy(asc(workspaceMembers.createdAt));
    return rows.map(({ role, canCreateProject, canCreateSession, ...row }) => ({
      ...row,
      ...toMembership({ role, canCreateProject, canCreateSession }),
    }));
  }

  /** Adds an existing account by login or email. */
  async add(
    workspaceId: string,
    actorId: string,
    identifier: string,
    role: AssignableRole,
  ): Promise<{ userId: string } | { error: MemberError; message: string }> {
    const actor = await this.workspaces.membership(workspaceId, actorId);
    if (!actor) return { error: "not_found", message: "workspace not found" };
    if (!canAssignRole(actor, role)) {
      return { error: "forbidden", message: `your role cannot add a ${role}` };
    }

    const needle = identifier.trim();
    const [user] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(or(sql`lower(${users.email}) = lower(${needle})`, sql`lower(${users.login}) = lower(${needle})`))
      .limit(1);
    if (!user) {
      return { error: "not_found", message: "no account with that username or email -- send them an invite link" };
    }

    const inserted = await this.db
      .insert(workspaceMembers)
      .values({ workspaceId, userId: user.id, role })
      .onConflictDoNothing()
      .returning({ userId: workspaceMembers.userId });
    if (inserted.length === 0) return { error: "conflict", message: "already a member of this workspace" };
    return { userId: user.id };
  }

  async update(
    workspaceId: string,
    actorId: string,
    targetId: string,
    patch: { role?: AssignableRole; canCreateProject?: boolean | null; canCreateSession?: boolean | null },
  ): Promise<{ ok: true } | { error: MemberError; message: string }> {
    const checked = await this.#checkTarget(workspaceId, actorId, targetId);
    if ("error" in checked) return checked;
    if (patch.role && !canAssignRole(checked.actor, patch.role)) {
      return { error: "forbidden", message: `your role cannot make someone a ${patch.role}` };
    }

    const set: Partial<{ role: string; canCreateProject: boolean | null; canCreateSession: boolean | null }> = {};
    if (patch.role !== undefined) set.role = patch.role;
    if (patch.canCreateProject !== undefined) set.canCreateProject = patch.canCreateProject;
    if (patch.canCreateSession !== undefined) set.canCreateSession = patch.canCreateSession;
    if (Object.keys(set).length > 0) {
      await this.db
        .update(workspaceMembers)
        .set(set)
        .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)));
    }
    return { ok: true };
  }

  /** Removes a member -- or, with `targetId === actorId`, leaves. The owner can do neither. */
  async remove(
    workspaceId: string,
    actorId: string,
    targetId: string,
  ): Promise<{ ok: true } | { error: MemberError; message: string }> {
    if (targetId === actorId) {
      const self = await this.workspaces.membership(workspaceId, actorId);
      if (!self) return { error: "not_found", message: "workspace not found" };
      if (self.role === "owner") {
        return { error: "forbidden", message: "the owner cannot leave their own workspace" };
      }
    } else {
      const checked = await this.#checkTarget(workspaceId, actorId, targetId);
      if ("error" in checked) return checked;
    }
    await this.db
      .delete(workspaceMembers)
      .where(and(eq(workspaceMembers.workspaceId, workspaceId), eq(workspaceMembers.userId, targetId)));
    return { ok: true };
  }

  // -- Invites ----------------------------------------------------------------

  async listInvites(workspaceId: string, actorId: string): Promise<InviteSummary[] | null> {
    if (!(await this.workspaces.allows(workspaceId, actorId, "members.manage"))) return null;
    const rows = await this.db
      .select()
      .from(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.workspaceId, workspaceId),
          isNull(workspaceInvites.revokedAt),
          sql`${workspaceInvites.expiresAt} > now()`,
        ),
      )
      .orderBy(desc(workspaceInvites.createdAt));
    return rows
      .filter((row) => row.maxUses === null || row.uses < row.maxUses)
      .map((row) => ({
        id: row.id,
        role: row.role as AssignableRole,
        expiresAt: row.expiresAt,
        uses: row.uses,
        maxUses: row.maxUses,
        createdAt: row.createdAt,
        createdBy: row.createdBy,
      }));
  }

  /** Mints a link. The raw token comes back once; only its hash is kept. */
  async createInvite(
    workspaceId: string,
    actorId: string,
    input: { role: AssignableRole; expiresInDays: number; maxUses: number | null },
  ): Promise<{ token: string; invite: InviteSummary } | { error: MemberError; message: string }> {
    const actor = await this.workspaces.membership(workspaceId, actorId);
    if (!actor) return { error: "not_found", message: "workspace not found" };
    if (!canAssignRole(actor, input.role)) {
      return { error: "forbidden", message: `your role cannot invite a ${input.role}` };
    }
    const days = Math.min(Math.max(input.expiresInDays, 1), INVITE_DAYS_MAX);
    const token = randomBytes(24).toString("base64url");
    const [row] = await this.db
      .insert(workspaceInvites)
      .values({
        workspaceId,
        tokenHash: hashInviteToken(token),
        role: input.role,
        createdBy: actorId,
        expiresAt: new Date(Date.now() + days * 24 * 3600_000),
        maxUses: input.maxUses,
      })
      .returning();
    return {
      token,
      invite: {
        id: row!.id,
        role: input.role,
        expiresAt: row!.expiresAt,
        uses: 0,
        maxUses: row!.maxUses,
        createdAt: row!.createdAt,
        createdBy: actorId,
      },
    };
  }

  async revokeInvite(workspaceId: string, actorId: string, inviteId: string): Promise<boolean> {
    if (!(await this.workspaces.allows(workspaceId, actorId, "members.manage"))) return false;
    const updated = await this.db
      .update(workspaceInvites)
      .set({ revokedAt: new Date() })
      .where(and(eq(workspaceInvites.id, inviteId), eq(workspaceInvites.workspaceId, workspaceId)))
      .returning({ id: workspaceInvites.id });
    return updated.length > 0;
  }

  /** A live invite by its raw token, or null for one that is unknown, used up, expired or revoked. */
  async previewInvite(token: string, userId: string): Promise<InvitePreview | null> {
    const invite = await this.#liveInvite(token);
    if (!invite) return null;
    const [ws] = await this.db
      .select({
        name: workspaces.name,
        hash: workspaces.hash,
        ownerName: sql<string>`coalesce(${users.name}, ${users.login})`,
      })
      .from(workspaces)
      .innerJoin(users, eq(users.id, workspaces.ownerUserId))
      .where(eq(workspaces.id, invite.workspaceId))
      .limit(1);
    if (!ws) return null;
    return {
      workspaceId: invite.workspaceId,
      workspaceHash: ws.hash,
      workspaceName: ws.name,
      ownerName: ws.ownerName,
      role: invite.role as AssignableRole,
      alreadyMember: await this.workspaces.canView(invite.workspaceId, userId),
    };
  }

  /**
   * Joins by a link. Someone already in the workspace keeps the role they
   * have -- a link is never a way to change one -- and uses no use of it.
   */
  async acceptInvite(token: string, userId: string): Promise<{ workspaceId: string; workspaceHash: string } | null> {
    return this.db.transaction(async (tx) => {
      const invite = await this.#liveInvite(token, tx);
      if (!invite) return null;
      const inserted = await tx
        .insert(workspaceMembers)
        .values({ workspaceId: invite.workspaceId, userId, role: invite.role })
        .onConflictDoNothing()
        .returning({ userId: workspaceMembers.userId });
      if (inserted.length > 0) {
        await tx
          .update(workspaceInvites)
          .set({ uses: sql`${workspaceInvites.uses} + 1` })
          .where(eq(workspaceInvites.id, invite.id));
      }
      // Its address, so the joiner lands in it, `/{hash}`.
      const [workspace] = await tx
        .select({ hash: workspaces.hash })
        .from(workspaces)
        .where(eq(workspaces.id, invite.workspaceId))
        .limit(1);
      return { workspaceId: invite.workspaceId, workspaceHash: workspace!.hash };
    });
  }

  // -- Harness subscription ----------------------------------------------------

  async settings(workspaceId: string, actorId: string): Promise<WorkspaceSettings | null> {
    if (!(await this.workspaces.canView(workspaceId, actorId))) return null;
    const [row] = await this.db
      .select({
        policy: workspaces.credentialPolicy,
        openrouter: workspaces.openrouterKeyEncrypted,
        token: workspaces.claudeOauthTokenEncrypted,
        issuedAt: workspaces.claudeTokenIssuedAt,
      })
      .from(workspaces)
      .where(eq(workspaces.id, workspaceId))
      .limit(1);
    if (!row) return null;
    return {
      credentialPolicy: toPolicy(row.policy),
      credentials: {
        openrouter: Boolean(row.openrouter),
        claudeToken: Boolean(row.token),
        claudeTokenIssuedAt: row.token && row.issuedAt ? row.issuedAt.toISOString() : null,
      },
    };
  }

  async setPolicy(workspaceId: string, actorId: string, policy: CredentialPolicy): Promise<boolean> {
    if (!(await this.workspaces.allows(workspaceId, actorId, "credentials.manage"))) return false;
    await this.db.update(workspaces).set({ credentialPolicy: policy }).where(eq(workspaces.id, workspaceId));
    return true;
  }

  /** Stores or clears (`null`) one of the workspace's dedicated credentials. */
  async setCredential(
    workspaceId: string,
    actorId: string,
    kind: "openrouter" | "claude-token",
    value: string | null,
  ): Promise<{ ok: true } | { error: MemberError | "no_secret_key" }> {
    if (!(await this.workspaces.allows(workspaceId, actorId, "credentials.manage"))) {
      return { error: "forbidden" };
    }
    if (value && !this.secretKey) return { error: "no_secret_key" };
    const encrypted = value ? encryptSecret(value, this.secretKey!) : null;
    await this.db
      .update(workspaces)
      .set(
        kind === "openrouter"
          ? { openrouterKeyEncrypted: encrypted }
          : { claudeOauthTokenEncrypted: encrypted, claudeTokenIssuedAt: encrypted ? new Date() : null },
      )
      .where(eq(workspaces.id, workspaceId));
    return { ok: true };
  }

  // -- Helpers -----------------------------------------------------------------

  async #checkTarget(
    workspaceId: string,
    actorId: string,
    targetId: string,
  ): Promise<{ actor: Membership; target: Membership } | { error: MemberError; message: string }> {
    const actor = await this.workspaces.membership(workspaceId, actorId);
    if (!actor) return { error: "not_found", message: "workspace not found" };
    const target = await this.workspaces.membership(workspaceId, targetId);
    if (!target) return { error: "not_found", message: "member not found" };
    if (!canManageMember(actor, target)) {
      return { error: "forbidden", message: "your role cannot change this member" };
    }
    return { actor, target };
  }

  async #liveInvite(token: string, db: Pick<Database, "select"> = this.db) {
    const [invite] = await db
      .select()
      .from(workspaceInvites)
      .where(
        and(
          eq(workspaceInvites.tokenHash, hashInviteToken(token)),
          isNull(workspaceInvites.revokedAt),
          sql`${workspaceInvites.expiresAt} > now()`,
        ),
      )
      .limit(1);
    if (!invite) return null;
    if (invite.maxUses !== null && invite.uses >= invite.maxUses) return null;
    return invite;
  }
}
