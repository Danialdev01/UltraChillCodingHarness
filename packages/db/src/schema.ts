import { relations, sql } from "drizzle-orm";
import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  real,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import type { DomainEvent, TokenUsage } from "@ucch/protocol";

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
 * Ownership is a single `ownerUserId` for now. Multi-member workspaces need a
 * `workspace_members` join table, which is additive: nothing here has to
 * change to support it, and authorization already resolves through the
 * workspace rather than through the project.
 */
export const workspaces = pgTable(
  "workspaces",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    /** URL-safe identifier, unique per owner rather than globally. */
    slug: text("slug").notNull(),
    name: text("name").notNull(),
    ownerUserId: uuid("owner_user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    // Two people may both have a "personal" workspace; one person may not.
    uniqueIndex("workspaces_owner_slug_idx").on(t.ownerUserId, t.slug),
    index("workspaces_owner_idx").on(t.ownerUserId),
  ],
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
     * Denormalised from the owning workspace so the idle reaper and other
     * background scans can filter by user without a join. Authorization does
     * NOT read this -- it resolves through the workspace, so the two can
     * never disagree in a way that grants access.
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
    /** Detected stack: laravel | nextjs | vite | php | static | node | unknown. */
    stack: text("stack").notNull().default("unknown"),
    containerState: text("container_state").notNull().default("absent"),
    containerError: text("container_error"),
    /**
     * The port the owner's dev server listens on, set from the Preview
     * dialog; null until then. The preview proxy only serves the subdomain
     * whose port matches this, so a stored port is the whole grant.
     */
    previewPort: integer("preview_port"),
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
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index("threads_project_idx").on(t.projectId)],
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
    index("events_type_idx").on(t.type),
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
  (t) => [index("sessions_user_idx").on(t.userId)],
);

export const workspacesRelations = relations(workspaces, ({ many, one }) => ({
  projects: many(projects),
  owner: one(users, { fields: [workspaces.ownerUserId], references: [users.id] }),
}));

export const projectsRelations = relations(projects, ({ many, one }) => ({
  threads: many(threads),
  previews: many(previews),
  subagents: many(subagents),
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
export type Project = typeof projects.$inferSelect;
export type Subagent = typeof subagents.$inferSelect;
export type Thread = typeof threads.$inferSelect;
export type Turn = typeof turns.$inferSelect;
export type Preview = typeof previews.$inferSelect;
export type User = typeof users.$inferSelect;
export type Session = typeof sessions.$inferSelect;
export type EventRow = typeof events.$inferSelect;
