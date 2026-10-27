/**
 * `@ucch/protocol/plain`: the constants and helpers the browser uses, with
 * no zod in them.
 *
 * The barrel builds every schema when it loads, so a page that wanted one
 * label carried all of zod. Code shipped to the browser imports values from
 * here and types from the barrel (`import type`); the zod modules take what
 * they share with it from here, so the two cannot drift. Types are imported
 * as types only, which leaves nothing of those modules at runtime.
 */
import type { DatabaseEngine } from "./database.js";
import type { ProjectMode } from "./events.js";
import type { Membership, WorkspacePermission, WorkspaceRole } from "./workspace-roles.js";

export * from "./tokens.js";
export * from "./paths.js";
export * from "./media.js";
export * from "./avatar.js";
export * from "./hostname.js";
export * from "./notes.js";
export * from "./note-text.js";
export * from "./timeline.js";
export * from "./tasks.js";
export * from "./keys.js";
export * from "./text-replacement.js";

// --- Projects ----------------------------------------------------------------

/** What a project can be for; `ProjectMode` is the schema. */
export const PROJECT_MODES = ["research", "development", "creative_design"] as const;

export const PROJECT_MODE_LABELS: Record<ProjectMode, string> = {
  research: "Research",
  development: "Development",
  creative_design: "Creative design",
};

// --- The socket --------------------------------------------------------------

/** The most a `terminal_input` frame carries; a longer paste is sent in pieces. */
export const TERMINAL_INPUT_MAX = 64 * 1024;

/**
 * A thread's newest durable events: what the server replays when a thread
 * is subscribed to, and what the browser keeps of one. One number, so the
 * browser never keeps less than it was sent.
 */
export const THREAD_WINDOW = 1000;

/** In the socket URL's `caps`: this client reads `replay` frames. */
export const REPLAY_CAP = "replay1";

// --- Databases ---------------------------------------------------------------

/** The servers a connection can be to; `DatabaseEngine` is the schema. */
export const DATABASE_ENGINES = ["mysql", "postgresql"] as const;

export const DEFAULT_DB_PORTS: Record<DatabaseEngine, number> = {
  mysql: 3306,
  postgresql: 5432,
};

export const DATABASE_ENGINE_LABELS: Record<DatabaseEngine, string> = {
  mysql: "MySQL",
  postgresql: "PostgreSQL",
};

/**
 * The name of a development database a project asks the harness to create;
 * `DevDatabaseName` is the schema.
 *
 * Narrower than either engine allows, on purpose: lower-case, starting with a
 * letter, letters/digits/underscores only. It is the same identifier on MySQL
 * and PostgreSQL without quoting, and it is safe in a URL and a `.env` file.
 */
export const DEV_DATABASE_NAME = /^[a-z][a-z0-9_]{0,62}$/;

/** Turns a project name into a database name a person would probably pick. */
export function suggestDevDatabaseName(projectName: string): string {
  const cleaned = projectName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^[^a-z]+/, "")
    .replace(/_+$/, "")
    .slice(0, 63);
  return cleaned;
}

export const ROW_PAGE_SIZES = [25, 100, 500] as const;

export const MYSQL_PRIVILEGES = [
  "SELECT", "INSERT", "UPDATE", "DELETE", "CREATE", "DROP", "ALTER", "INDEX", "REFERENCES",
  "CREATE VIEW", "SHOW VIEW", "TRIGGER", "EXECUTE", "EVENT", "CREATE ROUTINE", "ALTER ROUTINE",
  "LOCK TABLES", "CREATE TEMPORARY TABLES", "ALL",
] as const;
export const PG_PRIVILEGES = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "ALL"] as const;

export function privilegesFor(engine: DatabaseEngine): readonly string[] {
  return engine === "mysql" ? MYSQL_PRIVILEGES : PG_PRIVILEGES;
}

// --- Workspace roles ---------------------------------------------------------

/** Who a person can be in a workspace; `WorkspaceRole` is the schema, and says what each is. */
export const WORKSPACE_ROLES = ["owner", "admin", "member", "viewer"] as const;

export const WORKSPACE_PERMISSIONS = [
  "workspace.view",
  "workspace.manage",
  "workspace.delete",
  "members.manage",
  "credentials.manage",
  "project.create",
  "project.write",
  "session.create",
] as const;

const ALL: readonly WorkspacePermission[] = WORKSPACE_PERMISSIONS;

export const ROLE_PERMISSIONS: Record<WorkspaceRole, readonly WorkspacePermission[]> = {
  owner: ALL,
  admin: ALL.filter((p) => p !== "workspace.delete"),
  member: ["workspace.view", "project.create", "project.write", "session.create"],
  viewer: ["workspace.view"],
};

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
