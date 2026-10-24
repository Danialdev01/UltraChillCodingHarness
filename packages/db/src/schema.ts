import { relations, sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  date,
  doublePrecision,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
  type AnyPgColumn,
} from "drizzle-orm/pg-core";
import type {
  DomainEvent,
  NoteDoc,
  TaskAutoRun,
  TaskFeedback,
  TaskReference,
  TaskVerification,
  TokenUsage,
} from "@ucch/protocol";

/**
 * `events` is the source of truth. Every other table here is a projection --
 * a read model maintained in the same transaction as the append, so it can
 * never durably disagree with the log, and can be rebuilt from it.
 */

export const users = pgTable("users", {
  id: uuid("id").primaryKey().defaultRandom(),
  /**
   * An account may authenticate by password, by GitHub, or both, so each
   * credential column is independently nullable. A row with neither is
   * unreachable, which is enforced at the service layer rather than by a
   * check constraint so that credentials can be added and removed freely.
   */
  email: text("email").unique(),
  /** scrypt, encoded as `scrypt$N$r$p$salt$hash`. Never returned to clients. */
  passwordHash: text("password_hash"),
  githubId: text("github_id").unique(),
  login: text("login").notNull(),
  name: text("name"),
  avatarUrl: text("avatar_url"),
  /** GitHub OAuth token, encrypted at rest. Never leaves the server. */
  accessTokenEncrypted: text("access_token_encrypted"),
  /**
   * OpenRouter key, encrypted at rest. Held per user rather than per project
   * so one key serves every project the person owns, and decrypted only when
   * a turn is about to call the API. Never returned to a client -- the
   * settings page is told whether one is set, and shown its last four
   * characters, never the key.
   */
  openrouterKeyEncrypted: text("openrouter_key_encrypted"),
  /**
   * Resend key, encrypted at rest and never returned to a client -- the same
   * treatment as the OpenRouter one above, and for the same reason.
   *
   * Held per user rather than per workspace because it is the account's own
   * sending identity: verification mail, and whatever else needs to leave the
   * harness by email later.
   */
  resendKeyEncrypted: text("resend_key_encrypted"),
  /**
   * GitHub personal access token, encrypted at rest. Read when the new-project
   * dialog lists the repositories you can see, and when a clone needs
   * credentials for a private one.
   *
   * Separate from `accessTokenEncrypted` above, which is the OAuth token the
   * login flow minted: that one proves who you are and is replaced on every
   * sign-in, while this one is a capability you chose to grant and must
   * survive signing in again. A token is resolved from this column first and
   * falls back to the OAuth one, so signing in with GitHub already works for
   * public repositories without setting anything.
   */
  githubTokenEncrypted: text("github_token_encrypted"),
  /**
   * The OpenRouter model this account's turns use when nothing names one.
   *
   * Null means "whatever the server is configured with" rather than "none", so
   * an account that has never chosen follows `DEFAULT_MODEL` and keeps
   * following it when the operator changes it. Held per user rather than per
   * project because it is a preference about how you work; a project still
   * remembers the last model it was actually talked to with.
   */
  defaultModel: text("default_model"),
  /**
   * The backend this account's turns run under when a message names none:
   * `native`, `claude` or `codex`. Null follows the server's default, which
   * is the native loop.
   */
  defaultProvider: text("default_provider"),
  /**
   * `strict`, `normal` or `allow_all`: what an agent may do before this
   * account is asked (see `AgentPermissionMode`). Null is `normal`.
   */
  agentPermissionMode: text("agent_permission_mode"),
  /**
   * A `claude setup-token` OAuth token, encrypted at rest. The headless
   * alternative to signing the CLI in from a terminal: injected as
   * `CLAUDE_CODE_OAUTH_TOKEN` for exactly one spawn and never read otherwise.
   * One-year lifetime, hence the issue date beside it -- the settings page
   * warns at eleven months.
   */
  claudeOauthTokenEncrypted: text("claude_oauth_token_encrypted"),
  claudeTokenIssuedAt: timestamp("claude_token_issued_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A workspace is the container a person's work is organised under -- think of
 * it as a company or a team. One user has many workspaces; each workspace has
 * many projects; each project has many sub-agents.
 *
 * `ownerUserId` is the person who created it and can never be removed from
 * it; everyone with access -- the owner included -- has a row in
 * `workspace_members`, and authorization reads that table, never this column.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** URL-safe identifier, unique per owner rather than globally. */
    slug: text("slug").notNull(),
    /** The workspace's address in the web app, `/{hash}`. Same grammar as a project hash. */
    hash: text("hash").notNull().unique(),
    name: text("name").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    /**
     * project | session. A session workspace holds the same project rows,
     * but each is a lightweight chat with its own files and terminal rather
     * than a named codebase -- only the UI treats the two differently.
     */
    kind: text("kind").notNull().default("project"),
    /** Set while archived: hidden from the switcher's main list, not deleted. */
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    /**
     * The switcher's logo, as a small `data:image/...;base64` URL. Inline
     * rather than a stored file: the browser shrinks it to a few KB before
     * upload, and it then travels with the workspace list at no extra request.
     */
    logo: text("logo"),
    /**
     * Whose harness subscription the workspace's turns run on: `member` (each
     * person's own), `workspace` (the credentials below, for everyone) or
     * `either` (chosen per session). See `CredentialPolicy`.
     */
    credentialPolicy: text("credential_policy").notNull().default("member"),
    /**
     * The workspace's dedicated OpenRouter key and `claude setup-token`
     * token, encrypted at rest the way the per-user columns are and never
     * returned to a client. CLI logins live under `CREDS_ROOT/ws-<id>/`.
     */
    openrouterKeyEncrypted: text("openrouter_key_encrypted"),
    claudeOauthTokenEncrypted: text("claude_oauth_token_encrypted"),
    claudeTokenIssuedAt: timestamp("claude_token_issued_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Two people may both have a "personal" workspace; one person may not.
    uniqueIndex("workspaces_owner_slug_idx").on(t.ownerUserId, t.slug),
    index("workspaces_owner_idx").on(t.ownerUserId),
  ],
);

/**
 * Who can reach a workspace, and as what. The owner has a row like everyone
 * else, so every access check is one lookup here.
 *
 * `role` is owner | admin | member | viewer (see `WorkspaceRole`). The two
 * `can*` columns override the role's default for one person; null follows it.
 */
export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    canCreateProject: boolean("can_create_project"),
    canCreateSession: boolean("can_create_session"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("workspace_members_pk_idx").on(t.workspaceId, t.userId),
    index("workspace_members_user_idx").on(t.userId),
  ],
);

/**
 * A shareable join link. Only the sha256 of the token is stored, as with
 * `sessions`: the link is shown once, when it is made.
 */
export const workspaceInvites = pgTable(
  "workspace_invites",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    tokenHash: text("token_hash").notNull().unique(),
    /** The role a person joining by this link gets; never `owner`. */
    role: text("role").notNull().default("member"),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    revokedAt: timestamp("revoked_at", { withTimezone: true }),
    uses: integer("uses").notNull().default(0),
    /** Null is unlimited. */
    maxUses: integer("max_uses"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("workspace_invites_workspace_idx").on(t.workspaceId)],
);

export const projects = pgTable(
  "projects",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** Public identifier used in hostnames. See protocol/hostname.ts. */
    hash: text("hash").notNull().unique(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    /**
     * The person who created the project -- the workspace owner, or a member
     * of a shared workspace. Background scans use it as the account to act
     * as. Authorization does NOT read this -- it resolves through
     * `workspace_members`, so the two can never disagree in a way that
     * grants access.
     */
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /**
     * Null for a project started empty rather than cloned. Nullable because
     * "no remote yet" is a real state: the working tree is a git repository
     * from the first commit, and a remote is added when there is somewhere to
     * push it.
     */
    repoUrl: text("repo_url"),
    defaultBranch: text("default_branch").notNull().default("main"),
    /**
     * Detected stack, as `detectStack` in apps/server/src/clone.ts names it:
     * a framework (laravel, nextjs, nuxt, react, django, rails, …), else a
     * language or runtime (node, python, rust, go, php, …), else static, or
     * unknown before the clone. Set at clone and re-checked every few turns.
     */
    stack: text("stack").notNull().default("unknown"),
    containerState: text("container_state").notNull().default("absent"),
    containerError: text("container_error"),
    /**
     * The port the owner's dev server listens on, set from the Preview
     * dialog; null until then. The preview proxy only serves the subdomain
     * whose port matches this, so a stored port is the whole grant.
     */
    previewPort: integer("preview_port"),
    /**
     * Set when the preview is a static site rather than a dev server: the
     * folder in the working tree it is served from, "" for the root. The
     * proxy then serves those files itself on `previewPort`'s subdomain, so
     * the address and the cookie work the same either way.
     */
    previewStaticDir: text("preview_static_dir"),
    /**
     * The read-only public site's address segment, `{name}-{6 chars}`, minted
     * the first time the owner makes the project public and kept from then
     * on: a link that was shared keeps working across a toggle off and on.
     * Whether it answers at all is `publicEnabled`.
     */
    publicSlug: text("public_slug").unique(),
    publicEnabled: boolean("public_enabled").notNull().default(false),
    /**
     * The agent the Tasks board runs with: native | claude | codex, and a
     * model for it. Null falls back to the owning account's defaults.
     */
    taskAgentProvider: text("task_agent_provider"),
    taskAgentModel: text("task_agent_model"),
    /** When the board moves Idea cards to Research by itself. Null is off. */
    taskAutoRun: jsonb("task_auto_run").$type<TaskAutoRun>(),
    lastActiveAt: timestamp("last_active_at", { withTimezone: true }).notNull().defaultNow(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("projects_user_idx").on(t.userId),
    index("projects_workspace_idx").on(t.workspaceId),
    // The idle reaper scans on this; it runs every minute forever.
    index("projects_last_active_idx").on(t.lastActiveAt),
  ],
);

export const threads = pgTable(
  "threads",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Untitled"),
    /** idle | running | cancelling | error */
    status: text("status").notNull().default("idle"),
    /** Set when this thread was forked from another, for provenance. */
    forkedFromThreadId: uuid("forked_from_thread_id"),
    forkedFromTurnSeq: integer("forked_from_turn_seq"),
    /**
     * The backend this thread is bound to, set by its first turn. Null until
     * then. A CLI provider's session cannot be handed to another provider,
     * so a bound thread refuses a `thread.send` naming a different one.
     */
    provider: text("provider"),
    /**
     * The CLI provider's own session id -- what the next turn resumes with.
     * Projected from `agent.session_started`. Null for the native loop, whose
     * conversation is this log.
     */
    providerSessionId: text("provider_session_id"),
    /** Who started the thread; whose own subscription a `member` thread bills. */
    createdByUserId: uuid("created_by_user_id").references(() => users.id, {
      onDelete: "set null",
    }),
    /**
     * `member` or `workspace`: whose credentials this thread's turns run on,
     * fixed when it is created. Null on threads older than the column, which
     * run on the workspace owner's account as they always did.
     */
    credentialSource: text("credential_source"),
    /** The session's address in the web app, `/{ws}/p/{project}/{hash}`. */
    hash: text("hash").notNull().unique(),
    /**
     * A project session runs in its own git worktree on `branch`, forked
     * from `baseBranch` when it was created. Both null: the thread works in
     * the project's main folder, as every thread did before worktrees.
     */
    baseBranch: text("base_branch"),
    branch: text("branch"),
    /** creating | ready | error, while `branch` is set; null otherwise. */
    worktreeState: text("worktree_state"),
    worktreeError: text("worktree_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("threads_project_idx").on(t.projectId),
    // The sidebar's thread list: one project's, newest first.
    index("threads_project_created_idx").on(t.projectId, t.createdAt),
    // `listProjects`' "is anything running" -- an EXISTS that touches only
    // the few running threads rather than every thread of the project.
    index("threads_running_idx")
      .on(t.projectId)
      .where(sql`${t.status} = 'running'`),
  ],
);

export const events = pgTable(
  "events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "cascade" }),
    /**
     * Per-thread monotonic sequence (per-project for project-scoped events,
     * where threadId is null). Clients resume a subscription with `sinceSeq`,
     * so gaps and reordering are both detectable.
     */
    seq: integer("seq").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").$type<DomainEvent>().notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Enforces gapless ordering: a concurrent writer racing on the same seq
    // fails the transaction rather than silently interleaving.
    uniqueIndex("events_thread_seq_idx").on(t.threadId, t.seq),
    index("events_project_idx").on(t.projectId, t.id),
    // `nextSeq` for project-scoped events: max(seq) where thread_id is null.
    // Without it every such append scanned the project's whole log. Unique
    // for the same reason as the thread index; NULL thread ids would make a
    // unique (thread_id, seq) index useless for these rows.
    uniqueIndex("events_project_seq_idx")
      .on(t.projectId, t.seq)
      .where(sql`${t.threadId} is null`),
  ],
);

export const turns = pgTable(
  "turns",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    threadId: uuid("thread_id")
      .notNull()
      .references(() => threads.id, { onDelete: "cascade" }),
    seq: integer("seq").notNull(),
    /** Git refs bracketing this turn. See vcs/checkpoint.ts. */
    checkpointBefore: text("checkpoint_before"),
    checkpointAfter: text("checkpoint_after"),
    usage: jsonb("usage").$type<TokenUsage>(),
    costUsd: real("cost_usd").notNull().default(0),
    /**
     * The model this turn was billed against, as the provider names it.
     *
     * Recorded per turn rather than per thread because the picker can be
     * changed between messages -- a thread is not one model's worth of
     * spend. Null on turns written before the column existed, which the
     * usage breakdown reports as "Unknown" rather than folding into
     * whichever model happens to be first.
     */
    model: text("model"),
    stopReason: text("stop_reason"),
    error: text("error"),
    revertedAt: timestamp("reverted_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("turns_thread_seq_idx").on(t.threadId, t.seq)],
);

/**
 * Each project's running totals, for the sidebar and the project tables:
 * what `listProjects` would otherwise sum over every turn the project ever
 * had, on every bootstrap.
 *
 * A projection like the others (`applyProjection` in the server's
 * engine.ts), kept with relative updates -- `+ 1`, `+ cost` -- because the
 * engine and the agent reactor append at the same time. A table of its own
 * rather than columns on `projects`, which every command reads and every
 * container change writes: the counters' churn stays off that row. Deleting
 * a thread recomputes its project's row (`recomputeProjectStats`).
 */
export const projectStats = pgTable("project_stats", {
  projectId: uuid("project_id")
    .primaryKey()
    .references(() => projects.id, { onDelete: "cascade" }),
  threadCount: integer("thread_count").notNull().default(0),
  /** Every token the project's turns were billed for: input, output and both cache kinds. */
  tokens: doublePrecision("tokens").notNull().default(0),
  costUsd: doublePrecision("cost_usd").notNull().default(0),
  /** The project's latest turn, so its end can say whether it failed. */
  lastTurnId: uuid("last_turn_id"),
  /** The latest turn failed or stopped short: the sidebar's red dot. */
  lastTurnFailed: boolean("last_turn_failed").notNull().default(false),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});

/**
 * A named agent configuration scoped to one project -- a reviewer, a
 * migration writer, a test author. Each carries its own instructions and tool
 * preset, so a project can delegate different work to differently-shaped
 * agents.
 *
 * The rows exist now so the hierarchy is real; the loop that runs them lands
 * with the agent core.
 */
export const subagents = pgTable(
  "subagents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    /** Defaults to the harness model when null. */
    model: text("model"),
    /** Tool registry preset: standard | minimal | readonly. */
    toolPreset: text("tool_preset").notNull().default("standard"),
    systemPrompt: text("system_prompt"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex("subagents_project_name_idx").on(t.projectId, t.name),
    index("subagents_project_idx").on(t.projectId),
  ],
);

export const previews = pgTable(
  "previews",
  {
    hash: text("hash").primaryKey(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    commitSha: text("commit_sha").notNull(),
    port: integer("port").notNull(),
    containerState: text("container_state").notNull().default("absent"),
    buildLog: text("build_log"),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("previews_project_idx").on(t.projectId),
    index("previews_expires_idx").on(t.expiresAt),
  ],
);

export const secrets = pgTable(
  "secrets",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    key: text("key").notNull(),
    /** AES-256-GCM. Decrypted only when injected into a container command. */
    valueEncrypted: text("value_encrypted").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex("secrets_project_key_idx").on(t.projectId, t.key)],
);

/**
 * A MySQL or PostgreSQL server the workspace can browse.
 *
 * The password is the only secret and is stored the way project secrets are:
 * AES-256-GCM under `SECRET_KEY`, decrypted only for the moment a query
 * runs against the server and never sent back to a client.
 */
export const databaseConnections = pgTable(
  "database_connections",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    workspaceId: uuid("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    /** `mysql` or `postgresql`; the route validates, the column does not. */
    engine: text("engine").notNull(),
    host: text("host").notNull(),
    port: integer("port").notNull(),
    username: text("username").notNull(),
    passwordEncrypted: text("password_encrypted").notNull(),
    /** The database the connection opens by default; null lets the server pick. */
    database: text("database"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("database_connections_workspace_idx").on(t.workspaceId)],
);

/**
 * A project's notes: a tree of pages, Notion-style.
 *
 * Plain state rather than a projection of `events`: a note is edited in place
 * by autosave many times a minute, and nothing replays it. Exactly one row per
 * project has a null `parent_id` -- the root page -- which the partial unique
 * index enforces so "create the root if missing" is a conflict-free insert.
 */
export const notes = pgTable(
  "notes",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    /** Null exactly once per project: the root page. Children go with their parent. */
    parentId: uuid("parent_id").references((): AnyPgColumn => notes.id, { onDelete: "cascade" }),
    title: text("title").notNull().default("Untitled"),
    /** An emoji, or null for the default page icon. */
    icon: text("icon"),
    /** The banner image above the title: an upload's content URL, or null. */
    cover: text("cover"),
    /** ProseMirror JSON. The editor's schema is canonical; nothing else parses it. */
    content: jsonb("content")
      .$type<NoteDoc>()
      .notNull()
      .default(sql`'{"type":"doc","content":[]}'::jsonb`),
    /** The body as the words a reader sees, kept beside it so search never parses JSON. */
    searchText: text("search_text").notNull().default(""),
    /** Order among siblings. */
    position: integer("position").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("notes_project_parent_idx").on(t.projectId, t.parentId, t.position),
    uniqueIndex("notes_project_root_idx")
      .on(t.projectId)
      .where(sql`${t.parentId} is null`),
  ],
);

/**
 * The tasks on a project's timeline page, drawn there as a Gantt chart.
 *
 * Plain rows like `notes`: a task is dragged along the chart and saved on
 * every release, and nothing replays it. Dates are calendar dates rather than
 * instants -- a task runs "from the 3rd to the 9th" wherever the reader is --
 * so they are `date` columns and travel as `YYYY-MM-DD` strings. `ends_on`
 * is inclusive: a one-day task starts and ends on the same day.
 */
export const timelineTasks = pgTable(
  "timeline_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    startsOn: date("starts_on").notNull(),
    endsOn: date("ends_on").notNull(),
    /** 0..100, the filled part of the bar. */
    progress: integer("progress").notNull().default(0),
    /** One of the note colour names, so the bar reads from the same palette as the notes. */
    colour: text("colour").notNull().default("blue"),
    /** Order among the project's tasks, top to bottom. */
    position: integer("position").notNull().default(0),
    /** The task an arrow is drawn from; cleared rather than cascaded when that task goes. */
    dependsOnId: uuid("depends_on_id").references((): AnyPgColumn => timelineTasks.id, {
      onDelete: "set null",
    }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("timeline_tasks_project_idx").on(t.projectId, t.position)],
);

/**
 * The cards on a project's Tasks board.
 *
 * Plain rows like `timeline_tasks`. A person writes the idea; the pipeline
 * fills in the rest as it carries the card along -- the research brief, the
 * thread the agent worked in, the verifier's verdict -- so the card is the
 * whole record of what was done for it.
 */
export const projectTasks = pgTable(
  "project_tasks",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    description: text("description").notNull().default(""),
    references: jsonb("references").$type<TaskReference[]>().notNull().default([]),
    /** idea | research | ongoing | verification | done */
    stage: text("stage").notNull().default("idea"),
    /** idle | running | needs_input | failed */
    status: text("status").notNull().default("idle"),
    /** Order within the column, top to bottom. */
    position: real("position").notNull().default(0),
    research: text("research"),
    verification: jsonb("verification").$type<TaskVerification>(),
    feedback: jsonb("feedback").$type<TaskFeedback[]>().notNull().default([]),
    /** The chat thread the coding agent worked in; kept if the thread goes. */
    threadId: uuid("thread_id").references(() => threads.id, { onDelete: "set null" }),
    attempts: integer("attempts").notNull().default(0),
    lastError: text("last_error"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("project_tasks_project_idx").on(t.projectId, t.stage, t.position)],
);

/**
 * A project's saved keys: API keys, tokens and passwords that a provider
 * shows once and cannot show again, kept here so they can be handed back.
 *
 * Unlike `secrets` these are for the person, not the runtime: nothing is
 * injected anywhere. The value is AES-256-GCM under `SECRET_KEY`, left out
 * of every list, and decrypted only when someone asks to see or copy it.
 */
export const projectKeys = pgTable(
  "project_keys",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    projectId: uuid("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    valueEncrypted: text("value_encrypted").notNull(),
    tags: text("tags").array().notNull().default(sql`'{}'::text[]`),
    /** Where the key was issued or is used, e.g. the provider's dashboard. */
    url: text("url"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("project_keys_project_idx").on(t.projectId, t.createdAt)],
);

/** Server-side sessions for the web UI; WebSocket tickets are derived from these. */
export const sessions = pgTable(
  "sessions",
  {
    id: text("id").primaryKey(),
    userId: uuid("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    scopes: jsonb("scopes").$type<string[]>().notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("sessions_user_idx").on(t.userId),
    // The expired-session sweep.
    index("sessions_expires_idx").on(t.expiresAt),
  ],
);

export const workspacesRelations = relations(workspaces, ({ many, one }) => ({
  projects: many(projects),
  databaseConnections: many(databaseConnections),
  owner: one(users, { fields: [workspaces.ownerUserId], references: [users.id] }),
}));

export const databaseConnectionsRelations = relations(databaseConnections, ({ one }) => ({
  workspace: one(workspaces, {
    fields: [databaseConnections.workspaceId],
    references: [workspaces.id],
  }),
}));

export const projectsRelations = relations(projects, ({ many, one }) => ({
  threads: many(threads),
  previews: many(previews),
  subagents: many(subagents),
  notes: many(notes),
  workspace: one(workspaces, { fields: [projects.workspaceId], references: [workspaces.id] }),
  owner: one(users, { fields: [projects.userId], references: [users.id] }),
}));

export const subagentsRelations = relations(subagents, ({ one }) => ({
  project: one(projects, { fields: [subagents.projectId], references: [projects.id] }),
}));

export const threadsRelations = relations(threads, ({ many, one }) => ({
  project: one(projects, { fields: [threads.projectId], references: [projects.id] }),
  turns: many(turns),
}));

export type Workspace = typeof workspaces.$inferSelect;
export type WorkspaceMember = typeof workspaceMembers.$inferSelect;
export type WorkspaceInvite = typeof workspaceInvites.$inferSelect;
export type Project = typeof projects.$inferSelect;
export type Subagent = typeof subagents.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Turn = typeof turns.$inferSelect;
export type Note = typeof notes.$inferSelect;
export type TimelineTask = typeof timelineTasks.$inferSelect;
export type ProjectTaskRow = typeof projectTasks.$inferSelect;
export type ProjectKey = typeof projectKeys.$inferSelect;
export type Preview = typeof previews.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
export type DatabaseConnection = typeof databaseConnections.$inferSelect;

/**
 * What people changed in a project, newest first on its Activity page.
 *
 * Not the event log: `events` is what the agent and the runtime did, in the
 * order that rebuilds the projections, and notes or keys are deliberately not
 * in it. This is the human-readable history of who changed what -- every
 * edit, kept whether or not it is replayable -- and nothing is rebuilt from
 * it.
 *
 * Repeated saves of one thing by one person coalesce into one row while they
 * keep coming (`count` goes up, `updated_at` moves), so typing a paragraph is
 * one line rather than forty.
 */
export const auditLog = pgTable(
  "audit_log",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    /** Null for a change to the account rather than to one project. */
    projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
    /** Null when the actor's account has since been deleted. */
    userId: uuid("user_id").references(() => users.id, { onDelete: "set null" }),
    /** The browser tab it came from, to tell one person's windows apart. */
    clientId: text("client_id"),
    /** `note.update`, `file.write`, `chat.send`, ... */
    action: text("action").notNull(),
    targetType: text("target_type").notNull(),
    targetId: text("target_id"),
    summary: text("summary").notNull(),
    details: jsonb("details").$type<Record<string, unknown>>().notNull().default({}),
    count: integer("count").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index("audit_log_project_idx").on(t.projectId, t.updatedAt),
    index("audit_log_user_idx").on(t.userId, t.updatedAt),
    // The activity feeds page by id, newest first.
    index("audit_log_project_id_idx").on(t.projectId, t.id),
    index("audit_log_user_id_idx").on(t.userId, t.id),
  ],
);
