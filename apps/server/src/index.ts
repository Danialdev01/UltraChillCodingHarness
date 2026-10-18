import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import compress from "@fastify/compress";
import cookie from "@fastify/cookie";
import rateLimit from "@fastify/rate-limit";
import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import { z } from "zod";
import { and, desc, eq, inArray, lt, notLike, sql } from "drizzle-orm";
import { createDatabase, projects, runMigrations, threads, turns, users, workspaces } from "@ucch/db";
import {
  AgentPermissionMode,
  can,
  DEFAULT_AGENT_PERMISSION_MODE,
  MAX_AVATAR_BYTES,
  mediaTypeFor,
  projectUrl,
  ProviderId,
  ThreadHash,
  WorkspaceHash,
  type ChangeOrigin,
  type Command,
  type DomainEvent,
} from "@ucch/protocol";
import { HostProcessHost, createProviders } from "@ucch/providers";
import { AgentTurnReactor } from "./agent.js";
import { documentsBackends } from "./documents.js";
import { researchBackends } from "./research.js";
import { DIAGRAM_FILES, diagramAsk, extractMermaid, isDiagramKind, type DiagramKind } from "./diagrams.js";
import { CloneReactor, ensureWorkspaceRoot, listRemoteBranches } from "./clone.js";
import { WorktreeReactor } from "./worktrees.js";
import { sessionTreesOf, treeFor, type TreeTarget } from "./trees.js";
import {
  ConflictError,
  PathError,
  StaleWriteError,
  WorkspaceFiles,
  contentVersion,
  isSecretPath,
} from "./files.js";
import { ProjectAccess } from "./access.js";
import { AuditLog, textDelta, type AuditInput } from "./audit.js";
import { ComposerStore } from "./composer.js";
import { PresenceStore } from "./presence.js";
import { describeRoute } from "./route-audit.js";
import { MAX_QUERY_LENGTH, SearchError, searchWorkspace } from "./search.js";
import {
  UPLOAD_TEXT_PREVIEW_BYTES,
  UploadConflictError,
  UploadStore,
  UnknownUploadError,
  contentDisposition,
} from "./uploads.js";
import { TerminalReactor } from "./terminals.js";
import { AuthService, DEV_USER_ID } from "./auth.js";
import { EventBus } from "./bus.js";
import { cliProvidersEnabled, loadConfig, shellPluginEnabled, webOrigin } from "./config.js";
import { BASELINE_HEADERS, originAllowed } from "./http-guards.js";
import { admitGithubUser } from "./github-admission.js";
import { ProviderService, workspaceSubject } from "./providers.js";
import { OrchestrationEngine, applyProjection, type Reactors } from "./engine.js";
import { EventStore } from "./eventstore.js";
import { WebSocketGateway } from "./ws.js";
import { PreviewGateway } from "./preview.js";
import { WorkspaceService, type ProjectSummary } from "./workspaces.js";
import { StorageService } from "./storage.js";
import { NotesService } from "./notes.js";
import { registerNoteRoutes } from "./notes-routes.js";
import { registerTimelineRoutes } from "./timeline-routes.js";
import { registerKeyRoutes } from "./keys-routes.js";
import { ProjectKeyService } from "./keys.js";
import { TimelineService } from "./timeline.js";
import { TasksService } from "./tasks.js";
import { registerTaskRoutes } from "./tasks-routes.js";
import { TaskPipeline } from "./task-pipeline.js";
import { TaskScheduler } from "./task-scheduler.js";
import { registerDatabaseRoutes } from "./database-routes.js";
import { WorkspaceMemberService } from "./workspace-members.js";
import { registerWorkspaceMemberRoutes } from "./workspace-members-routes.js";
import { registerDbManagerRoutes } from "./db-manager-routes.js";
import { adapterFor } from "./db-manager/index.js";
import { DatabaseConnectionService } from "./database-connections.js";
import { devServersFromConfig, ensureProjectInfo, renderDefaultInfo } from "./dev-database.js";
import { probe } from "./database-probe.js";
import { GitService } from "./git.js";
import { registerGitRoutes } from "./git-routes.js";
import { registerPublicRoutes } from "./public-routes.js";
import { decryptSecret, encryptSecret } from "./crypto.js";
import {
  GithubError,
  identify,
  listBranches,
  listRepos,
  tokenAppliesTo,
} from "./github.js";
import {
  SessionBusyError,
  SessionLifecycle,
  SessionUnsavedError,
  type SessionRecord,
} from "./session-lifecycle.js";
import { cachedCatalogue, catalogue, keyQuota, type KeyQuota } from "./openrouter.js";
import {
  fetchClaudeUsage,
  fetchCodexUsage,
  openRouterWindows,
  readClaudeAccessToken,
  readCodexTokens,
  type SessionQuota,
  type SessionQuotas,
} from "./quotas.js";

const config = loadConfig();

// Before anything else touches the database. Idempotent, so it runs on every
// boot and a fresh deployment needs no separate migration step.
await runMigrations(config.DATABASE_URL);

const db = createDatabase(config.DATABASE_URL);

// A turn lives in this process, so nothing that was running before the
// restart is running now. Left alone, those threads would sit in `running`
// for ever and the one-turn-at-a-time guard -- which starts working with
// `turn.started` -- would refuse every new message on them. `idle` rather
// than `error`: the crash is the harness's, not the conversation's.
const recovered = await db
  .update(threads)
  .set({ status: "idle" })
  .where(inArray(threads.status, ["running", "cancelling"]))
  .returning({ id: threads.id });

// Before any reactor can want it: a missing or read-only workspace root
// makes every clone and every file tool fail, and that is worth learning at
// boot rather than from a project that mysteriously has no files.
await ensureWorkspaceRoot(config.WORKSPACE_ROOT);
// Where each account's CLI logins live. Private to the server user: nothing
// the web service or a project process can read.
await mkdir(config.CREDS_ROOT, { recursive: true, mode: 0o700 });

const bus = new EventBus();
const store = new EventStore(db, bus);
const auth = new AuthService(db, config);
const workspaceService = new WorkspaceService(db);
const access = new ProjectAccess(db);
const composer = new ComposerStore();
const presence = new PresenceStore();

/**
 * The activity log. A project's lines go to the project's topic, so its
 * Activity page grows as things happen; an account's go to the account's.
 */
const audit = new AuditLog(
  db,
  (projectId, userId, event) => {
    if (projectId) bus.publish({ seq: null, projectId, threadId: null, event });
    else if (userId) bus.publishToUser(userId, event);
  },
  (error) => app.log.error({ err: error }, "could not write to the activity log"),
);
const workspaceFiles = new WorkspaceFiles(config.WORKSPACE_ROOT);
const storageService = new StorageService(db, workspaceService, config.WORKSPACE_ROOT);

/**
 * Attachment staging: `WORKSPACE_ROOT/.uploads`, beside the project
 * directories rather than inside any of them, so nothing the agent or the
 * file panel can reach sees a file until it is placed deliberately.
 */
const uploads = new UploadStore(config.WORKSPACE_ROOT, workspaceFiles, {
  maxBytes: config.UPLOAD_MAX_BYTES,
  ttlMs: config.UPLOAD_TTL_HOURS * 3600_000,
});

/**
 * The vendor CLIs as providers. They run on the host until the container
 * runtime lands -- `HostProcessHost` is the seam a `docker exec` host later
 * replaces -- and are gated exactly like the host shell they amount to.
 */
const providerService = new ProviderService(
  db,
  config,
  new HostProcessHost(),
  createProviders({
    claudeBin: config.CLAUDE_BIN,
    codexBin: config.CODEX_BIN,
    isRepo: (cwd) => existsSync(join(cwd, ".git")),
  }),
);

/**
 * The container, checkpoint and preview reactors still arrive in later
 * phases; the agent one is here, so a user message is answered.
 */
const agentTurns = new AgentTurnReactor(
  db,
  store,
  {
    secretKey: config.SECRET_KEY,
    defaultModel: config.DEFAULT_MODEL,
    searchModel: config.SEARCH_MODEL,
    workspaceRoot: config.WORKSPACE_ROOT,
    maxIterations: config.AGENT_MAX_ITERATIONS,
    uploads,
    research: researchBackends(config),
    documents: documentsBackends(config),
    // Decided once, at boot: in production the shell plugin loads only when
    // it has been asked for explicitly.
    registry: { allowHostShell: shellPluginEnabled(config) },
    providers: providerService,
    cliEnabled: cliProvidersEnabled(config),
    maxConcurrentPerUser: config.AGENT_MAX_CONCURRENT_PER_USER,
  },
  (error) => app.log.error({ err: error }, "agent turn failed"),
);

/**
 * What a project's owner brings to git: who to commit as, and what to
 * authenticate with.
 *
 * Resolved per operation rather than held: a private repository needs the
 * account's token for the one clone or push that is about to run, and a
 * commit needs a name to be made under. The token comes back ungated; the
 * caller checks it belongs to the host being contacted (`tokenAppliesTo`).
 */
async function ownerCredentials(
  projectId: string,
): Promise<{ token: string | null; author: { name: string; email: string } }> {
  const [owner] = await db
    .select({
      login: users.login,
      name: users.name,
      email: users.email,
      github: users.githubTokenEncrypted,
      oauth: users.accessTokenEncrypted,
    })
    .from(projects)
    .innerJoin(users, eq(users.id, projects.userId))
    .where(eq(projects.id, projectId))
    .limit(1);
  if (!owner) return { token: null, author: { name: "UltraChillCodingHarness", email: "harness@localhost" } };

  return {
    token: decryptOrNull(owner.github) ?? decryptOrNull(owner.oauth),
    author: {
      name: owner.name || owner.login,
      // A commit needs an address and an account may have none. The
      // `users.noreply.github.com` form is GitHub's own answer to that,
      // and it attributes the commit to the right person once pushed.
      email: owner.email || `${owner.login}@users.noreply.github.com`,
    },
  };
}

/**
 * Puts the repository on disk when a project is created, so the file tools
 * have something real to read. Its events carry no thread, so they are
 * appended against the project alone.
 */
const databaseConnections = new DatabaseConnectionService(db);

const clones = new CloneReactor(
  async (event) => {
    await store.append({ projectId: event.projectId, threadId: null }, [event], (tx) =>
      applyProjection(tx, [event], null),
    );
  },
  {
    workspaceRoot: config.WORKSPACE_ROOT,
    // Resolved through the project's owner, and only for the clone that is
    // about to run: a private repository needs the account's token, and an
    // empty one needs a name to make its first commit under.
    credentials: (event) => ownerCredentials(event.projectId),
    devDatabases: devServersFromConfig(config),
    // The new database shows up in the Database view with nothing to type.
    // Named after the project, and skipped when the name is already saved, so
    // a redelivered event does not list it twice.
    registerConnection: async (event, server, name) => {
      if (!config.SECRET_KEY) throw new Error("SECRET_KEY is not configured, so no password can be stored");
      const label = `${event.name} (dev)`.slice(0, 80);
      const existing = await databaseConnections.list(event.workspaceId);
      if (existing.some((c) => c.name === label)) return;
      await databaseConnections.create(
        event.workspaceId,
        {
          name: label,
          engine: server.engine,
          host: server.host,
          port: server.port,
          username: server.username,
          password: server.password,
          database: name,
        },
        config.SECRET_KEY,
      );
    },
  },
  (error, event) => app.log.error({ err: error, projectId: event.projectId }, "clone failed"),
);

/**
 * A git worktree for each project session, so sessions on the same project
 * run side by side on branches of their own.
 */
const worktrees = new WorktreeReactor(
  async (event, projectId) => {
    await store.append({ projectId, threadId: event.threadId }, [event], (tx) =>
      applyProjection(tx, [event], null),
    );
  },
  { workspaceRoot: config.WORKSPACE_ROOT },
  (error, event) => app.log.error({ err: error, threadId: event.threadId }, "worktree failed"),
);

/**
 * A shell per terminal tab, in the project's workspace.
 *
 * Held to the same gate as the agent's `bash` tool -- this is the same host
 * shell reached by a different route, and one of them being opt-in in
 * production while the other was not would be a distinction without a
 * difference.
 */
const terminals = new TerminalReactor(
  {
    workspaceRoot: config.WORKSPACE_ROOT,
    allowHostShell: shellPluginEnabled(config),
    // A sign-in terminal: the CLI's own login flow, in the user's credential
    // directory, so what it writes is what every later turn reads.
    login: (userId, program) => {
      const env = providerService.loginEnv(userId, program);
      // The login lands in the credential directory; probes are cached, so
      // forget this user's until the next look.
      providerService.invalidate(userId);
      sessionQuotaCache.delete(userId);
      return program === "claude-login"
        ? { argv: [config.CLAUDE_BIN, "auth", "login"], cwd: env.CLAUDE_CONFIG_DIR!, env }
        : { argv: [config.CODEX_BIN, "login", "--device-auth"], cwd: env.CODEX_HOME!, env };
    },
  },
  (projectId, event) => {
    // `terminal.output` is transient: this publishes to whoever is watching
    // the tab and writes nothing to the log.
    void store.append({ projectId, threadId: null }, [event]).catch((error) => {
      app.log.error({ err: error }, "could not publish terminal output");
    });
  },
  (error) => app.log.error({ err: error }, "terminal failed"),
);

const reactors: Reactors = {
  react(command: Command, events, principal) {
    agentTurns.react(command, events);
    clones.react(command, events);
    worktrees.react(command, events);
    terminals.react(command, principal.userId);
  },
};

