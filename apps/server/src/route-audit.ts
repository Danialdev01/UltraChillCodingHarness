import type { LiveResource } from "@ucch/protocol";

/**
 * What a successful write through the REST API means, for the activity log
 * and for the other tabs that need to refetch.
 *
 * The routes with something richer to say -- notes, timeline tasks, files,
 * whose logs carry diffs and whose notices carry content -- write their own
 * entries and are listed in `SELF_AUDITED`. Everything else that changes
 * something is described here once, from the route's pattern, so a new route
 * is either in this table or visibly falls through to the generic line.
 *
 * Only names and identifiers are read from a body, never values: a key's
 * secret, a password or a SQL statement does not belong in a history that is
 * shown to everyone on the project.
 */

export interface RouteChange {
  action: string;
  targetType: string;
  targetId?: string | null;
  summary: string;
  details?: Record<string, unknown>;
  /** What the other tabs should refetch. */
  resource?: LiveResource;
  /** Account changes have no project; project ones are found from `:hash`. */
  scope: "project" | "account";
}

type Params = Record<string, string | undefined>;
type Body = Record<string, unknown> | undefined;

type Describe = (params: Params, body: Body, query: Params) => Omit<RouteChange, "scope"> & {
  scope?: RouteChange["scope"];
};

const str = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 ? value.slice(0, 200) : undefined;

const quoted = (value: unknown, fallback: string): string => {
  const s = str(value);
  return s ? `“${s}”` : fallback;
};

/** Routes that write their own, richer entries. Not logged twice. */
export const SELF_AUDITED = new Set([
  "POST /api/projects/:hash/notes",
  "PATCH /api/projects/:hash/notes/:noteId",
  "POST /api/projects/:hash/notes/:noteId/move",
  "DELETE /api/projects/:hash/notes/:noteId",
  "POST /api/projects/:hash/timeline/tasks",
  "PATCH /api/projects/:hash/timeline/tasks/:taskId",
  "DELETE /api/projects/:hash/timeline/tasks/:taskId",
  "PUT /api/projects/:hash/file",
  "POST /api/projects/:hash/file",
  "PATCH /api/projects/:hash/file",
  "DELETE /api/projects/:hash/file",
  // Logged only when a session was actually removed: `?ifEmpty=1` often keeps it.
  "DELETE /api/projects/:hash/sessions/:sessionHash",
]);

/** Writes that change nothing anyone would call a change. */
const IGNORED = new Set([
  "POST /api/ws-ticket",
  "POST /api/auth/login",
  "POST /api/auth/logout",
  // Staging an attachment or an image is part of the message or page it is
  // for, which is what gets logged.
  "POST /api/projects/:hash/uploads",
  "DELETE /api/projects/:hash/uploads/:id",
  "POST /api/projects/:hash/notes/assets",
  // Reads that are POSTs for the size of their input.
  "POST /api/projects/:hash/git/fetch",
]);

