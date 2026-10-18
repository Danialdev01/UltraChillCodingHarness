import { z } from "zod";

/**
 * Who a person is in a workspace.
 *
 *   owner   created it; everything, and cannot be removed or demoted.
 *   admin   everything except deleting the workspace or touching the owner.
 *   member  works in it: creates projects and sessions, talks to agents.
 *   viewer  reads only.
 *
 * Shared between server and web so the UI hides exactly what the server
 * would refuse.
 */
export const WorkspaceRole = z.enum(["owner", "admin", "member", "viewer"]);
export type WorkspaceRole = z.infer<typeof WorkspaceRole>;

/** The roles a person can be given -- `owner` is only ever the creator. */
export const AssignableRole = z.enum(["admin", "member", "viewer"]);
export type AssignableRole = z.infer<typeof AssignableRole>;

export const WorkspacePermission = z.enum([
  "workspace.view",
  "workspace.manage",
  "workspace.delete",
  "members.manage",
  "credentials.manage",
  "project.create",
  "project.write",
  "session.create",
]);
export type WorkspacePermission = z.infer<typeof WorkspacePermission>;

/**
 * Whose harness subscription a workspace's turns run on.
 *
 *   member     each person's own Claude Code / OpenRouter / Codex login.
 *   workspace  the workspace's dedicated credentials, for everyone.
 *   either     chosen per session when it is started.
 */
export const CredentialPolicy = z.enum(["member", "workspace", "either"]);
export type CredentialPolicy = z.infer<typeof CredentialPolicy>;

export const CredentialSource = z.enum(["member", "workspace"]);
export type CredentialSource = z.infer<typeof CredentialSource>;

const ALL = WorkspacePermission.options;

export const ROLE_PERMISSIONS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== "workspace.delete"),
  member: ["workspace.view", "project.create", "project.write", "session.create"],
  viewer: ["workspace.view"],
};

export interface Membership {
  role: WorkspaceRole;
  /** Null follows the role's default. */
  canCreateProject: boolean | null;
  canCreateSession: boolean | null;
}

export function can(membership: Membership | null | undefined, permission: WorkspacePermission) {
  if (!membership) return false;
  // The owner's overrides are ignored so the owner can never lock themselves out.
  if (membership.role !== "owner") {
    if (permission === "project.create" && membership.canCreateProject !== null) {
      return membership.canCreateProject;
    }
    if (permission === "session.create" && membership.canCreateSession !== null) {
      return membership.canCreateSession;
    }
  }
  return ROLE_PERMISSIONS[membership.role].includes(permission);
}

export function permissionsOf(membership: Membership | null | undefined): WorkspacePermission[] {
  return ALL.filter((p) => can(membership, p));
}

/**
 * Whether `actor` may change or remove `target`'s membership. Nobody touches
 * the owner; an admin manages members and viewers but not other admins.
 */
export function canManageMember(actor: Membership | null | undefined, target: Membership) {
  if (!can(actor, "members.manage") || !actor) return false;
  if (target.role === "owner") return false;
  if (actor.role === "owner") return true;
  return target.role !== "admin";
}

/** The role an actor may hand out: an admin cannot mint other admins. */
export function canAssignRole(actor: Membership | null | undefined, role: WorkspaceRole) {
  if (!actor || !can(actor, "members.manage") || role === "owner") return false;
  return actor.role === "owner" || role !== "admin";
}

/**
 * Whose credentials a new thread binds to. Under `either` the starter's
 * choice wins, defaulting to their own.
 */
export function resolveCredentialSource(
  policy: CredentialPolicy,
  requested?: CredentialSource | null,
): CredentialSource {
  if (policy === "either") return requested ?? "member";
  return policy;
}

/**
 * Whose credentials a turn on an existing thread runs on. A fixed policy
 * overrides what the thread was started with, so switching a workspace to
 * dedicated credentials takes effect for old threads too.
 */
export function effectiveCredentialSource(
  policy: CredentialPolicy,
  bound: CredentialSource | null | undefined,
): CredentialSource {
  if (policy === "either") return bound ?? "member";
  return policy;
}