const engine = new OrchestrationEngine(db, store, reactors, (error, command) => {
  app.log.error({ err: error, command: command.type }, "command failed");
});
const gateway = new WebSocketGateway(auth, engine, store, bus, {
  access,
  composer,
  presence,
  mayWatchTerminal: (userId, terminalId) => terminals.mayWatch(terminalId, userId),
  onDispatched: (principal, clientId, command, result) => {
    if (!result.ok) return;
    void auditCommand(principal.userId, clientId, command, result.events).catch((error) =>
      app.log.error({ err: error }, "could not log a command"),
    );
  },
});

/**
 * The activity line for a command sent over the socket: the chat, the
 * terminal, the project's lifecycle. Keystrokes into a terminal are not
 * lines of their own -- opening one is.
 */
async function auditCommand(
  userId: string,
  clientId: string,
  command: Command,
  events: readonly { projectId: string; event: DomainEvent }[],
): Promise<void> {
  const projectId =
    ("projectId" in command ? command.projectId : null) ??
    ("threadId" in command && command.threadId ? await access.projectOfThread(command.threadId) : null) ??
    events[0]?.projectId ??
    null;
  const base = { projectId, userId, clientId };
  const thread = (action: string, summary: string, details?: Record<string, unknown>): AuditInput => ({
    ...base,
    action,
    targetType: "thread",
    targetId: "threadId" in command ? command.threadId : null,
    summary,
    ...(details ? { details } : {}),
  });

  let entry: AuditInput | null = null;
  switch (command.type) {
    case "thread.send": {
      const line = command.text.trim().split("\n")[0] ?? "";
      entry = thread("chat.send", `Asked: “${line.length > 120 ? `${line.slice(0, 117)}…` : line}”`, {
        chars: command.text.length,
        ...(command.model ? { model: command.model } : {}),
        ...(command.provider ? { provider: command.provider } : {}),
        ...(command.mode ? { mode: command.mode } : {}),
      });
      break;
    }
    case "thread.create": {
      const created = events.find((e) => e.event.type === "thread.created")?.event;
      entry = thread("chat.new", "Started a new conversation");
      entry.targetId = created && "threadId" in created ? created.threadId : null;
      break;
    }
    case "thread.cancel":
      entry = thread("chat.cancel", "Stopped the agent");
      break;
    case "thread.permission_reply":
      entry = thread(
        "chat.permission",
        command.behavior === "allow" ? "Allowed a tool request" : "Denied a tool request",
        { requestId: command.requestId },
      );
      break;
    case "thread.revert":
      entry = thread("chat.revert", "Reverted the conversation to an earlier turn", { turnId: command.turnId });
      break;
    case "thread.fork":
      entry = thread("chat.fork", "Forked the conversation");
      break;
    case "terminal.create":
      entry = { ...base, action: "terminal.open", targetType: "terminal", targetId: command.terminalId, summary: "Opened a terminal" };
      break;
    case "terminal.close":
      entry = { ...base, action: "terminal.close", targetType: "terminal", targetId: command.terminalId, summary: "Closed a terminal" };
      break;
    case "project.create":
      entry = { ...base, action: "project.create", targetType: "project", targetId: projectId, summary: "Created the project" };
      break;
    case "project.start":
      entry = { ...base, action: "project.start", targetType: "project", targetId: projectId, summary: "Started the project" };
      break;
    case "project.stop":
      entry = { ...base, action: "project.stop", targetType: "project", targetId: projectId, summary: "Stopped the project" };
      break;
    case "file.write":
      entry = { ...base, action: "file.write", targetType: "file", targetId: command.path, summary: `Saved ${command.path}`, coalesce: true };
      break;
    case "git.commit":
      entry = { ...base, action: "git.commit", targetType: "git", summary: "Committed changes" };
      break;
    case "git.push":
      entry = { ...base, action: "git.push", targetType: "git", summary: "Pushed" };
      break;
    case "preview.publish":
      entry = { ...base, action: "preview.publish", targetType: "preview", summary: "Published a preview" };
      break;
    case "preview.delete":
      entry = { ...base, action: "preview.delete", targetType: "preview", summary: "Deleted a preview" };
      break;
    // Deleting the project deletes its log; input and resizes are not changes.
    case "project.delete":
    case "terminal.input":
    case "terminal.resize":
      break;
  }
  if (entry) await audit.record(entry);
}

/**
 * Live previews are served from in front of the router (see preview.ts):
 * the server factory hands a project-host request to the gateway and only
 * the rest to Fastify. The dev server is a host process today, so the target
 * is loopback; the container runtime swaps in the project's container here.
 */
const preview = new PreviewGateway({
  rootDomain: config.ROOT_DOMAIN,
  scheme: config.PUBLIC_SCHEME,
  webOrigin: webOrigin(config),
  secret: config.SECRET_KEY,
  resolve: (hash) => workspaceService.previewTarget(hash),
  target: (_project, port) => ({ hosts: ["127.0.0.1", "::1"], port }),
  // Through the same path rules as the editor, so a static site reaches no
  // file the owner could not open -- and not the ones a share must not show.
  readStatic: async (project, path) => {
    if (isSecretPath(path)) return { kind: "missing" };
    try {
      const file = await workspaceFiles.readBytes(project.id, path);
      return file.kind === "too_large" ? { kind: "missing" } : file;
    } catch (error) {
      if (error instanceof PathError) return { kind: "missing" };
      throw error;
    }
  },
  devBypass: config.DEV_AUTH_BYPASS,
  log: { error: (obj, msg) => app.log.error(obj, msg) },
});

const app = Fastify({
  logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
  trustProxy: true,
  serverFactory: (handler) =>
    createServer((req, res) => {
      if (!preview.handleRequest(req, res)) handler(req, res);
    }),
});

await app.register(cookie);

// Behind Traefik the API's JSON -- file trees, diffs, thread history -- went
// out uncompressed. Below a kilobyte the headers cost more than they save.
await app.register(compress, { threshold: 1024 });

// Every public page and the login form are reachable without a session, so
// both are throttled per address: one guesses passwords, the other guesses
// share slugs. Opt-in per route, so nothing signed-in is ever slowed down.
app.addHook("onRoute", (route) => {
  if (route.url.startsWith("/api/public/")) {
    route.config = { ...(route.config as object), rateLimit: { max: 120, timeWindow: "1 minute" } };
  }
});
await app.register(rateLimit, { global: false });

const allowedOrigins = new Set([webOrigin(config), `${config.PUBLIC_SCHEME}://${config.ROOT_DOMAIN}`]);

app.addHook("onRequest", async (request, reply) => {
  if (!originAllowed(request.method, request.headers.origin, allowedOrigins, config.NODE_ENV !== "production")) {
    return reply.code(403).send({ error: "cross-origin request refused" });
  }
});

/**
 * A viewer may read a project but change nothing in it. Every write under
 * `/api/projects/:hash` -- files, notes, keys, tasks, git, preview -- passes
 * here, so a route added later is covered without remembering to ask. A
 * non-member is left to the route itself, which answers 404 as before.
 */
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);
app.addHook("preHandler", async (request, reply) => {
  if (READ_METHODS.has(request.method)) return;
  if (!request.routeOptions.url?.startsWith("/api/projects/:hash")) return;
  const hash = (request.params as { hash?: string }).hash;
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal || !hash) return;
  const project = await workspaceService.findByHash(hash, principal.userId);
  if (project && !can(project.membership, "project.write")) {
    return reply.code(403).send({ error: "your role in this workspace is read-only" });
  }
});

app.addHook("onSend", async (_request, reply) => {
  for (const [name, value] of Object.entries(BASELINE_HEADERS)) {
    if (!reply.hasHeader(name)) reply.header(name, value);
  }
});

// Fastify's default answer to a thrown error includes its message, which for
// a 500 is whatever a driver or the filesystem said -- a path, a host, a SQL
// fragment. Those belong in the log; the caller gets the status.
app.setErrorHandler((error: Error & { statusCode?: number }, request, reply) => {
  const status = error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;
  if (status >= 500) {
    request.log.error({ err: error }, "request failed");
    return reply.code(status).send({ error: "internal server error" });
  }
  return reply.code(status).send({ error: error.message });
});

const SESSION_COOKIE = "ucch_session";
const OAUTH_STATE_COOKIE = "ucch_oauth_state";
const secureCookies = config.PUBLIC_SCHEME === "https";

if (recovered.length > 0) {
  app.log.warn({ threads: recovered.length }, "reset threads left running by a previous process");
}

// Started here rather than beside the store, because it logs through `app`.
uploads.startSweeper(15 * 60_000, (error) =>
  app.log.error({ err: error }, "could not sweep staged uploads"),
);

// Expired sessions were only removed when someone presented one; a session
// nobody uses again would otherwise sit in the table forever.
setInterval(() => {
  auth.sweepExpiredSessions().catch((error) =>
    app.log.error({ err: error }, "could not sweep expired sessions"),
  );
}, 60 * 60_000).unref();

/**
 * Raw bytes for an upload.
 *
 * The composer posts the file as `application/octet-stream` with its name and
 * real type in the query string, rather than as multipart. One fewer
 * dependency and one fewer parser: multipart exists to carry several fields
 * in one body, and this body is one file.
 */
app.addContentTypeParser(
  "application/octet-stream",
  { parseAs: "buffer", bodyLimit: config.UPLOAD_MAX_BYTES },
  (_request, body, done) => done(null, body),
);

app.get("/health", async () => ({
  status: "ok",
  version: "0.1.0",
  connections: gateway.connectionCount,
}));

app.get("/api/me", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const profile = await auth.getProfile(principal.userId);
  return {
    userId: principal.userId,
    scopes: principal.scopes,
    login: profile?.login ?? null,
    name: profile?.name ?? null,
    email: profile?.email ?? null,
    avatarUrl: profile?.avatarUrl ?? null,
    // Whether the account signs in with a password, which decides both
    // whether the settings form asks for the current one and whether it
    // offers "change" or "set".
    hasPassword: await auth.hasPassword(principal.userId),
  };
});

// -- Account -----------------------------------------------------------------

/**
 * The signed-in account's own details.
 *
 * Every route here resolves the session and edits only that user's row: the
 * id is never taken from the request, so there is no id to tamper with.
 * Changing the email or the password additionally requires the current
 * password when the account has one -- a session alone is not proof enough
 * to hand over the credentials that outlive it.
 */
/**
 * The display name. Bounded to something a sidebar row can hold; an empty
 * value is accepted and clears it, falling the display back to the login.
 */
const NameUpdate = z.object({ name: z.string().max(80) });

app.put("/api/account/name", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = NameUpdate.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "that name is too long" });

  const result = await auth.updateName(principal.userId, parsed.data.name);
  if ("error" in result) return reply.code(404).send({ error: "account not found" });
  return result;
});

const EmailUpdate = z.object({
  email: z.string().email().max(320),
  currentPassword: z.string().max(1024).optional(),
});

app.put("/api/account/email", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = EmailUpdate.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "that is not a valid email address" });

  const result = await auth.updateEmail(
    principal.userId,
    parsed.data.email,
    parsed.data.currentPassword ?? null,
  );

  if ("error" in result) {
    if (result.error === "wrong_password") {
      return reply.code(403).send({ error: "that password is not right" });
    }
    if (result.error === "taken") {
      return reply.code(409).send({ error: "another account already uses that address" });
    }
    return reply.code(404).send({ error: "account not found" });
  }
  return result;
});

const PasswordUpdate = z.object({
  currentPassword: z.string().max(1024).optional(),
  // The floor, not a policy: length is the only requirement that reliably
  // helps, and a composition rule would push people towards worse passwords
  // they can remember.
  newPassword: z.string().min(8).max(1024),
});

app.put("/api/account/password", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = PasswordUpdate.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "the new password must be at least 8 characters" });
  }

  const result = await auth.changePassword(
    principal.userId,
    parsed.data.currentPassword ?? null,
    parsed.data.newPassword,
    principal.sessionId,
  );

  if ("error" in result) {
    if (result.error === "wrong_password") {
      return reply.code(403).send({ error: "that password is not right" });
    }
    return reply.code(404).send({ error: "account not found" });
  }
  // Said back so the page can report it: every other device was signed out.
  return { ok: true, hadPassword: result.hadPassword };
});

const AvatarUpdate = z.object({
  /** A `data:` URL from the browser, or null to remove the picture. */
  image: z.string().max(MAX_AVATAR_BYTES * 2).nullable(),
});

app.put("/api/account/avatar", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = AvatarUpdate.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "an image is required" });

  const stored = await auth.updateAvatar(principal.userId, parsed.data.image);
  if (!stored) {
    return reply
      .code(400)
      .send({ error: "that image could not be stored -- it must be a PNG, JPEG or WebP" });
  }
  return { avatarUrl: parsed.data.image };
});

/**
 * Exchanges the session cookie for a short-lived single-use ticket. A browser
 * cannot set headers on a WebSocket handshake, and a long-lived token in the
 * query string would leak into proxy logs -- so the socket is opened with a
 * ticket that is worthless once spent.
 */
app.post("/api/ws-ticket", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const { ticket, expiresInMs } = auth.issueTicket(principal);
  return { ticket, expiresInMs };
});

// -- Workspaces --------------------------------------------------------------

app.get("/api/workspaces", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  // Every account gets one, so the switcher is never empty on first load.
  await workspaceService.ensureDefault(principal.userId);
  return { workspaces: await workspaceService.list(principal.userId) };
});