const TABLE: Record<string, Describe> = {
  // -- Keys ------------------------------------------------------------------
  "POST /api/projects/:hash/keys": (_p, b) => ({
    action: "key.create",
    targetType: "key",
    summary: `Saved key ${quoted(b?.name, "")}`.trim(),
    resource: "keys",
  }),
  "PATCH /api/projects/:hash/keys/:keyId": (p, b) => ({
    action: "key.update",
    targetType: "key",
    targetId: p.keyId,
    summary: `Changed key ${quoted(b?.name, "")}`.trim(),
    details: { fields: Object.keys(b ?? {}).filter((k) => k !== "value" && k !== "secret") },
    resource: "keys",
  }),
  "DELETE /api/projects/:hash/keys/:keyId": (p) => ({
    action: "key.delete",
    targetType: "key",
    targetId: p.keyId,
    summary: "Deleted a key",
    resource: "keys",
  }),

  // -- Project ---------------------------------------------------------------
  "PUT /api/projects/:hash/preview": (_p, b) => ({
    action: "project.preview",
    targetType: "project",
    summary: typeof b?.port === "number" ? `Set the preview port to ${b.port}` : "Changed the preview",
    resource: "project_settings",
  }),
  "PATCH /api/projects/:hash/public": (_p, b) => ({
    action: "project.public",
    targetType: "project",
    summary: b?.enabled === false ? "Unpublished the public site" : "Changed the public site",
    resource: "project_settings",
  }),
  "PUT /api/projects/:hash/task-settings": (_p, b) => {
    const autoRun = b?.autoRun as { enabled?: unknown; time?: unknown; timezone?: unknown } | undefined;
    return {
      action: "task.settings",
      targetType: "project",
      summary:
        autoRun?.enabled === true
          ? `Turned on Auto Run Tasks at ${String(autoRun.time)} (${String(autoRun.timezone)})`
          : "Saved the task automation settings",
      resource: "project_settings",
    };
  },
  "DELETE /api/projects/:hash": () => ({
    action: "project.delete",
    targetType: "project",
    summary: "Deleted the project",
    resource: "projects",
    scope: "account",
  }),
  "POST /api/workspaces": (_p, b) => ({
    action: "workspace.create",
    targetType: "workspace",
    summary: `Created workspace ${quoted(b?.name, "")}`.trim(),
    resource: "projects",
    scope: "account",
  }),
  "PATCH /api/workspaces/:id": (p, b) => ({
    action: b?.archived === true ? "workspace.archive" : b?.archived === false ? "workspace.unarchive" : "workspace.update",
    targetType: "workspace",
    targetId: p.id,
    summary:
      b?.archived === true
        ? "Archived a workspace"
        : b?.archived === false
          ? "Restored an archived workspace"
          : `Renamed a workspace to ${quoted(b?.name, "")}`.trim(),
    resource: "projects",
    scope: "account",
  }),
  "DELETE /api/workspaces/:id": (p) => ({
    action: "workspace.delete",
    targetType: "workspace",
    targetId: p.id,
    summary: "Deleted an empty workspace",
    resource: "projects",
    scope: "account",
  }),
  // -- Workspace sharing -----------------------------------------------------
  "POST /api/workspaces/:id/members": (p, b) => ({
    action: "workspace.member_add",
    targetType: "workspace",
    targetId: p.id,
    summary: `Added ${quoted(b?.identifier, "a member")} as ${str(b?.role) ?? "member"}`,
    resource: "workspace_members",
    scope: "account",
  }),
  "PATCH /api/workspaces/:id/members/:userId": (p, b) => ({
    action: "workspace.member_update",
    targetType: "workspace",
    targetId: p.id,
    summary: str(b?.role) ? `Changed a member's role to ${str(b?.role)}` : "Changed a member's permissions",
    resource: "workspace_members",
    scope: "account",
  }),
  "DELETE /api/workspaces/:id/members/:userId": (p) => ({
    action: "workspace.member_remove",
    targetType: "workspace",
    targetId: p.id,
    summary: "Removed a member from a workspace",
    resource: "workspace_members",
    scope: "account",
  }),
  "POST /api/workspaces/:id/invites": (p, b) => ({
    action: "workspace.invite_create",
    targetType: "workspace",
    targetId: p.id,
    summary: `Created an invite link for a ${str(b?.role) ?? "member"}`,
    resource: "workspace_members",
    scope: "account",
  }),
  "DELETE /api/workspaces/:id/invites/:inviteId": (p) => ({
    action: "workspace.invite_revoke",
    targetType: "workspace",
    targetId: p.id,
    summary: "Revoked an invite link",
    resource: "workspace_members",
    scope: "account",
  }),
  "POST /api/invites/:token/accept": () => ({
    action: "workspace.join",
    targetType: "workspace",
    summary: "Joined a workspace by invite link",
    resource: "projects",
    scope: "account",
  }),
  "PATCH /api/workspaces/:id/settings": (p, b) => ({
    action: "workspace.credential_policy",
    targetType: "workspace",
    targetId: p.id,
    summary: `Set the workspace's harness subscription to ${str(b?.credentialPolicy) ?? "a new policy"}`,
    resource: "workspace_members",
    scope: "account",
  }),
  // The value is never read: only which credential changed.
  "PUT /api/workspaces/:id/credentials/:kind": (p, b) => ({
    action: "workspace.credential_set",
    targetType: "workspace",
    targetId: p.id,
    summary: `${b?.value === null ? "Removed" : "Updated"} the workspace's ${p.kind === "openrouter" ? "OpenRouter key" : "Claude token"}`,
    resource: "workspace_members",
    scope: "account",
  }),
  "PATCH /api/projects/:hash": (_p, b) => ({
    action: "project.rename",
    targetType: "project",
    summary: `Renamed to ${quoted(b?.name, "")}`.trim(),
    resource: "projects",
  }),
  "POST /api/projects/:hash/diagrams/:kind/generate": (p) => ({
    action: "diagram.generate",
    targetType: "diagram",
    targetId: p.kind,
    summary: `Regenerated the ${p.kind ?? ""} diagram`.replace("  ", " "),
  }),
  "POST /api/projects/:hash/uploads/:id/attach": (p, b) => ({
    action: "file.attach",
    targetType: "file",
    targetId: str(b?.path) ?? p.id,
    summary: `Placed an attachment at ${str(b?.path) ?? "the workspace"}`,
  }),

  // -- Git -------------------------------------------------------------------
  "POST /api/projects/:hash/git/stage": () => ({ action: "git.stage", targetType: "git", summary: "Staged changes" }),
  "POST /api/projects/:hash/git/unstage": () => ({ action: "git.unstage", targetType: "git", summary: "Unstaged changes" }),
  "POST /api/projects/:hash/git/discard": () => ({ action: "git.discard", targetType: "git", summary: "Discarded changes" }),
  "POST /api/projects/:hash/git/commit": (_p, b) => ({
    action: "git.commit",
    targetType: "git",
    summary: `Committed ${quoted(b?.summary, "changes")}`,
  }),
  "POST /api/projects/:hash/git/checkout": (_p, b) => ({
    action: "git.checkout",
    targetType: "branch",
    targetId: str(b?.branch) ?? null,
    summary: `Switched to ${str(b?.branch) ?? "a branch"}`,
  }),
  "POST /api/projects/:hash/git/branches": (_p, b) => ({
    action: "git.branch",
    targetType: "branch",
    targetId: str(b?.name) ?? null,
    summary: `Created branch ${str(b?.name) ?? ""}`.trim(),
  }),
  "POST /api/projects/:hash/git/pull": () => ({ action: "git.pull", targetType: "git", summary: "Pulled" }),
  "POST /api/projects/:hash/git/push": () => ({ action: "git.push", targetType: "git", summary: "Pushed" }),
  "POST /api/projects/:hash/git/remote": () => ({ action: "git.remote", targetType: "git", summary: "Changed the remote" }),
  "POST /api/projects/:hash/git/resolve": (_p, b) => ({
    action: "git.resolve",
    targetType: "file",
    targetId: str(b?.path) ?? null,
    summary: `Resolved a conflict${str(b?.path) ? ` in ${str(b?.path)}` : ""}`,
  }),
  "POST /api/projects/:hash/git/merge/abort": () => ({ action: "git.merge_abort", targetType: "git", summary: "Aborted the merge" }),

  // -- Account and settings --------------------------------------------------
  "PUT /api/account/name": () => account("account.name", "Changed the display name"),
  "PUT /api/account/email": () => account("account.email", "Changed the email address"),
  "PUT /api/account/password": () => account("account.password", "Changed the password"),
  "PUT /api/account/avatar": () => account("account.avatar", "Changed the avatar"),
  "PUT /api/settings/agent-permission-mode": () => account("settings.permissions", "Changed the agent permission mode"),
  "PUT /api/settings/openrouter": () => account("settings.openrouter", "Changed the OpenRouter key"),
  "PUT /api/settings/resend": () => account("settings.resend", "Changed the Resend key"),
  "PUT /api/settings/github": () => account("settings.github", "Changed the GitHub token"),
  "PUT /api/settings/default-model": () => account("settings.model", "Changed the default model"),
  "PUT /api/settings/claude-token": () => account("settings.claude", "Changed the Claude token"),
  "PUT /api/settings/default-provider": () => account("settings.provider", "Changed the default provider"),
  "DELETE /api/providers/:id/credentials": (p) => account("settings.credentials", `Signed out of ${p.id ?? "a provider"}`),

  // -- Database connections --------------------------------------------------
  "POST /api/workspaces/:id/database-connections": (_p, b) =>
    database("database.connect", `Added connection ${quoted(b?.name, "")}`.trim()),
  "PATCH /api/database-connections/:id": (p) => database("database.update", "Changed a database connection", p.id),
  "DELETE /api/database-connections/:id": (p) => database("database.disconnect", "Removed a database connection", p.id),
  "POST /api/database-connections/:id/databases": (p, b) =>
    database("database.create", `Created database ${str(b?.name) ?? ""}`.trim(), p.id),
  "DELETE /api/database-connections/:id/databases/:db": (p) =>
    database("database.drop", `Dropped database ${p.db ?? ""}`.trim(), p.id),
};

