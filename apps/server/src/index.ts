import { randomBytes } from "node:crypto";
import cookie from "@fastify/cookie";
import Fastify from "fastify";
import { z } from "zod";
import { createDatabase, runMigrations, users } from "@ucch/db";
import type { Command } from "@ucch/protocol";
import { AuthService, DEV_USER_ID } from "./auth.js";
import { EventBus } from "./bus.js";
import { loadConfig } from "./config.js";
import { OrchestrationEngine, type Reactors } from "./engine.js";
import { EventStore } from "./eventstore.js";
import { WebSocketGateway } from "./ws.js";
import { WorkspaceService } from "./workspaces.js";
import { encryptSecret } from "./crypto.js";

const config = loadConfig();

// Before anything else touches the database. Idempotent, so it runs on every
// boot and a fresh deployment needs no separate migration step.
await runMigrations(config.DATABASE_URL);

const db = createDatabase(config.DATABASE_URL);
const bus = new EventBus();
const store = new EventStore(db, bus);
const auth = new AuthService(db, config);
const workspaceService = new WorkspaceService(db);

/**
 * Phase 1 has no side effects to dispatch yet -- the container, checkpoint,
 * preview, and agent reactors arrive in later phases. Decisions are already
 * recorded in the log, so wiring them up is additive.
 */
const reactors: Reactors = {
  react(command: Command) {
    app.log.debug({ command: command.type }, "reactor dispatch (not yet implemented)");
  },
};

const engine = new OrchestrationEngine(db, store, reactors, (error, command) => {
  app.log.error({ err: error, command: command.type }, "command failed");
});
const gateway = new WebSocketGateway(auth, engine, store, bus);

const app = Fastify({
  logger: { level: config.NODE_ENV === "production" ? "info" : "debug" },
  trustProxy: true,
});

await app.register(cookie);

const SESSION_COOKIE = "ucch_session";
const OAUTH_STATE_COOKIE = "ucch_oauth_state";
const secureCookies = config.PUBLIC_SCHEME === "https";

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
  };
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

  const parsed = z.object({ name: z.string().trim().min(1).max(60) }).safeParse(request.body);
  if (!parsed.success) {
    return reply.code(400).send({ error: "a workspace name of 1-60 characters is required" });
  }

  const created = await workspaceService.create(principal.userId, parsed.data.name);
  if ("conflict" in created) {
    return reply.code(409).send({ error: "too many workspaces with a similar name" });
  }
  return reply.code(201).send(created);
});

app.get<{ Params: { id: string } }>("/api/workspaces/:id/projects", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const projects = await workspaceService.listProjects(request.params.id, principal.userId);
  // null means "not yours or not there" -- reported the same way, because
  // whether a workspace exists is itself privileged.
  if (!projects) return reply.code(404).send({ error: "workspace not found" });
  return { projects };
});

app.get<{ Params: { hash: string } }>("/api/projects/:hash", async (request, reply) => {
  const principal = await auth.resolveSession(request.cookies[SESSION_COOKIE]);
  if (!principal) return reply.code(401).send({ error: "unauthorized" });

  const project = await workspaceService.findByHash(request.params.hash, principal.userId);
  if (!project) return reply.code(404).send({ error: "project not found" });
  return project;
});

// -- Password login ----------------------------------------------------------

const Credentials = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

app.post("/api/auth/login", async (request, reply) => {
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
  url.searchParams.set("scope", "repo read:user");
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
  if (token) await auth.revokeSession(token);
  reply.clearCookie(SESSION_COOKIE, { path: "/" });
  return { ok: true };
});

// -- WebSocket upgrade -------------------------------------------------------

app.server.on("upgrade", (request, socket, head) => {
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
  await app.close();
  process.exit(0);
};
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));

await app.listen({ port: config.PORT, host: config.HOST });
app.log.info(
  {
    rootDomain: config.ROOT_DOMAIN,
    devAuthBypass: config.DEV_AUTH_BYPASS,
    devUser: config.DEV_AUTH_BYPASS ? DEV_USER_ID : undefined,
  },
  "ucch server ready",
);