app.post("/api/workspaces", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = z
    .object({
      name: z.string().trim().min(1).max(60),
      kind: z.enum(["project", "session"]).default("project"),
    })
    .safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "a workspace name of 1-60 characters is required" });
  }

  const created = await workspaceService.create(
    principal.userId,
    parsed.data.name,
    parsed.data.kind,
  );
  if ("conflict" in created) {
    return reply.code(409).send({ error: "too many workspaces with a similar name" });
  }
  return reply.code(201).send(created);
});

/**
 * Raster only: an SVG data URL is harmless in an <img>, but nothing stops a
 * later change from rendering it some other way. The browser rasterises
 * uploads before sending, so this only turns away hand-made requests.
 */
const WorkspaceLogo = z
  .string()
  .max(64 * 1024)
  .regex(/^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/]+={0,2}$/);

/** One workspace by its web address, for `/{hash}`. Not a member reads as not found. */
app.get<{ Params: { hash: string } }>("/api/workspaces/by-hash/:hash", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });
  if (!WorkspaceHash.safeParse(request.params.hash).success) {
    return reply.code(404).send({ error: "workspace not found" });
  }
  const workspace = await workspaceService.findWorkspaceByHash(request.params.hash, principal.userId);
  if (!workspace) return reply.code(404).send({ error: "workspace not found" });
  return workspace;
});

app.patch<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = z
    .object({
      name: z.string().trim().min(1).max(60).optional(),
      archived: z.boolean().optional(),
      logo: WorkspaceLogo.nullable().optional(),
    })
    .safeParse(request.body);
  if (!parsed.success) {
    const logoIssue = parsed.error.issues.some((issue) => issue.path[0] === "logo");
    return reply.code(400).send({
      error: logoIssue
        ? "the logo must be a PNG, JPEG or WebP image under 64 KB"
        : "a workspace name of 1-60 characters is required",
    });
  }

  const updated = await workspaceService.update(request.params.id, principal.userId, parsed.data);
  if (!updated) return reply.code(404).send({ error: "workspace not found" });
  return updated;
});

/**
 * Only an empty workspace can be deleted; one with projects is archived.
 * The menu offers whichever applies, and this refuses the other.
 */
app.delete<{ Params: { id: string } }>("/api/workspaces/:id", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const result = await workspaceService.deleteWorkspace(request.params.id, principal.userId);
  if ("error" in result) {
    if (result.error === "not_empty") {
      return reply.code(409).send({ error: "workspace is not empty -- archive it instead" });
    }
    if (result.error === "forbidden") {
      return reply.code(403).send({ error: "only the owner can delete a workspace" });
    }
    return reply.code(404).send({ error: "workspace not found" });
  }
  return reply.code(204).send();
});

app.get<{ Params: { id: string } }>("/api/workspaces/:id/projects", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const projects = await workspaceService.listProjects(request.params.id, principal.userId);
  // null means "not yours or not there" -- reported the same way, because
  // whether a workspace exists is itself privileged.
  if (!projects) return reply.code(404).send({ error: "workspace not found" });
  return { projects: projects.map(withPreviewUrls) };
});

/**
 * The Dashboard's headline numbers for one workspace.
 *
 * Separate from the projects list rather than folded into it: the list is
 * read on every page that has a sidebar, and these aggregates scan the turn
 * log.
 */
app.get<{ Params: { id: string } }>("/api/workspaces/:id/stats", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const stats = await workspaceService.stats(request.params.id, principal.userId);
  if (!stats) return reply.code(404).send({ error: "workspace not found" });
  return stats;
});

/**
 * The same bill, per model, for the Usage tab in Settings.
 *
 * Its own route rather than a field on `stats`: the Dashboard reads `stats`
 * on every visit and has no use for the breakdown, and this one groups over
 * the turn log a second time.
 */
app.get<{ Params: { id: string } }>("/api/workspaces/:id/usage", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const usage = await workspaceService.usage(request.params.id, principal.userId);
  if (!usage) return reply.code(404).send({ error: "workspace not found" });
  return usage;
});

/**
 * Disk and database footprint, for the same tab.
 *
 * Separate from `usage` because it walks every project directory, which is
 * a different order of cost from a grouped query and should not slow the
 * bill down when the reader only wanted the bill.
 */
app.get<{ Params: { id: string } }>("/api/workspaces/:id/storage", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const storage = await storageService.forWorkspace(request.params.id, principal.userId);
  if (!storage) return reply.code(404).send({ error: "workspace not found" });
  return storage;
});

/**
 * The manage page's figures for one project: what its turns were billed and
 * what its directory occupies. Together because the page shows them side by
 * side; the walk is one directory, not a workspace's worth.
 */
app.get<{ Params: { hash: string } }>("/api/projects/:hash/stats", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const project = await workspaceService.findByHash(request.params.hash, principal.userId);
  if (!project) return reply.code(404).send({ error: "project not found" });
  const [usage, storageBytes] = await Promise.all([
    workspaceService.projectUsage(project.id),
    storageService.projectBytes(project.id),
  ]);
  return { ...usage, storageBytes };
});

app.get<{ Params: { hash: string } }>("/api/projects/:hash", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const project = await workspaceService.findByHash(request.params.hash, principal.userId);
  if (!project) return reply.code(404).send({ error: "project not found" });
  return withPreviewUrls(project);
});

/**
 * The two addresses a preview has, computed here because only the server
 * knows the public domain and scheme: the subdomain the proxy serves, and
 * the shareable alias on the web app that redirects to it.
 */
function withPreviewUrls<T extends ProjectSummary>(
  project: T,
): T & { previewUrl: string | null; previewAliasUrl: string } {
  return {
    ...project,
    previewUrl: project.previewPort
      ? projectUrl(
          project.hash,
          project.previewPort,
          config.ROOT_DOMAIN,
          config.PUBLIC_SCHEME,
          config.PUBLIC_PREVIEW_PORT,
        )
      : null,
    previewAliasUrl: `${webOrigin(config)}/${project.hash}/preview`,
  };
}

const PreviewPortBody = z.object({
  port: z.number().int().min(1024).max(65535).nullable(),
  /** Present for a static site: the folder it is served from, "" for the root. */
  staticDir: z.string().max(512).nullable().optional(),
});

/** The subdomain a static site gets when the project has no port of its own yet. */
const STATIC_PREVIEW_PORT = 8080;

/** A static site's folder as stored: relative, normalized, without slashes at either end. */
function staticPreviewDir(projectId: string, input: string): string {
  const trimmed = input.trim().replace(/^[\\/]+|[\\/]+$/g, "");
  if (trimmed === "" || trimmed === ".") return "";
  // Throws a PathError for anything outside the tree or inside `.git`.
  workspaceFiles.resolve(projectId, trimmed);
  return trimmed.split(/[\\/]+/).filter((part) => part && part !== ".").join("/");
}

app.put<{ Params: { hash: string } }>("/api/projects/:hash/preview", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = PreviewPortBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "a port between 1024 and 65535, or null, is required" });
  }

  const existing = await workspaceService.findByHash(request.params.hash, principal.userId);
  if (!existing) return reply.code(404).send({ error: "project not found" });

  let staticDir: string | null = null;
  let port = parsed.data.port;
  if (parsed.data.staticDir != null) {
    try {
      staticDir = staticPreviewDir(existing.id, parsed.data.staticDir);
    } catch (error) {
      if (error instanceof PathError) return reply.code(400).send({ error: error.message });
      throw error;
    }
    const folder = await workspaceFiles.read(existing.id, staticDir || ".").catch(() => null);
    if (staticDir !== "" && folder?.kind !== "directory") {
      return reply.code(400).send({ error: `there is no folder ${staticDir} in the project` });
    }
    // The subdomain still names a port, so the address and the preview
    // cookie work as they do for a dev server; nothing has to listen on it.
    port ??= existing.previewPort ?? STATIC_PREVIEW_PORT;
  }

  const project = await workspaceService.setPreview(request.params.hash, principal.userId, {
    port,
    staticDir,
  });
  if (!project) return reply.code(404).send({ error: "project not found" });
  preview.invalidate(request.params.hash);
  return withPreviewUrls(project);
});

/** Whether the dev server is up, for the dialog's indicator. */
app.get<{ Params: { hash: string } }>("/api/projects/:hash/preview/status", async (request, reply) => {
  const project = await projectFor(request);
  if (!project) return reply.code(404).send({ error: "project not found" });
  if (!project.previewPort) return reply.code(404).send({ error: "no preview port set" });
  const target = {
    id: project.id,
    userId: "",
    previewPort: project.previewPort,
    previewStaticDir: project.previewStaticDir,
  };
  // For a static site "listening" means there is a page at its root.
  const listening =
    project.previewStaticDir != null
      ? await preview.hasStaticIndex(target)
      : await preview.listening(target, project.previewPort);
  return { port: project.previewPort, staticDir: project.previewStaticDir, listening };
});

/** Where a project opens in the web app: `/{ws}/s/{hash}` or `/{ws}/p/{hash}`. */
function webPathOf(project: ProjectSummary): string {
  if (!project.workspaceHash) return `/${project.hash}`;
  return `/${project.workspaceHash}/${project.workspaceKind === "session" ? "s" : "p"}/${project.hash}`;
}

/**
 * The shareable entry point, `/{hash}/preview[/rest]` on the web app, which
 * rewrites here. This is the only place with both the session cookie and
 * the project, so it is where ownership is checked; the visitor then leaves
 * with a single-use ticket that the preview host turns into its own cookie.
 */
async function openPreview(
  request: FastifyRequest<{ Params: { hash: string; "*"?: string } }>,
  reply: FastifyReply,
) {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.redirect(`${webOrigin(config)}/login`);

  const project = await workspaceService.findByHash(request.params.hash, principal.userId);
  if (!project) return reply.code(404).send({ error: "project not found" });
  if (!project.previewPort) {
    return reply.redirect(`${webOrigin(config)}${webPathOf(project)}?preview=setup`);
  }

  const ticket = preview.issueTicket({
    projectId: project.id,
    userId: principal.userId,
    port: project.previewPort,
  });
  const raw = request.raw.url ?? "";
  const query = raw.includes("?") ? raw.slice(raw.indexOf("?")) : "";
  const next = `/${request.params["*"] ?? ""}${query}`;
  const base = withPreviewUrls(project).previewUrl!;
  reply.header("cache-control", "no-store");
  return reply.redirect(`${base}/__ucch/auth?t=${ticket}&next=${encodeURIComponent(next)}`);
}

app.get("/api/projects/:hash/preview/open", openPreview);
app.get("/api/projects/:hash/preview/open/*", openPreview);

/**
 * Removes a project: the row, everything that cascades from it, and the
 * working tree on disk.
 *
 * The client confirms by typing the project's name -- this is unrecoverable,
 * and the log it deletes is the only record of the work.
 */
/** Renames a project -- a session's title, set from its first message. */
app.patch<{ Params: { hash: string } }>("/api/projects/:hash", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = z.object({ name: z.string().trim().min(1).max(100) }).safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "a name of 1-100 characters is required" });
  }

  const project = await workspaceService.renameProject(
    request.params.hash,
    principal.userId,
    parsed.data.name,
  );
  if (!project) return reply.code(404).send({ error: "project not found" });
  return { id: project.id, hash: project.hash, name: project.name };
});

app.delete<{ Params: { hash: string } }>("/api/projects/:hash", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const result = await workspaceService.deleteProject(request.params.hash, principal.userId);
  if ("error" in result) {
    if (result.error === "busy") {
      return reply
        .code(409)
        .send({ error: "a turn is still running in this project -- stop it, then delete" });
    }
    if (result.error === "forbidden") {
      return reply.code(403).send({ error: "only a workspace admin can delete a project" });
    }
    return reply.code(404).send({ error: "project not found" });
  }

  // Whoever still has it open stops hearing about it now.
  void gateway.revalidate({ projectId: result.projectId }).catch((error) =>
    app.log.error({ err: error }, "could not re-check access"),
  );

  // After the row, not before: a failed delete must not leave a project
  // pointing at a directory that is already gone. The id is a uuid from the
  // database rather than anything the caller supplied, so it cannot climb out
  // of the workspace root.
  const workspace = join(config.WORKSPACE_ROOT, result.projectId);
  try {
    await rm(workspace, { recursive: true, force: true });
    // Its sessions' worktrees live beside it, and go with it. Their
    // branches were in the repository just removed.
    await rm(sessionTreesOf(config.WORKSPACE_ROOT, result.projectId), { recursive: true, force: true });
    // Staging is outside the workspace, so removing the tree does not take
    // it: an attachment nobody placed would otherwise outlive its project.
    await uploads.discardAll(result.projectId);
  } catch (error) {
    // The project is gone either way; a directory left behind is a wasted
    // few megabytes, not a broken state, and saying so beats failing a
    // deletion that has already happened.
    app.log.error({ err: error, workspace }, "could not remove the project workspace");
  }

  return { ok: true };
});

// -- Repositories ------------------------------------------------------------

/**
 * The branches a repository offers, for the new-project dialog.
 *
 * Read with `git ls-remote`, which touches nothing on disk. The URL is held
 * to the same whitelist a clone is, so this cannot be pointed at `ext::`; it
 * can reach any host the server can reach, which is the same reach
 * `project.create` already has and is why it is behind a session.
 */