function account(action: string, summary: string): ReturnType<Describe> {
  return { action, targetType: "account", summary, resource: "account_settings", scope: "account" };
}

function database(action: string, summary: string, id?: string): ReturnType<Describe> {
  return {
    action,
    targetType: "database",
    targetId: id ?? null,
    summary,
    resource: "database_connections",
    scope: "account",
  };
}

/** The database manager's routes, one prefix with many shapes under it. */
const DB_MANAGER = "/api/database-connections/:id/db/:db";

function describeDbManager(method: string, url: string, params: Params): ReturnType<Describe> | null {
  if (!url.startsWith(DB_MANAGER)) return null;
  const rest = url.slice(DB_MANAGER.length);
  const where = `${params.db ?? "a database"}${params.table ? `.${params.table}` : ""}`;
  const verb =
    rest === "/sql"
      ? "Ran SQL on"
      : rest === "/import"
        ? "Imported into"
        : rest.includes("/rows")
          ? { POST: "Inserted rows into", PATCH: "Updated rows in", DELETE: "Deleted rows from" }[method]
          : rest.includes("/columns")
            ? { POST: "Added a column to", PATCH: "Changed a column of", DELETE: "Dropped a column from" }[method]
            : rest.includes("/indexes")
              ? { POST: "Added an index to", DELETE: "Dropped an index from" }[method]
              : rest.endsWith("/truncate")
                ? "Truncated"
                : rest.startsWith("/users")
                  ? "Changed database users on"
                  : rest.startsWith("/tables")
                    ? { POST: "Created a table in", PATCH: "Changed table", DELETE: "Dropped table" }[method]
                    : undefined;
  return {
    ...database(
      `database.${rest.split("/").filter((s) => s && !s.startsWith(":"))[0] ?? "change"}`,
      `${verb ?? "Changed"} ${where}`,
    ),
    // Which open table views should refetch: one table, or with no table in
    // the route, every view of the database.
    targetId: `${params.id ?? ""}/${params.db ?? ""}/${params.table ?? ""}`,
    resource: "database_data",
  };
}

