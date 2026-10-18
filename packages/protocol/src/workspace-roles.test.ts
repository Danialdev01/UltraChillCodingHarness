import { describe, expect, it } from "vitest";

import {
  can,
  canAssignRole,
  canManageMember,
  effectiveCredentialSource,
  permissionsOf,
  resolveCredentialSource,
  type Membership,
  type WorkspaceRole,
} from "./workspace-roles.js";

const as = (role: WorkspaceRole, over: Partial<Membership> = {}): Membership => ({
  role,
  canCreateProject: null,
  canCreateSession: null,
  ...over,
});

describe("can", () => {
  it.each([
    ["owner", "workspace.delete", true],
    ["admin", "workspace.delete", false],
    ["admin", "members.manage", true],
    ["admin", "credentials.manage", true],
    ["member", "project.create", true],
    ["member", "members.manage", false],
    ["member", "credentials.manage", false],
    ["viewer", "workspace.view", true],
    ["viewer", "project.write", false],
    ["viewer", "session.create", false],
  ] as const)("%s %s -> %s", (role, permission, expected) => {
    expect(can(as(role), permission)).toBe(expected);
  });

  it("refuses everything without a membership", () => {
    expect(can(null, "workspace.view")).toBe(false);
    expect(permissionsOf(undefined)).toEqual([]);
  });

  it("applies per-member overrides either way", () => {
    expect(can(as("member", { canCreateProject: false }), "project.create")).toBe(false);
    expect(can(as("member", { canCreateSession: false }), "session.create")).toBe(false);
    expect(can(as("viewer", { canCreateSession: true }), "session.create")).toBe(true);
  });

  it("ignores overrides on the owner", () => {
    expect(can(as("owner", { canCreateProject: false }), "project.create")).toBe(true);
  });
});

describe("canManageMember", () => {
  it("never lets anyone touch the owner", () => {
    expect(canManageMember(as("owner"), as("owner"))).toBe(false);
    expect(canManageMember(as("admin"), as("owner"))).toBe(false);
  });

  it("lets an admin manage members but not other admins", () => {
    expect(canManageMember(as("admin"), as("member"))).toBe(true);
    expect(canManageMember(as("admin"), as("admin"))).toBe(false);
    expect(canManageMember(as("owner"), as("admin"))).toBe(true);
  });

  it("refuses members and viewers", () => {
    expect(canManageMember(as("member"), as("viewer"))).toBe(false);
  });
});

describe("canAssignRole", () => {
  it("only lets the owner mint admins, and nobody mint owners", () => {
    expect(canAssignRole(as("owner"), "admin")).toBe(true);
    expect(canAssignRole(as("admin"), "admin")).toBe(false);
    expect(canAssignRole(as("admin"), "viewer")).toBe(true);
    expect(canAssignRole(as("owner"), "owner")).toBe(false);
    expect(canAssignRole(as("member"), "viewer")).toBe(false);
  });
});

describe("credential source", () => {
  it("binds a new thread by policy, letting the starter choose under either", () => {
    expect(resolveCredentialSource("member", "workspace")).toBe("member");
    expect(resolveCredentialSource("workspace", "member")).toBe("workspace");
    expect(resolveCredentialSource("either")).toBe("member");
    expect(resolveCredentialSource("either", "workspace")).toBe("workspace");
  });

  it("lets a fixed policy override what an old thread was bound to", () => {
    expect(effectiveCredentialSource("workspace", "member")).toBe("workspace");
    expect(effectiveCredentialSource("member", "workspace")).toBe("member");
    expect(effectiveCredentialSource("either", "workspace")).toBe("workspace");
    expect(effectiveCredentialSource("either", null)).toBe("member");
  });
});