app.get<{ Querystring: { url?: string } }>("/api/git/refs", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const url = request.query.url?.trim();
  if (!url) return reply.code(400).send({ error: "a repository url is required" });

  try {
    // The token is only ever put on a github.com HTTPS URL, and only to read
    // refs the account can already read. A custom URL pointing anywhere else
    // is read anonymously, exactly as before.
    return await listRemoteBranches(url, { token: await githubTokenFor(principal.userId) });
  } catch (error) {
    // A bad URL, a private repository, a host that is not there: all of them
    // are the caller's problem to fix, and git's own message says which.
    const message = error instanceof Error ? error.message : String(error);
    return reply.code(400).send({ error: message });
  }
});

/**
 * Searching a project's files, for the search sidebar.
 *
 * GET with the query in the URL rather than POST: it is a read, it is
 * idempotent, and the browser cancels a superseded one by aborting the fetch.
 * The only directory searched is the project's own workspace -- no path comes
 * from the caller -- so this can reach nothing the file tree could not.
 */
app.get<{
  Params: { hash: string };
  Querystring: { q?: string; case?: string; regex?: string; glob?: string };
}>("/api/projects/:hash/search", async (request, reply) => {
  const project = await projectFor(request);
  if (!project) return reply.code(404).send({ error: "project not found" });

  const query = request.query.q ?? "";
  // An empty box is not a search. Answering it with every line in the project
  // would be slow and useless in equal measure.
  if (!query.trim()) return { matches: [], truncated: false };
  if (query.length > MAX_QUERY_LENGTH) {
    return reply.code(400).send({ error: `a search may be at most ${MAX_QUERY_LENGTH} characters` });
  }

  try {
    return await searchWorkspace(join(config.WORKSPACE_ROOT, project.id), {
      query,
      caseSensitive: request.query.case === "1",
      regex: request.query.regex === "1",
      glob: request.query.glob?.trim() || null,
    });
  } catch (error) {
    if (error instanceof SearchError) {
      // A bad regular expression is the caller's to fix and says so; a missing
      // ripgrep is the operator's, and must not read as "no matches".
      return reply.code(error.fromQuery ? 400 : 503).send({ error: error.message });
    }
    app.log.error({ err: error, projectId: project.id }, "search failed");
    return reply.code(500).send({ error: "the search could not be run" });
  }
});

// -- Project files -----------------------------------------------------------

/**
 * The workspace on disk, for the file tree and the editor.
 *
 * Every route resolves the project through `findByHash`, so a hash that is
 * not the caller's is refused before any path is touched, and then every path
 * goes through `WorkspaceFiles.resolve`, which confines it to
 * `WORKSPACE_ROOT/{projectId}` -- the same directory, and the same rule, the
 * agent's own file tools are held to.
 */
async function projectFor(
  request: { cookies: Record<string, string | undefined>; params: { hash: string } },
): Promise<ProjectSummary | null> {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return null;
  return workspaceService.findByHash(request.params.hash, principal.userId);
}

/**
 * The tree a project request works on. `?session={threadHash}` names a
 * project session, whose files are its own worktree; without one it is the
 * project's checkout. A session of another project is null, never a
 * fallback to somebody else's tree.
 */
async function sessionTarget(
  request: { query?: unknown },
  project: ProjectSummary,
): Promise<TreeTarget | null> {
  const query = request.query as { session?: unknown } | undefined;
  const session = typeof query?.session === "string" ? query.session : null;
  if (!session) return project.id;
  if (!ThreadHash.safeParse(session).success) return null;
  const [thread] = await db
    .select({ projectId: threads.projectId, hash: threads.hash, worktreeState: threads.worktreeState })
    .from(threads)
    .where(and(eq(threads.hash, session), eq(threads.projectId, project.id)))
    .limit(1);
  if (!thread) return null;
  return { projectId: project.id, tree: treeFor(config.WORKSPACE_ROOT, project.id, thread) };
}

/** The browser tab a request came from, as the web app's fetch stamps it. */
function clientIdOf(request: { headers: Record<string, string | string[] | undefined> }): string {
  const header = request.headers["x-ucch-client"];
  const value = Array.isArray(header) ? header[0] : header;
  return value && /^[A-Za-z0-9_-]{1,64}$/.test(value) ? value : "unknown";
}

/** Who made a change and from which tab, for the notices and the activity log. */
async function originOf(request: {
  cookies: Record<string, string | undefined>;
  headers: Record<string, string | string[] | undefined>;
}): Promise<ChangeOrigin | undefined> {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return undefined;
  return { userId: principal.userId, clientId: clientIdOf(request) };
}

/**
 * Every other write, logged once it has succeeded.
 *
 * The routes with something richer to say log themselves (see
 * route-audit.ts); this catches the rest from the route's pattern, so a
 * write cannot reach the database without reaching the history. It also
 * tells the other tabs to refetch what changed.
 */
app.addHook("onResponse", async (request, reply) => {
  if (reply.statusCode < 200 || reply.statusCode >= 300) return;
  const change = describeRoute(
    request.method,
    request.routeOptions.url,
    request.params as Record<string, string | undefined>,
    request.body,
    request.query as Record<string, string | undefined>,
  );
  if (!change) return;
  try {
    const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!principal) return;
    const hash = (request.params as { hash?: string }).hash;
    const project =
      change.scope === "project" && hash ? await workspaceService.findByHash(hash, principal.userId) : null;
    const origin = { userId: principal.userId, clientId: clientIdOf(request) };
    await audit.record({
      projectId: project?.id ?? null,
      userId: principal.userId,
      clientId: origin.clientId,
      action: change.action,
      targetType: change.targetType,
      targetId: change.targetId ?? null,
      summary: change.summary,
      ...(change.details ? { details: change.details } : {}),
    });
    if (change.resource) {
      const event: DomainEvent = {
        type: "resource.changed",
        projectId: project?.id ?? null,
        resource: change.resource,
        ...(change.targetId ? { id: change.targetId } : {}),
        origin,
      };
      if (project) bus.publish({ seq: null, projectId: project.id, threadId: null, event });
      bus.publishToUser(principal.userId, event);
    }
  } catch (error) {
    app.log.error({ err: error }, "could not log a change");
  }
});

app.get<{
  Params: { hash: string };
  Querystring: { before?: string; limit?: string; action?: string; user?: string };
}>("/api/projects/:hash/activity", async (request, reply) => {
  const project = await projectFor(request);
  if (!project) return reply.code(404).send({ error: "project not found" });
  const before = Number(request.query.before);
  const limit = Number(request.query.limit);
  const user = z.string().uuid().safeParse(request.query.user);
  const entries = await audit.list(project.id, {
    ...(Number.isInteger(before) && before > 0 ? { before } : {}),
    ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
    ...(request.query.action ? { action: request.query.action.slice(0, 64) } : {}),
    ...(user.success ? { userId: user.data } : {}),
  });
  return { entries };
});

/** The caller's own account-level history: settings, connections, tokens. */
app.get<{ Querystring: { before?: string; limit?: string; action?: string } }>(
  "/api/activity",
  async (request, reply) => {
    const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const before = Number(request.query.before);
    const limit = Number(request.query.limit);
    const entries = await audit.listForAccount(principal.userId, {
      ...(Number.isInteger(before) && before > 0 ? { before } : {}),
      ...(Number.isInteger(limit) && limit > 0 ? { limit } : {}),
      ...(request.query.action ? { action: request.query.action.slice(0, 64) } : {}),
    });
    return { entries };
  },
);

/**
 * Records the change so every other view of this project hears about it.
 *
 * The agent's `write_file` and `edit_file` emit exactly this event, so a file
 * the person edits and a file the model edits reach the UI by one path
 * rather than two. `file.changed` has no projection -- it is a notification,
 * and the disk is the state.
 */
async function announceFileChange(
  projectId: string,
  path: string,
  change: "added" | "modified" | "deleted",
  origin?: ChangeOrigin,
): Promise<void> {
  await store
    .append({ projectId, threadId: null }, [
      { type: "file.changed", projectId, path, change, ...(origin ? { origin } : {}) },
    ])
    .catch((error) => app.log.error({ err: error }, "could not record a file change"));
}

const gitService = new GitService(config.WORKSPACE_ROOT);

/**
 * Removing project sessions: settled by hand (their work pushed first), or
 * swept away for having nothing in them. See `session-lifecycle.ts`.
 */
const sessionLifecycle = new SessionLifecycle({
  git: gitService,
  workspaceRoot: config.WORKSPACE_ROOT,
  turnCount: async (threadId) => {
    const [row] = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(turns)
      .where(eq(turns.threadId, threadId));
    return row?.count ?? 0;
  },
  deleteThread: async (threadId) => {
    await db.delete(threads).where(eq(threads.id, threadId));
  },
  // The same token the push route uses: the owner's, and only for a host it
  // belongs to.
  credentials: async (projectId) => {
    const [credentials, url] = await Promise.all([ownerCredentials(projectId), gitService.remoteUrl(projectId)]);
    return { token: url && tokenAppliesTo(url) ? credentials.token : null, author: credentials.author };
  },
  announce: async (projectId, event) => {
    await store
      .append({ projectId, threadId: null }, [event])
      .catch((error) => app.log.error({ err: error }, "could not announce a removed session"));
  },
  onCleanupError: (error, session) =>
    app.log.error({ err: error, threadId: session.id }, "could not remove a session's worktree"),
});

const SESSION_COLUMNS = {
  id: threads.id,
  projectId: threads.projectId,
  hash: threads.hash,
  title: threads.title,
  status: threads.status,
  branch: threads.branch,
  baseBranch: threads.baseBranch,
  worktreeState: threads.worktreeState,
};

/** How old an empty session has to be before the sweep takes it. */
const EMPTY_SESSION_AGE_MS = 30 * 60_000;

/**
 * Empty project sessions nobody is looking at, removed. Leaving a session
 * removes it at once (the web app asks); this catches the ones left behind
 * by a closed tab. Only project workspaces' threads, never the Tasks
 * board's, never one with a turn, never one someone has open -- and each is
 * inspected again before it goes, so an edit made meanwhile keeps it.
 */
async function sweepEmptySessions(): Promise<void> {
  const candidates: SessionRecord[] = await db
    .select(SESSION_COLUMNS)
    .from(threads)
    .innerJoin(projects, eq(projects.id, threads.projectId))
    .innerJoin(workspaces, eq(workspaces.id, projects.workspaceId))
    .where(
      and(
        eq(workspaces.kind, "project"),
        eq(threads.status, "idle"),
        lt(threads.createdAt, new Date(Date.now() - EMPTY_SESSION_AGE_MS)),
        notLike(threads.title, "Task: %"),
        notLike(threads.title, "Verify: %"),
        sql`not exists (select 1 from ${turns} where ${turns.threadId} = ${threads.id})`,
      ),
    )
    .limit(200);
  for (const session of candidates) {
    if (presence.list(session.projectId).some((v) => v.location === `thread:${session.id}`)) continue;
    await sessionLifecycle
      .removeIfEmpty(session)
      .catch((error) => app.log.error({ err: error, threadId: session.id }, "could not sweep a session"));
  }
}

setInterval(() => {
  sweepEmptySessions().catch((error) => app.log.error({ err: error }, "could not sweep empty sessions"));
}, 5 * 60_000).unref();
const notesService = new NotesService(db);

registerNoteRoutes(app, {
  projectFor,
  originOf,
  audit: (input) => audit.record(input),
  notes: notesService,
  uploads,
  maxImageBytes: config.UPLOAD_MAX_BYTES,
  announce: async (event) => {
    await store
      .append({ projectId: event.projectId, threadId: null }, [event])
      .catch((error) => app.log.error({ err: error }, "could not announce a note change"));
  },
});

registerTimelineRoutes(app, {
  projectFor,
  originOf,
  audit: (input) => audit.record(input),
  timeline: new TimelineService(db),
  announce: async (event) => {
    await store
      .append({ projectId: event.projectId, threadId: null }, [event])
      .catch((error) => app.log.error({ err: error }, "could not announce a timeline change"));
  },
});

/**
 * The Tasks board. A card in Research, Ongoing or Verification is carried
 * by the pipeline, in chat threads of the project under the owner's name;
 * the scheduler moves Idea cards to Research on the board's own schedule.
 */
const tasksService = new TasksService(db);
const interruptedTasks = await tasksService.recoverInterrupted();
if (interruptedTasks > 0) app.log.info({ count: interruptedTasks }, "marked interrupted tasks as failed");

const announceTask = async (projectId: string, task: { id: string; updatedAt: string }) => {
  await store
    .append({ projectId, threadId: null }, [
      { type: "task.changed", projectId, taskId: task.id, change: "updated", updatedAt: task.updatedAt },
    ])
    .catch((error) => app.log.error({ err: error }, "could not announce a task change"));
};

const taskPipeline = new TaskPipeline({
  tasks: tasksService,
  dispatch: (principal, command) => engine.dispatch(principal, command),
  bus,
  agent: agentTurns,
  ownerOf: async (projectId) => {
    const [row] = await db
      .select({ userId: users.id, defaultProvider: users.defaultProvider })
      .from(projects)
      .innerJoin(users, eq(users.id, projects.userId))
      .where(eq(projects.id, projectId))
      .limit(1);
    return row ?? null;
  },
  announce: announceTask,
  onError: (error, context) => app.log.error({ err: error }, context),
});

registerTaskRoutes(app, {
  projectFor,
  originOf,
  audit: (input) => audit.record(input),
  tasks: tasksService,
  pipeline: taskPipeline,
  uploads,
  announce: async (event) => {
    await store
      .append({ projectId: event.projectId, threadId: null }, [event])
      .catch((error) => app.log.error({ err: error }, "could not announce a task change"));
  },
});