/**
 * What a successful write means, or null when it is not one to log: a read,
 * a route that logs itself, or one in `IGNORED`. A write nobody described
 * still gets a plain line rather than none.
 */
export function describeRoute(
  method: string,
  url: string | undefined,
  params: Params,
  body: unknown,
  query: Params = {},
): RouteChange | null {
  if (!url || !["POST", "PUT", "PATCH", "DELETE"].includes(method)) return null;
  const key = `${method} ${url}`;
  if (SELF_AUDITED.has(key) || IGNORED.has(key)) return null;
  const record = body && typeof body === "object" && !Buffer.isBuffer(body) ? (body as Body) : undefined;
  const described = TABLE[key]?.(params, record, query) ?? describeDbManager(method, url, params);
  if (described) {
    return {
      scope: url.startsWith("/api/projects/:hash") ? "project" : "account",
      // Every git route changes what the Git view shows, in every tab.
      ...(described.action.startsWith("git.") ? { resource: "git" as const } : {}),
      ...described,
    };
  }
  if (!url.startsWith("/api/")) return null;
  return {
    action: `${method.toLowerCase()} ${url}`,
    targetType: "route",
    summary: `${method} ${url.replace("/api/", "")}`,
    scope: url.startsWith("/api/projects/:hash") ? "project" : "account",
  };
}