const taskScheduler = new TaskScheduler({
  tasks: tasksService,
  quotaFor: async (userId, provider) => (await sessionQuotasFor(userId))[provider],
  defaultProviderOf: async (userId) => {
    const [row] = await db
      .select({ provider: users.defaultProvider })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    return row?.provider ?? null;
  },
  enqueue: (projectId, taskId) => taskPipeline.enqueue(projectId, taskId),
  announce: announceTask,
  onError: (error) => app.log.error({ err: error }, "task auto-run failed"),
});
taskScheduler.start();

registerKeyRoutes(app, {
  projectFor,
  keys: config.SECRET_KEY ? new ProjectKeyService(db, config.SECRET_KEY) : null,
});

registerDatabaseRoutes(app, {
  principalFor: (cookies) => auth.resolveSession(cookies[SESSION_COOKIE]),
  workspaceAllows: (workspaceId, userId, permission) =>
    workspaceService.allows(workspaceId, userId, permission),
  connections: databaseConnections,
  secretKey: config.SECRET_KEY,
  probe,
  adapterFor,
});

registerWorkspaceMemberRoutes(app, {
  principalFor: (cookies) => auth.resolveSession(cookies[SESSION_COOKIE]),
  members: new WorkspaceMemberService(db, workspaceService, config.SECRET_KEY),
  credentialsChanged: (workspaceId) => providerService.invalidate(workspaceSubject(workspaceId)),
  accessChanged: (userId) => {
    void gateway.revalidate({ userId }).catch((error) => app.log.error({ err: error }, "could not re-check access"));
  },
});

/**
 * The credential subject a provider route acts on: the caller's own, or --
 * with `?workspace=<id>` -- that workspace's dedicated subscription, which
 * any member may look at and only an admin may change.
 */
async function providerSubject(
  userId: string,
  workspaceId: string | undefined,
  permission: "workspace.view" | "credentials.manage",
): Promise<string | null> {
  if (!workspaceId) return userId;
  if (!z.string().uuid().safeParse(workspaceId).success) return null;
  return (await workspaceService.allows(workspaceId, userId, permission)) ? workspaceSubject(workspaceId) : null;
}

registerDbManagerRoutes(app, {
  principalFor: (cookies) => auth.resolveSession(cookies[SESSION_COOKIE]),
  connections: databaseConnections,
  secretKey: config.SECRET_KEY,
  adapterFor,
});

/**
 * The read-only public site: on or off, and its address.
 *
 * Owner-only, like the preview port; the visitor-facing side is in
 * `registerPublicRoutes` and checks nothing but the slug.
 */
const PublicBody = z.object({ enabled: z.boolean() });

function withPublicUrl(state: { enabled: boolean; slug: string | null }) {
  return { ...state, url: state.slug ? `${webOrigin(config)}/${state.slug}` : null };
}

app.get<{ Params: { hash: string } }>("/api/projects/:hash/public", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });
  const state = await workspaceService.publicSite(request.params.hash, principal.userId);
  if (!state) return reply.code(404).send({ error: "project not found" });
  return withPublicUrl(state);
});

app.patch<{ Params: { hash: string } }>("/api/projects/:hash/public", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });
  const parsed = PublicBody.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "enabled must be true or false" });
  const state = await workspaceService.setPublic(request.params.hash, principal.userId, parsed.data.enabled);
  if (!state) return reply.code(404).send({ error: "project not found" });
  return withPublicUrl(state);
});

registerPublicRoutes(app, {
  findPublic: (slug) => workspaceService.findPublic(slug),
  notes: notesService,
  files: workspaceFiles,
  git: gitService,
  uploads,
});

registerGitRoutes(app, {
  projectFor,
  treeFor: sessionTarget,
  git: gitService,
  credentialsFor: ownerCredentials,
  remoteChanged: (projectId, url) => workspaceService.setRepoUrl(projectId, url),
  announce: async (projectId, events) => {
    await store
      .append({ projectId, threadId: null }, events)
      .catch((error) => app.log.error({ err: error }, "could not announce a git change"));
  },
});

/** Turns a refused path into a 400 and a clash into a 409. */
function fileFailure(error: unknown, reply: { code(status: number): { send(body: unknown): unknown } }) {
  if (error instanceof PathError) return reply.code(400).send({ error: error.message });
  if (error instanceof ConflictError) return reply.code(409).send({ error: error.message });
  throw error;
}

app.get<{ Params: { hash: string } }>("/api/projects/:hash/files", async (request, reply) => {
  const project = await projectFor(request);
  if (!project) return reply.code(404).send({ error: "project not found" });
  const tree = await sessionTarget(request, project);
  if (!tree) return reply.code(404).send({ error: "session not found" });
  return workspaceFiles.tree(tree);
});

app.get<{ Params: { hash: string }; Querystring: { path?: string } }>(
  "/api/projects/:hash/file",
  async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const tree = await sessionTarget(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    if (!request.query.path) return reply.code(400).send({ error: "a path is required" });

    try {
      const result = await workspaceFiles.read(tree, request.query.path);
      switch (result.kind) {
        case "text":
          return { path: request.query.path, content: result.content, version: result.version };
        case "missing":
          return reply.code(404).send({ error: "file not found" });
        case "directory":
          return reply.code(400).send({ error: "that is a directory" });
        case "binary":
          // 415 rather than an error string in the editor: the file is fine,
          // it is this editor that cannot show it.
          return reply.code(415).send({ error: "this file is not text" });
        case "too_large":
          return reply.code(413).send({ error: `this file is ${result.size} bytes, too large to open` });
      }
    } catch (error) {
      return fileFailure(error, reply);
    }
  },
);

/**
 * A file's bytes, for the image and PDF preview in the file view.
 *
 * Serving workspace files inline from this origin is the risk here, and the
 * headers are the answer to it rather than an afterthought:
 *
 * The type comes from `mediaTypeFor`, which reads the extension against a
 * short allow-list. Anything not on it is refused outright -- an `.html` in
 * the repository must never be served inline, because that is script
 * execution on this origin, and no preview is worth it.
 *
 * `nosniff` stops the browser overriding that type from the content, which
 * is what would otherwise turn a `.png` full of markup back into HTML.
 *
 * The CSP is the belt to that brace, and what makes SVG previewable at all:
 * `sandbox` puts the response in an opaque origin with scripts disabled, and
 * `default-src 'none'` stops it fetching anything of its own. An SVG carrying
 * a script tag therefore renders as a picture and does nothing else -- and
 * the client renders it in an `<img>`, which would not run it either way.
 *
 * `Content-Disposition: inline` with no filename: the name is already in the
 * URL, and quoting a workspace-controlled filename into a header is a class
 * of bug worth not having.
 */
app.get<{ Params: { hash: string }; Querystring: { path?: string } }>(
  "/api/projects/:hash/file/raw",
  async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const tree = await sessionTarget(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    if (!request.query.path) return reply.code(400).send({ error: "a path is required" });

    const mediaType = mediaTypeFor(request.query.path);
    if (!mediaType) return reply.code(415).send({ error: "this file cannot be previewed" });

    try {
      const result = await workspaceFiles.readBytes(tree, request.query.path);
      switch (result.kind) {
        case "missing":
          return reply.code(404).send({ error: "file not found" });
        case "directory":
          return reply.code(400).send({ error: "that is a directory" });
        case "too_large":
          return reply
            .code(413)
            .send({ error: `this file is ${result.size} bytes, too large to preview` });
        case "file":
          return reply
            .header("content-type", mediaType)
            .header("x-content-type-options", "nosniff")
            .header(
              "content-security-policy",
              "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
            )
            .header("content-disposition", "inline")
            // The workspace is mutable and per-user: a cached preview would
            // survive the agent rewriting the file underneath it.
            .header("cache-control", "private, no-store")
            .header("content-length", result.size)
            .send(result.stream);
      }
    } catch (error) {
      return fileFailure(error, reply);
    }
  },
);

const FileWrite = z.object({
  path: z.string().min(1).max(1024),
  content: z.string(),
  /** The version the editor opened; a file changed since is a 409, not an overwrite. */
  ifVersion: z.string().max(64).optional(),
});

app.put<{ Params: { hash: string } }>("/api/projects/:hash/file", async (request, reply) => {
  const project = await projectFor(request);
  if (!project) return reply.code(404).send({ error: "project not found" });
  const tree = await sessionTarget(request, project);
  if (!tree) return reply.code(404).send({ error: "session not found" });

  const parsed = FileWrite.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "a path and content are required" });

  const origin = await originOf(request);
  const { path, content, ifVersion } = parsed.data;
  // What it held before, for how much this save changed. Read before the
  // write, best-effort: a file that cannot be read is simply "new".
  const before = await workspaceFiles.read(tree, path).catch(() => null);
  try {
    const change = await workspaceFiles.write(tree, path, content, ifVersion);
    await announceFileChange(project.id, path, change, origin);
    void audit.record({
      projectId: project.id,
      userId: origin?.userId ?? null,
      clientId: origin?.clientId ?? null,
      action: change === "added" ? "file.create" : "file.write",
      targetType: "file",
      targetId: path,
      summary: change === "added" ? `Created ${path}` : `Edited ${path}`,
      details: textDelta(before?.kind === "text" ? before.content : "", content),
      coalesce: change === "modified",
    });
    return { path, change, version: contentVersion(content) };
  } catch (error) {
    if (error instanceof StaleWriteError) {
      void audit.record({
        projectId: project.id,
        userId: origin?.userId ?? null,
        clientId: origin?.clientId ?? null,
        action: "file.conflict",
        targetType: "file",
        targetId: path,
        summary: `Save of ${path} refused: changed elsewhere, reverted`,
      });
      return reply.code(409).send({
        error:
          error.content === null
            ? "This file was deleted elsewhere."
            : "This file was changed elsewhere since you opened it.",
        content: error.content,
        version: error.version,
      });
    }
    return fileFailure(error, reply);
  }
});

/**
 * Redraws one of the documentation page's diagrams from the codebase, and
 * saves it into the repository where the page reads it.
 *
 * A job rather than one long request: the agent takes a minute or more on a
 * real repository, longer than the web app's proxy holds a request open.
 * POST starts it and answers at once; GET says how it is going, and after it
 * finishes, how it went -- until the next POST. One job per diagram at a
 * time, since a second click would only pay for the same answer twice.
 * A job that runs past five minutes is stopped.
 */
type DiagramJob =
  | { state: "running" }
  | { state: "done"; path: string; source: string; model: string }
  | { state: "failed"; error: string };
const diagramJobs = new Map<string, DiagramJob>();
const DIAGRAM_TIMEOUT_MS = 5 * 60_000;

async function runDiagramJob(
  project: ProjectSummary,
  tree: TreeTarget,
  kind: DiagramKind,
): Promise<DiagramJob> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), DIAGRAM_TIMEOUT_MS);
  try {
    const outcome = await agentTurns.generateFromCodebase({
      projectId: project.id,
      stack: project.stack,
      ask: diagramAsk(kind),
      signal: controller.signal,
    });
    const source = extractMermaid(outcome.text, kind);
    const path = DIAGRAM_FILES[kind];
    const change = await workspaceFiles.write(tree, path, source);
    await announceFileChange(project.id, path, change);
    return { state: "done", path, source, model: outcome.model };
  } catch (error) {
    if (controller.signal.aborted) {
      return { state: "failed", error: "Generating the diagram took too long and was stopped." };
    }
    app.log.warn({ err: error }, "diagram generation failed");
    return { state: "failed", error: error instanceof Error ? error.message : "Could not generate the diagram." };
  } finally {
    clearTimeout(timer);
  }
}

app.post<{ Params: { hash: string; kind: string } }>(
  "/api/projects/:hash/diagrams/:kind/generate",
  async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const tree = await sessionTarget(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    const { kind } = request.params;
    if (!isDiagramKind(kind)) return reply.code(400).send({ error: "that diagram cannot be generated yet" });
    const key = `${project.id}:${kind}`;
    if (diagramJobs.get(key)?.state === "running") {
      return reply.code(409).send({ error: "This diagram is already being generated." });
    }
    diagramJobs.set(key, { state: "running" });
    void runDiagramJob(project, tree, kind).then((job) => diagramJobs.set(key, job));
    return reply.code(202).send({ state: "running" });
  },
);

app.get<{ Params: { hash: string; kind: string } }>(
  "/api/projects/:hash/diagrams/:kind/generate",
  async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const tree = await sessionTarget(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    if (!isDiagramKind(request.params.kind)) {
      return reply.code(400).send({ error: "that diagram cannot be generated yet" });
    }
    return diagramJobs.get(`${project.id}:${request.params.kind}`) ?? { state: "idle" };
  },
);

const FileCreate = z.object({
  path: z.string().min(1).max(1024),
  kind: z.enum(["file", "directory"]),
});

app.post<{ Params: { hash: string } }>("/api/projects/:hash/file", async (request, reply) => {
  const project = await projectFor(request);
  if (!project) return reply.code(404).send({ error: "project not found" });
  const tree = await sessionTarget(request, project);
  if (!tree) return reply.code(404).send({ error: "session not found" });

  const parsed = FileCreate.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "a path and a kind are required" });

  try {
    await workspaceFiles.create(tree, parsed.data.path, parsed.data.kind);
    const origin = await originOf(request);
    // A new directory holds nothing, so there is no file to announce.
    if (parsed.data.kind === "file") await announceFileChange(project.id, parsed.data.path, "added", origin);
    void audit.record({
      projectId: project.id,
      userId: origin?.userId ?? null,
      clientId: origin?.clientId ?? null,
      action: parsed.data.kind === "file" ? "file.create" : "folder.create",
      targetType: parsed.data.kind,
      targetId: parsed.data.path,
      summary: `Created ${parsed.data.kind === "file" ? "" : "folder "}${parsed.data.path}`,
    });
    return reply.code(201).send({ path: parsed.data.path, kind: parsed.data.kind });
  } catch (error) {
    return fileFailure(error, reply);
  }
});

app.delete<{ Params: { hash: string }; Querystring: { path?: string } }>(
  "/api/projects/:hash/file",
  async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });
    const tree = await sessionTarget(request, project);
    if (!tree) return reply.code(404).send({ error: "session not found" });
    if (!request.query.path) return reply.code(400).send({ error: "a path is required" });

    try {
      const removed = await workspaceFiles.remove(tree, request.query.path);
      if (!removed) return reply.code(404).send({ error: "file not found" });
      const origin = await originOf(request);
      await announceFileChange(project.id, request.query.path, "deleted", origin);
      void audit.record({
        projectId: project.id,
        userId: origin?.userId ?? null,
        clientId: origin?.clientId ?? null,
        action: "file.delete",
        targetType: "file",
        targetId: request.query.path,
        summary: `Deleted ${request.query.path}`,
      });
      return { path: request.query.path, change: "deleted" };
    } catch (error) {
      return fileFailure(error, reply);
    }
  },
);

const FileMove = z.object({
  from: z.string().min(1).max(1024),
  to: z.string().min(1).max(1024),
});

app.patch<{ Params: { hash: string } }>("/api/projects/:hash/file", async (request, reply) => {
  const project = await projectFor(request);
  if (!project) return reply.code(404).send({ error: "project not found" });
  const tree = await sessionTarget(request, project);
  if (!tree) return reply.code(404).send({ error: "session not found" });

  const parsed = FileMove.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "a from and a to path are required" });

  try {
    const moved = await workspaceFiles.move(tree, parsed.data.from, parsed.data.to);
    if (!moved) return reply.code(404).send({ error: "file not found" });
    // A move is a departure and an arrival to everyone else: the two events
    // that already exist say exactly that, so there is no third kind.
    const origin = await originOf(request);
    await announceFileChange(project.id, parsed.data.from, "deleted", origin);
    await announceFileChange(project.id, parsed.data.to, "added", origin);
    void audit.record({
      projectId: project.id,
      userId: origin?.userId ?? null,
      clientId: origin?.clientId ?? null,
      action: "file.move",
      targetType: "file",
      targetId: parsed.data.to,
      summary: `Moved ${parsed.data.from} to ${parsed.data.to}`,
      details: { from: parsed.data.from, to: parsed.data.to },
    });
    return { from: parsed.data.from, to: parsed.data.to };
  } catch (error) {
    return fileFailure(error, reply);
  }
});

// -- Settings ----------------------------------------------------------------

/**
 * A stored secret in the clear, or null when it cannot be had.
 *
 * Null covers all three ways that happens -- nothing stored, no `SECRET_KEY`
 * to decrypt with, and a value encrypted under a `SECRET_KEY` that has since
 * changed -- because every caller does the same thing with them: carry on
 * without the capability the secret would have granted.
 */
function decryptOrNull(encrypted: string | null): string | null {
  if (!encrypted || !config.SECRET_KEY) return null;
  try {
    return decryptSecret(encrypted, config.SECRET_KEY);
  } catch {
    return null;
  }
}

/**
 * The GitHub token to act as this account with, or null.
 *
 * The personal access token first, the OAuth token from signing in second.
 * That order is the whole policy: a token the person deliberately pasted is
 * the one they meant to grant, and the login token is a fallback that makes
 * the repository list work out of the box for a GitHub sign-in without
 * anybody configuring anything.
 */
async function githubTokenFor(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ token: users.githubTokenEncrypted, oauth: users.accessTokenEncrypted })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!row) return null;
  return decryptOrNull(row.token) ?? decryptOrNull(row.oauth);
}

/**
 * The model this account's turns use when nothing names one.
 *
 * The account's own choice, or the server's configured default when it has
 * made none. Resolved per call rather than cached: it is one indexed read, and
 * a stale answer here would bill a turn to a model the person had just changed
 * away from.
 */
async function defaultModelFor(userId: string): Promise<string> {
  const [row] = await db
    .select({ model: users.defaultModel })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.model || config.DEFAULT_MODEL;
}

/**
 * What the settings page is allowed to know about a stored key: that there is
 * one, and enough of it to recognise which. The key itself never comes back
 * out of the server.
 */
function describeKey(encrypted: string | null): { configured: boolean; hint: string | null } {
  if (!encrypted || !config.SECRET_KEY) return { configured: false, hint: null };
  try {
    const key = decryptSecret(encrypted, config.SECRET_KEY);
    return { configured: true, hint: `…${key.slice(-4)}` };
  } catch {
    // A key encrypted under a SECRET_KEY that has since changed is not
    // recoverable, and saying "configured" would be a lie the user cannot act
    // on -- they would have no way to tell why every turn fails.
    return { configured: false, hint: null };
  }
}

/**
 * Staging for one project: what is waiting, what to accept, what to drop.
 *
 * A staged file is not in the project. It sits outside every workspace root
 * until `attach_upload` -- or the attach route below -- places it, which is
 * what keeps a screenshot dropped into the chat out of `git status` and out
 * of the agent's reach until somebody means it to be there.
 */
app.get<{ Params: { hash: string } }>("/api/projects/:hash/uploads", async (request, reply) => {
  const project = await projectFor(request);
  if (!project) return reply.code(404).send({ error: "project not found" });
  return { uploads: await uploads.list(project.id) };
});

app.post<{ Params: { hash: string }; Querystring: { name?: string; type?: string } }>(
  "/api/projects/:hash/uploads",
  { bodyLimit: config.UPLOAD_MAX_BYTES },
  async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });

    if (!Buffer.isBuffer(request.body)) {
      return reply
        .code(415)
        .send({ error: "send the file as application/octet-stream" });
    }
    if (!request.query.name) return reply.code(400).send({ error: "a name is required" });

    try {
      const upload = await uploads.stage(
        project.id,
        request.query.name,
        request.query.type ?? "application/octet-stream",
        request.body,
      );
      return reply.code(201).send({ upload });
    } catch (error) {
      return fileFailure(error, reply);
    }
  },
);

/**
 * A staged attachment's bytes: the preview in the chat, and the download.
 *
 * The two modes are one route because they serve the same bytes, and they are
 * modes rather than a single behaviour because inline and attachment are
 * different risks:
 *
 * `?download=1` always answers `application/octet-stream`, which no browser
 * renders, so any attachment can be taken back out whatever it is. That is
 * what makes it safe to offer for every file.
 *
 * Inline is the narrow one, and is held to exactly what `/file/raw` is held
 * to: the type comes from `mediaTypeFor`, an extension allow-list, and
 * anything not on it is refused rather than guessed at. The uploader's own
 * `contentType` is deliberately ignored here -- it is a claim made by
 * whoever sent the file, and serving `text/html` inline on this origin on the
 * strength of it would be script execution in the app. `nosniff` stops the
 * browser overriding the type from the content, and the sandbox CSP puts the
 * response in an opaque origin with nothing it can fetch or run, which is
 * what makes an SVG safe to look at.
 */
app.get<{ Params: { hash: string; id: string }; Querystring: { download?: string } }>(
  "/api/projects/:hash/uploads/:id/content",
  async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const upload = await uploads.find(project.id, request.params.id);
    if (!upload) return reply.code(404).send({ error: "that upload is no longer staged" });

    const download = request.query.download === "1";
    // Read from the name, not from what the uploader said the type was.
    const mediaType = mediaTypeFor(upload.name);
    if (!download && !mediaType) {
      return reply.code(415).send({ error: "this attachment cannot be previewed" });
    }

    const file = await uploads.openStream(project.id, request.params.id);
    if (!file) return reply.code(404).send({ error: "that upload is no longer staged" });

    return reply
      .header("content-type", download ? "application/octet-stream" : mediaType!)
      .header("x-content-type-options", "nosniff")
      .header(
        "content-security-policy",
        "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox",
      )
      .header("content-disposition", download ? contentDisposition(upload.name) : "inline")
      // Staging is per-user and expires; a cached copy would outlive it.
      .header("cache-control", "private, no-store")
      .header("content-length", file.size)
      .send(file.stream);
  },
);

/**
 * A staged attachment as text, for previewing one that is not a picture.
 *
 * JSON rather than bytes, and that is the point: a text file served inline
 * from this origin is the thing `/content` refuses to do, so the text comes
 * back as a string the page puts in an element. Nothing is rendered as a
 * document, so a `.html` attachment is as safe to read here as a `.txt`.
 *
 * The NUL-byte test is the same one the editor uses on workspace files: it is
 * the practical answer to "is this text", and a file that fails it gets the
 * download rather than a page of mojibake.
 */
app.get<{ Params: { hash: string; id: string } }>(
  "/api/projects/:hash/uploads/:id/text",
  async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const upload = await uploads.find(project.id, request.params.id);
    if (!upload) return reply.code(404).send({ error: "that upload is no longer staged" });

    const file = await uploads.readBytes(project.id, request.params.id);
    if (!file) return reply.code(404).send({ error: "that upload is no longer staged" });
    if (file.bytes.subarray(0, 8000).includes(0)) {
      return reply.code(415).send({ error: "this attachment is not text" });
    }

    // Capped at the preview's own limit rather than the upload limit: a 40 MB
    // log is a download, not something to put in a dialog. The flag is what
    // lets the dialog say so instead of silently showing part of a file.
    const truncated = file.bytes.length > UPLOAD_TEXT_PREVIEW_BYTES;
    const bytes = truncated ? file.bytes.subarray(0, UPLOAD_TEXT_PREVIEW_BYTES) : file.bytes;

    return {
      name: upload.name,
      size: upload.size,
      text: bytes.toString("utf8"),
      truncated,
    };
  },
);

const UploadAttach = z.object({ path: z.string().max(1024).optional() });

/**
 * Moves a staged file into the workspace from the browser.
 *
 * The same operation `attach_upload` performs, exposed so a person can place
 * a file without asking the model to -- and so the two can never diverge,
 * since both call the one store method.
 */
app.post<{ Params: { hash: string; id: string } }>(
  "/api/projects/:hash/uploads/:id/attach",
  async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const parsed = UploadAttach.safeParse(request.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: "path must be a string" });

    try {
      const attached = await uploads.attach(project.id, request.params.id, parsed.data.path ?? "");
      await announceFileChange(project.id, attached.path, "added");
      return attached;
    } catch (error) {
      if (error instanceof UnknownUploadError) {
        return reply.code(404).send({ error: "that upload is no longer staged" });
      }
      if (error instanceof UploadConflictError) {
        return reply.code(409).send({ error: error.message });
      }
      return fileFailure(error, reply);
    }
  },
);

app.delete<{ Params: { hash: string; id: string } }>(
  "/api/projects/:hash/uploads/:id",
  async (request, reply) => {
    const project = await projectFor(request);
    if (!project) return reply.code(404).send({ error: "project not found" });

    const discarded = await uploads.discard(project.id, request.params.id);
    if (!discarded) return reply.code(404).send({ error: "that upload is no longer staged" });
    return reply.code(204).send();
  },
);

/**
 * The Dashboard's quota card: what this account's OpenRouter key has left.
 *
 * Read through the key itself, so it is exactly the figure OpenRouter would
 * bill against, and cached briefly per account: the Dashboard is opened far
 * more often than a balance changes, and OpenRouter rate-limits the key
 * endpoint. 404 with `no_key` is the one non-error: the card then says to
 * add a key rather than that something failed.
 */
const quotaCache = new Map<string, { at: number; quota: KeyQuota }>();
const QUOTA_TTL_MS = 60_000;

app.get("/api/account/openrouter/quota", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const cached = quotaCache.get(principal.userId);
  if (cached && Date.now() - cached.at < QUOTA_TTL_MS) return cached.quota;

  const [row] = await db
    .select({ openrouter: users.openrouterKeyEncrypted })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);
  const apiKey = decryptOrNull(row?.openrouter ?? null);
  if (!apiKey) return reply.code(404).send({ error: "no_key" });

  try {
    const quota = await keyQuota(apiKey, AbortSignal.timeout(10_000));
    quotaCache.set(principal.userId, { at: Date.now(), quota });
    return quota;
  } catch (error) {
    request.log.warn({ err: error }, "openrouter quota lookup failed");
    return reply.code(502).send({ error: "openrouter unavailable" });
  }
});

/**
 * The sidebar's three meters: how much of each harness's allowance is used.
 *
 * One request for all three rather than one each, and each provider fails
 * on its own -- a Codex that is not signed in does not blank the Claude
 * bar. Cached per account for a minute, the same as the OpenRouter card:
 * the meters poll, and neither vendor wants to be asked every few seconds.
 * OpenRouter's figure comes through the same cache the Dashboard fills.
 */
const sessionQuotaCache = new Map<string, { at: number; quotas: SessionQuotas }>();

app.get("/api/account/quotas", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });
  return sessionQuotasFor(principal.userId);
});

/**
 * One account's usage of each provider, through the same minute-long cache
 * the meters read -- the Tasks board's auto-run checks it before starting.
 */
async function sessionQuotasFor(userId: string): Promise<SessionQuotas> {
  const cached = sessionQuotaCache.get(userId);
  if (cached && Date.now() - cached.at < QUOTA_TTL_MS) return cached.quotas;

  const checkedAt = new Date().toISOString();
  const failed = (provider: ProviderId, error: unknown): SessionQuota => {
    app.log.warn({ err: error, provider }, "session quota lookup failed");
    return { provider, status: "unavailable", error: error instanceof Error ? error.message : String(error) };
  };

  const claude = (async (): Promise<SessionQuota> => {
    // The CLI's own login first; a pasted setup-token is the fallback,
    // since the usage endpoint does not always honour its narrower scope.
    const token =
      (await readClaudeAccessToken(providerService.credsDir(userId, "claude"))) ??
      (await providerService.claudeToken(userId));
    if (!token) return { provider: "claude", status: "no_auth" };
    try {
      const windows = await fetchClaudeUsage(token, AbortSignal.timeout(10_000));
      return { provider: "claude", status: "ok", windows, checkedAt };
    } catch (error) {
      return failed("claude", error);
    }
  })();

  const codex = (async (): Promise<SessionQuota> => {
    const tokens = await readCodexTokens(providerService.credsDir(userId, "codex"));
    if (!tokens) return { provider: "codex", status: "no_auth" };
    try {
      const windows = await fetchCodexUsage(tokens, AbortSignal.timeout(10_000));
      return { provider: "codex", status: "ok", windows, checkedAt };
    } catch (error) {
      return failed("codex", error);
    }
  })();

  const native = (async (): Promise<SessionQuota> => {
    const hit = quotaCache.get(userId);
    if (hit && Date.now() - hit.at < QUOTA_TTL_MS) {
      return { provider: "native", status: "ok", windows: openRouterWindows(hit.quota), checkedAt };
    }
    const [row] = await db
      .select({ openrouter: users.openrouterKeyEncrypted })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);
    const apiKey = decryptOrNull(row?.openrouter ?? null);
    if (!apiKey) return { provider: "native", status: "no_auth" };
    try {
      const quota = await keyQuota(apiKey, AbortSignal.timeout(10_000));
      quotaCache.set(userId, { at: Date.now(), quota });
      return { provider: "native", status: "ok", windows: openRouterWindows(quota), checkedAt };
    } catch (error) {
      return failed("native", error);
    }
  })();

  const quotas: SessionQuotas = {
    claude: await claude,
    codex: await codex,
    native: await native,
  };
  sessionQuotaCache.set(userId, { at: Date.now(), quotas });
  return quotas;
}

app.get("/api/settings", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const [row] = await db
    .select({
      openrouter: users.openrouterKeyEncrypted,
      resend: users.resendKeyEncrypted,
      github: users.githubTokenEncrypted,
      oauth: users.accessTokenEncrypted,
      defaultModel: users.defaultModel,
      defaultProvider: users.defaultProvider,
      agentPermissionMode: users.agentPermissionMode,
    })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);

  // Only ever whether a key is set and its last four characters. The values
  // themselves are decrypted where they are used and nowhere else.
  return {
    openrouter: describeKey(row?.openrouter ?? null),
    resend: describeKey(row?.resend ?? null),
    github: {
      ...describeKey(row?.github ?? null),
      // Whether the repository list will work without a token of its own,
      // which is the difference between "set one up" and "you already can".
      inheritedFromLogin: Boolean(decryptOrNull(row?.oauth ?? null)),
    },
    // Both, because the page has two things to say: which model is in force,
    // and whether that is a choice this account made or the server's own
    // default showing through.
    defaultModel: row?.defaultModel || config.DEFAULT_MODEL,
    chosenModel: row?.defaultModel ?? null,
    serverDefaultModel: config.DEFAULT_MODEL,
    defaultProvider: row?.defaultProvider ?? "native",
    agentPermissionMode: agentPermissionModeOf(row?.agentPermissionMode ?? null),
    encryptionAvailable: Boolean(config.SECRET_KEY),
  };
});

/** A stored mode, or Normal for an account that never chose (or a value from a newer build). */
function agentPermissionModeOf(stored: string | null): AgentPermissionMode {
  const parsed = AgentPermissionMode.safeParse(stored);
  return parsed.success ? parsed.data : DEFAULT_AGENT_PERMISSION_MODE;
}

const AgentPermissionBody = z.object({ mode: AgentPermissionMode });

/**
 * How much the agent may do before asking. Applies from the next question
 * on -- a running turn picks it up too -- except on a chat already set to
 * "Allow All" from its own prompt.
 */
app.put("/api/settings/agent-permission-mode", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = AgentPermissionBody.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "mode must be strict, normal or allow_all" });
  }

  await db
    .update(users)
    .set({ agentPermissionMode: parsed.data.mode })
    .where(eq(users.id, principal.userId));

  return { agentPermissionMode: parsed.data.mode };
});

const ApiKeyBody = z.object({
  /** null clears the stored key. */
  apiKey: z.string().trim().min(1).max(400).nullable(),
});

/**
 * Stores or clears one of the account's third-party keys.
 *
 * One handler for both providers because the handling is identical and must
 * stay that way: write-only, encrypted with `SECRET_KEY`, refused outright
 * when there is no key to encrypt with, and answered with nothing but the
 * hint. A second copy of this would be a second place for one of those to
 * quietly stop being true.
 */
async function storeApiKey(
  request: { cookies: Record<string, string | undefined>; body: unknown },
  reply: {
    code(status: number): { send(body: unknown): unknown };
  },
  provider: "openrouter" | "resend" | "github",
) {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = ApiKeyBody.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "an api key or null is required" });

  if (parsed.data.apiKey && !config.SECRET_KEY) {
    // Storing it in the clear would be worse than refusing.
    return reply
      .code(409)
      .send({ error: "SECRET_KEY is not configured, so a key cannot be stored safely" });
  }

  const encrypted = parsed.data.apiKey
    ? encryptSecret(parsed.data.apiKey, config.SECRET_KEY!)
    : null;

  await db
    .update(users)
    .set(
      provider === "openrouter"
        ? { openrouterKeyEncrypted: encrypted }
        : provider === "resend"
          ? { resendKeyEncrypted: encrypted }
          : { githubTokenEncrypted: encrypted },
    )
    .where(eq(users.id, principal.userId));

  // A new key has a new balance; the old one's must not show for a minute.
  if (provider === "openrouter") {
    quotaCache.delete(principal.userId);
    sessionQuotaCache.delete(principal.userId);
  }

  return { [provider]: describeKey(encrypted) };
}

app.put("/api/settings/openrouter", (request, reply) =>
  storeApiKey(request, reply, "openrouter"),
);

/**
 * The Resend key: transactional email out of the harness.
 *
 * Nothing sends mail yet -- address verification is what it is for, and that
 * lands with it. The key is stored now so the account page is one place
 * rather than two, and so the encryption question is answered once.
 */
app.put("/api/settings/resend", (request, reply) => storeApiKey(request, reply, "resend"));

/**
 * The GitHub token: listing your repositories, and cloning the private ones.
 *
 * Stored in its own column rather than over the OAuth token from signing in,
 * which the login flow owns and replaces. Saving one is answered with the
 * hint alone, like every other key here -- whether it *works* is a question
 * for `/api/github/repos`, which is the call that would use it.
 */
app.put("/api/settings/github", (request, reply) => storeApiKey(request, reply, "github"));

const DefaultModelBody = z.object({
  /** null clears the choice, so the server's own default applies again. */
  model: z.string().trim().min(1).max(200).nullable(),
});

/**
 * The account's default model.
 *
 * Not checked against the catalogue. That sounds like the careful thing to do
 * and is the wrong trade: the catalogue is a cached fetch from OpenRouter, so a
 * refresh that happened to be failing would start refusing models that work,
 * and a model that appeared this morning would be refused until the cache
 * turned over. The picker only ever offers real entries, and a bad id fails at
 * the one turn that uses it with OpenRouter's own message -- which is both
 * recoverable and more accurate than anything this could say.
 */
app.put("/api/settings/default-model", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = DefaultModelBody.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "a model id or null is required" });

  await db
    .update(users)
    .set({ defaultModel: parsed.data.model })
    .where(eq(users.id, principal.userId));

  return {
    defaultModel: parsed.data.model || config.DEFAULT_MODEL,
    chosenModel: parsed.data.model,
    serverDefaultModel: config.DEFAULT_MODEL,
  };
});

// -- Agent providers ---------------------------------------------------------

/**
 * The three provider cards: installed, signed in, how, and as whom (masked).
 * Probed through the CLIs themselves, cached briefly; `?fresh=1` after a
 * sign-in forces another look.
 */
app.get<{ Querystring: { fresh?: string; workspace?: string } }>("/api/providers", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });
  const subject = await providerSubject(principal.userId, request.query.workspace, "workspace.view");
  if (!subject) return reply.code(404).send({ error: "workspace not found" });

  const [row] = await db
    .select({ defaultProvider: users.defaultProvider })
    .from(users)
    .where(eq(users.id, principal.userId))
    .limit(1);

  const providers = await providerService.health(subject, {
    fresh: request.query.fresh === "1",
  });
  return {
    providers,
    defaultProvider: row?.defaultProvider ?? "native",
    cliEnabled: cliProvidersEnabled(config),
    encryptionAvailable: Boolean(config.SECRET_KEY),
  };
});

const ClaudeTokenBody = z.object({
  /** null clears the stored token. */
  token: z.string().trim().min(1).max(4000).nullable(),
});

/**
 * The pasted `claude setup-token`: the headless alternative to signing in
 * from a terminal. Same treatment as every other key -- write-only,
 * encrypted, refused without `SECRET_KEY` -- plus the issue date, because
 * it expires in a year and the page warns at eleven months.
 */
app.put("/api/settings/claude-token", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = ClaudeTokenBody.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "a token or null is required" });

  if (parsed.data.token && !config.SECRET_KEY) {
    return reply
      .code(409)
      .send({ error: "SECRET_KEY is not configured, so a token cannot be stored safely" });
  }

  await db
    .update(users)
    .set(
      parsed.data.token
        ? {
            claudeOauthTokenEncrypted: encryptSecret(parsed.data.token, config.SECRET_KEY!),
            claudeTokenIssuedAt: new Date(),
          }
        : { claudeOauthTokenEncrypted: null, claudeTokenIssuedAt: null },
    )
    .where(eq(users.id, principal.userId));
  providerService.invalidate(principal.userId);
  sessionQuotaCache.delete(principal.userId);

  return { configured: Boolean(parsed.data.token) };
});

/** Signs a CLI provider out: credential directory emptied, stored token gone. */
app.delete<{ Params: { id: string }; Querystring: { workspace?: string } }>(
  "/api/providers/:id/credentials",
  async (request, reply) => {
    const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });

    const id = request.params.id;
    if (id !== "claude" && id !== "codex") return reply.code(404).send({ error: "unknown provider" });
    const subject = await providerSubject(principal.userId, request.query.workspace, "credentials.manage");
    if (!subject) return reply.code(403).send({ error: "only a workspace admin can sign its subscription out" });

    await providerService.signOut(subject, id);
    sessionQuotaCache.delete(subject);
    return reply.code(204).send();
  },
);

const DefaultProviderBody = z.object({
  /** null clears the choice, so the native loop applies again. */
  provider: ProviderId.nullable(),
});

app.put("/api/settings/default-provider", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const parsed = DefaultProviderBody.safeParse(request.body);
  if (!parsed.success) return reply.code(400).send({ error: "a provider id or null is required" });

  await db
    .update(users)
    .set({ defaultProvider: parsed.data.provider })
    .where(eq(users.id, principal.userId));

  return { defaultProvider: parsed.data.provider ?? "native" };
});

// -- GitHub ------------------------------------------------------------------

/**
 * A GitHub failure as a reply.
 *
 * `GithubError` already carries the status the caller should see -- a rejected
 * token is 401, an unreadable repository 404, a rate limit 429 -- so this is
 * only the translation. Anything else is ours and is logged as such rather
 * than blamed on GitHub.
 */
function githubFailure(
  error: unknown,
  reply: { code(status: number): { send(body: unknown): unknown } },
) {
  if (error instanceof GithubError) return reply.code(error.status).send({ error: error.message });
  app.log.error({ err: error }, "github call failed");
  return reply.code(502).send({ error: "GitHub could not be reached." });
}

/**
 * The account that a token belongs to, and the repositories it can see.
 *
 * One route for both, because the dialog wants both at once and the login is
 * what tells the reader *whose* repositories they are looking at -- a stale
 * token for an account they have stopped using otherwise looks like a
 * repository list that is simply missing things.
 *
 * The 412 is the interesting reply: no token at all is not an error, it is the
 * state the GitHub tab renders as "connect one in Settings".
 */
app.get("/api/github/repos", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const token = await githubTokenFor(principal.userId);
  if (!token) {
    return reply
      .code(412)
      .send({ error: "No GitHub token is configured.", needsToken: true });
  }

  try {
    const [account, repos] = await Promise.all([identify(token), listRepos(token)]);
    return { account, repos };
  } catch (error) {
    return githubFailure(error, reply);
  }
});

/**
 * One repository's branches, through the API rather than `ls-remote`.
 *
 * The GitHub tab has a token and a repository it was told about by GitHub, so
 * the API is both cheaper than spawning git and the only thing that works for
 * a private repository without putting credentials on a command line.
 */
app.get<{ Params: { owner: string; repo: string } }>(
  "/api/github/repos/:owner/:repo/branches",
  async (request, reply) => {
    const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });

    const token = await githubTokenFor(principal.userId);
    if (!token) {
      return reply.code(412).send({ error: "No GitHub token is configured.", needsToken: true });
    }

    try {
      return await listBranches(token, request.params.owner, request.params.repo);
    } catch (error) {
      return githubFailure(error, reply);
    }
  },
);

/**
 * OpenRouter's catalogue, for the model picker.
 *
 * Cached in memory: it changes daily at most, and the picker is opened far
 * more often than that. A failed fetch serves the last good list rather than
 * emptying the picker.
 */
app.get("/api/models", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  // The cache lives in `openrouter.ts` now: the agent needs the same
  // catalogue to read each model's window before deciding to compact, and
  // two caches would have meant two answers to the same question.
  // The account's default rather than the server's, so a new conversation
  // opens on the model chosen in Settings. This is the one place the composer
  // reads it from, which is why setting it there needs nothing else wired up.
  const defaultModel = await defaultModelFor(principal.userId);

  try {
    return { models: await catalogue(), defaultModel };
  } catch (error) {
    app.log.warn({ err: error }, "could not refresh the model catalogue");
    const stale = cachedCatalogue();
    if (!stale) return reply.code(502).send({ error: "model catalogue unavailable" });
    return { models: stale, defaultModel };
  }
});

// -- Threads -----------------------------------------------------------------

app.get<{ Params: { hash: string } }>("/api/projects/:hash/threads", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const project = await workspaceService.findByHash(request.params.hash, principal.userId);
  if (!project) return reply.code(404).send({ error: "project not found" });

  const rows = await db
    .select({
      id: threads.id,
      hash: threads.hash,
      title: threads.title,
      status: threads.status,
      provider: threads.provider,
      baseBranch: threads.baseBranch,
      branch: threads.branch,
      worktreeState: threads.worktreeState,
      worktreeError: threads.worktreeError,
      createdAt: threads.createdAt,
    })
    .from(threads)
    .where(eq(threads.projectId, project.id))
    .orderBy(desc(threads.createdAt));

  return { threads: rows };
});

/**
 * Removes a project session. By default it settles it: any uncommitted
 * edits are committed and its branch pushed to origin first, and if that
 * cannot happen nothing is removed (409, with why). With `?ifEmpty=1` it is
 * only removed when it has nothing in it -- what the web app asks when a
 * session is left -- and is otherwise left alone.
 */
app.delete<{ Params: { hash: string; sessionHash: string }; Querystring: { ifEmpty?: string } }>(
  "/api/projects/:hash/sessions/:sessionHash",
  async (request, reply) => {
    const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });

    const project = await workspaceService.findByHash(request.params.hash, principal.userId);
    if (!project) return reply.code(404).send({ error: "project not found" });
    if (!can(project.membership, "project.write")) {
      return reply.code(403).send({ error: "you cannot change this project" });
    }
    if (!ThreadHash.safeParse(request.params.sessionHash).success) {
      return reply.code(404).send({ error: "session not found" });
    }
    const [session] = await db
      .select(SESSION_COLUMNS)
      .from(threads)
      .where(and(eq(threads.hash, request.params.sessionHash), eq(threads.projectId, project.id)))
      .limit(1);
    if (!session) return reply.code(404).send({ error: "session not found" });

    const record = (summary: string) =>
      audit
        .record({
          projectId: project.id,
          userId: principal.userId,
          clientId: clientIdOf(request),
          action: "session.remove",
          targetType: "session",
          targetId: session.hash,
          summary,
        })
        .catch((error) => app.log.error({ err: error }, "could not log a removed session"));

    try {
      if (request.query.ifEmpty === "1") {
        const removed = await sessionLifecycle.removeIfEmpty(session);
        if (removed) await record("Removed an empty session");
        return { removed, pushed: null };
      }
      const { pushed } = await sessionLifecycle.settle(session);
      await record(pushed ? `Settled “${session.title}”, its work pushed to ${pushed}` : `Settled “${session.title}”`);
      return { removed: true, pushed };
    } catch (error) {
      if (error instanceof SessionBusyError || error instanceof SessionUnsavedError) {
        return reply.code(409).send({ error: error.message });
      }
      throw error;
    }
  },
);

// -- Password login ----------------------------------------------------------

const Credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

app.post("/api/auth/login", {
  config: {
    // Per address: twenty tries a minute is far more than a person mistyping
    // and far less than a guesser, whether it aims at one account or sprays
    // one password across many. scrypt was the only brake before this.
    rateLimit: { max: 20, timeWindow: "1 minute" },
  },
}, async (request, reply) => {
  const parsed = Credentials.safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "email and password are required" });
  }

  const userId = await auth.verifyCredentials(parsed.data.email, parsed.data.password);
  if (!userId) {
    // One message for both "no such user" and "wrong password": distinguishing
    // them would let an unauthenticated caller enumerate registered addresses.
    return reply.code(401).send({ error: "invalid email or password" });
  }

  const session = await auth.createSession(userId, ["read", "write", "exec", "admin"]);
  reply.setCookie(SESSION_COOKIE, session, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    path: "/",
    maxAge: 30 * 24 * 60 * 60,
  });

  return { ok: true, userId };
});

// -- GitHub OAuth ------------------------------------------------------------

app.get("/api/auth/github", async (request, reply) => {
  if (config.DEV_AUTH_BYPASS) return reply.redirect("/");

  // Without this, an unset client id is interpolated as the string
  // "undefined" and the user lands on a GitHub error page with no clue why.
  if (!config.GITHUB_CLIENT_ID || !config.GITHUB_CLIENT_SECRET) {
    return reply
      .code(503)
      .type("text/plain")
      .send("GitHub sign-in is not configured on this server. Set GITHUB_CLIENT_ID and GITHUB_CLIENT_SECRET, or sign in with email and password.");
  }

  const state = randomBytes(16).toString("base64url");
  reply.setCookie(OAUTH_STATE_COOKIE, state, {
    httpOnly: true,
    sameSite: "lax",
    secure: secureCookies,
    path: "/",
    maxAge: 600,
  });

  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", config.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", `${publicOrigin()}/api/auth/github/callback`);
  // `repo` is required to clone and push private repositories, which is the
  // whole point of the harness.
  // `read:org` only when sign-in depends on organisation membership, which
  // GitHub will not report for a private membership without it.
  url.searchParams.set("scope", config.GITHUB_ALLOWED_ORGS.length ? "repo read:user read:org" : "repo read:user");
  url.searchParams.set("state", state);
  return reply.redirect(url.toString());
});

app.get<{ Querystring: { code?: string; state?: string } }>(
  "/api/auth/github/callback",
  async (request, reply) => {
    const { code, state } = request.query;
    const expected = request.cookies[OAUTH_STATE_COOKIE];
    reply.clearCookie(OAUTH_STATE_COOKIE, { path: "/" });

    // CSRF: without this check an attacker could complete the flow in the
    // victim's browser and bind their own GitHub account to it.
    if (!code || !state || !expected || state !== expected) {
      return reply.code(400).send({ error: "invalid oauth state" });
    }

    const tokenResponse = await fetch("https://github.com/login/oauth/access_token", {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        client_id: config.GITHUB_CLIENT_ID,
        client_secret: config.GITHUB_CLIENT_SECRET,
        code,
        redirect_uri: `${publicOrigin()}/api/auth/github/callback`,
      }),
    });

    const token = (await tokenResponse.json()) as { access_token?: string; error?: string };
    if (!token.access_token) {
      request.log.warn({ error: token.error }, "github token exchange failed");
      return reply.code(400).send({ error: "oauth exchange failed" });
    }

    const userResponse = await fetch("https://api.github.com/user", {
      headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json" },
    });
    if (!userResponse.ok) return reply.code(400).send({ error: "could not read github profile" });

    const profile = (await userResponse.json()) as {
      id: number;
      login: string;
      name: string | null;
      avatar_url: string | null;
    };

    if (!config.SECRET_KEY) {
      return reply.code(500).send({ error: "SECRET_KEY is required to store GitHub credentials" });
    }

    const admitted = await admitGithubUser(
      { allowedUsers: config.GITHUB_ALLOWED_USERS, allowedOrgs: config.GITHUB_ALLOWED_ORGS },
      {
        login: profile.login,
        existing: await auth.hasGithubUser(String(profile.id)),
        isOrgMember: async (org) => {
          const response = await fetch(
            `https://api.github.com/user/memberships/orgs/${encodeURIComponent(org)}`,
            { headers: { authorization: `Bearer ${token.access_token}`, accept: "application/vnd.github+json" } },
          );
          if (!response.ok) return false;
          const membership = (await response.json()) as { state?: string };
          return membership.state === "active";
        },
      },
    );
    if (!admitted) {
      request.log.warn({ login: profile.login }, "github sign-in refused: not on the allowlist");
      return reply
        .code(403)
        .type("text/plain")
        .send("This GitHub account is not allowed to sign in here. Ask the operator to add it to GITHUB_ALLOWED_USERS or GITHUB_ALLOWED_ORGS.");
    }

    const userId = await auth.upsertGithubUser({
      githubId: String(profile.id),
      login: profile.login,
      name: profile.name,
      avatarUrl: profile.avatar_url,
      accessTokenEncrypted: encryptSecret(token.access_token, config.SECRET_KEY),
    });

    await workspaceService.ensureDefault(userId);

    const session = await auth.createSession(userId, ["read", "write", "exec", "admin"]);
    reply.setCookie(SESSION_COOKIE, session, {
      httpOnly: true,
      sameSite: "lax",
      secure: secureCookies,
      path: "/",
      maxAge: 30 * 24 * 60 * 60,
    });

    return reply.redirect("/");
  },
);

app.post("/api/auth/logout", async (request, reply) => {
  const token = request.cookies[SESSION_COOKIE];
  if (token) gateway.closeSession(await auth.revokeSession(token));
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});

// -- WebSocket upgrade -------------------------------------------------------

app.server.on("upgrade", (request, socket, head) => {
  // A preview host's upgrades (Vite HMR, say) belong to the dev server.
  if (preview.handleUpgrade(request, socket, head)) return;

  const url = new URL(request.url ?? "/", "http://localhost");
  if (url.pathname !== "/ws") {
    socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
    socket.destroy();
    return;
  }
  gateway.handleUpgrade(request, socket, head);
});

function publicOrigin(): string {
  return `${config.PUBLIC_SCHEME}://${config.ROOT_DOMAIN}`;
}

// -- Boot --------------------------------------------------------------------

/**
 * The bypass principal is a real row, not a synthetic id: projects carry a
 * foreign key to `users`, so a fabricated user id would fail on first insert.
 */
if (config.DEV_AUTH_BYPASS) {
  await db
    .insert(users)
    .values({ id: DEV_USER_ID, githubId: "dev", login: "dev", name: "Local Developer" })
    .onConflictDoNothing();
  app.log.warn("DEV_AUTH_BYPASS is enabled: every connection is authenticated as the local dev user");
}

/**
 * The default account, so a fresh install has a way in before any GitHub App
 * is configured. Creation is skipped when the email already exists, so a
 * changed password is never reset by a restart.
 */
if (config.DEFAULT_USER_EMAIL && config.DEFAULT_USER_PASSWORD) {
  const { id, created } = await auth.ensurePasswordUser({
    email: config.DEFAULT_USER_EMAIL,
    password: config.DEFAULT_USER_PASSWORD,
    login: config.DEFAULT_USER_EMAIL.split("@")[0]!,
    name: "Danial Irfan",
  });
  await workspaceService.ensureDefault(id);
  if (created) {
    app.log.warn(
      { email: config.DEFAULT_USER_EMAIL },
      "created the default account -- change its password before exposing this server",
    );
  }
}


const shutdown = async (signal: string) => {
  app.log.info({ signal }, "shutting down");
  gateway.close();
  await engine.worker.stop();
  // After the engine: a command still in the queue can still queue a clone.
  await clones.worker.stop();
  // Shells do not survive the server that spawned them, and nor do CLI
  // turns: SIGTERM here, so the CLI records nothing and resumes the
  // unfinished turn next time, rather than the SIGINT the stop button sends.
  terminals.closeAll();
  await agentTurns.killAll();
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

// Longer than Traefik's idle timeout, so the proxy closes a pooled connection
// before Node does and never sends a request down a socket being torn down.
app.server.keepAliveTimeout = 65_000;
app.server.headersTimeout = 66_000;

await app.listen({ port: config.PORT, host: config.HOST });

// Every project keeps its knowledge in `.ucch/`, and projects made before
// that did not get the folder at creation. Each turn fills it in too; this is
// for the projects nobody has opened a chat in. Checkouts only: a clone still
// queued must find its directory empty.
void (async () => {
  const rows = await db.select({ id: projects.id, name: projects.name }).from(projects);
  for (const row of rows) {
    const dir = join(config.WORKSPACE_ROOT, row.id);
    if (!existsSync(join(dir, ".git"))) continue;
    await ensureProjectInfo(dir, renderDefaultInfo(row.name)).catch((err: unknown) =>
      app.log.warn({ err, projectId: row.id }, "could not write .ucch/INFO.md"),
    );
  }
})().catch((err: unknown) => app.log.warn({ err }, ".ucch backfill failed"));
app.log.info(
  {
    rootDomain: config.ROOT_DOMAIN,
    devAuthBypass: config.DEV_AUTH_BYPASS,
    devUser: config.DEV_AUTH_BYPASS ? DEV_USER_ID : undefined,
  },
  "ucch server ready",
);
