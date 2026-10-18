import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  CreateDatabaseBody,
  DatabaseConnectionCreate,
  DatabaseConnectionUpdate,
  DbName,
  type WorkspacePermission,
} from "@ucch/protocol";
import { decryptSecret } from "./crypto.js";
import type { DatabaseConnectionService } from "./database-connections.js";
import type { ProbeTarget } from "./database-probe.js";
import { DbConnectError, DbQueryError, DbRefusal, type DbAdapter, type DbTarget } from "./db-manager/index.js";

type Principal = { userId: string };

export interface DatabaseRouteDeps {
  /** Who is asking, from the request's cookies, or null. */
  principalFor(cookies: Record<string, string | undefined>): Promise<Principal | null>;
  /** Whether the workspace exists and this user's role in it allows `permission` -- one predicate, on purpose. */
  workspaceAllows(workspaceId: string, userId: string, permission: WorkspacePermission): Promise<boolean>;
  connections: DatabaseConnectionService;
  /** `SECRET_KEY`; without it no password can be stored, so no connection can be. */
  secretKey: string | undefined;
  probe(target: ProbeTarget): Promise<void>;
  /** The server itself, with no database chosen: for listing, making and dropping them. */
  adapterFor(target: DbTarget, db: null): DbAdapter;
}

const NO_SECRET_KEY = "SECRET_KEY is not configured, so a database password cannot be stored safely";

/**
 * Saved database servers and the live list of databases behind each one.
 *
 * Creation tests the credentials first: a connection that cannot connect is
 * a typo, not a record, and the dialog is the place to find that out. The
 * password leaves the database only inside `/databases`, for the duration of
 * one query.
 */
export function registerDatabaseRoutes(app: FastifyInstance, deps: DatabaseRouteDeps): void {
  app.get<{ Params: { id: string } }>(
    "/api/workspaces/:id/database-connections",
    async (request, reply) => {
      const principal = await deps.principalFor(request.cookies);
      if (!principal) return reply.code(401).send({ error: "unauthorized" });
      if (!(await deps.workspaceAllows(request.params.id, principal.userId, "workspace.view"))) {
        return reply.code(404).send({ error: "workspace not found" });
      }
      return { connections: await deps.connections.list(request.params.id) };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/workspaces/:id/database-connections",
    async (request, reply) => {
      const principal = await deps.principalFor(request.cookies);
      if (!principal) return reply.code(401).send({ error: "unauthorized" });
      const parsed = DatabaseConnectionCreate.safeParse(request.body);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return reply
          .code(400)
          .send({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body" });
      }
      if (!(await deps.workspaceAllows(request.params.id, principal.userId, "workspace.manage"))) {
        return reply.code(404).send({ error: "workspace not found" });
      }
      if (!deps.secretKey) return reply.code(409).send({ error: NO_SECRET_KEY });

      const input = parsed.data;
      try {
        await deps.probe({ ...input, database: input.database || null });
      } catch (error) {
        if (error instanceof DbConnectError || error instanceof DbQueryError) {
          request.log.info(
            { engine: input.engine, host: input.host, port: input.port, reason: error.message },
            "database connection test failed",
          );
          return reply.code(422).send({ error: `Could not connect: ${error.message}` });
        }
        throw error;
      }

      const connection = await deps.connections.create(request.params.id, input, deps.secretKey);
      return reply.code(201).send({ connection });
    },
  );

  app.get<{ Params: { id: string } }>("/api/database-connections/:id", async (request, reply) => {
    const principal = await deps.principalFor(request.cookies);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const row = await deps.connections.findForUser(request.params.id, principal.userId);
    if (!row) return reply.code(404).send({ error: "connection not found" });
    const { passwordEncrypted: _secret, ...rest } = row;
    return { connection: { ...rest, createdAt: row.createdAt.toISOString() } };
  });

  /**
   * Change a saved connection. Like creation, the credentials as they will
   * be -- stored ones with the change laid over -- are tested before they
   * are kept, so a typo in the host is found here and not on the next open.
   */
  app.patch<{ Params: { id: string } }>("/api/database-connections/:id", async (request, reply) => {
    const principal = await deps.principalFor(request.cookies);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const parsed = DatabaseConnectionUpdate.safeParse(request.body);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      return reply.code(400).send({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid body" });
    }
    const row = await deps.connections.findForUser(request.params.id, principal.userId);
    if (!row) return reply.code(404).send({ error: "connection not found" });
    if (!deps.secretKey) return reply.code(409).send({ error: NO_SECRET_KEY });

    const input = parsed.data;
    let password = input.password;
    if (password === undefined) {
      try {
        password = decryptSecret(row.passwordEncrypted, deps.secretKey);
      } catch {
        return reply.code(409).send({ error: "the stored password cannot be read; enter a new one" });
      }
    }
    const target: ProbeTarget = {
      engine: (input.engine ?? row.engine) as ProbeTarget["engine"],
      host: input.host ?? row.host,
      port: input.port ?? row.port,
      username: input.username ?? row.username,
      password,
      database: input.database !== undefined ? input.database || null : row.database,
    };
    try {
      await deps.probe(target);
    } catch (error) {
      if (error instanceof DbConnectError || error instanceof DbQueryError) {
        request.log.info({ engine: target.engine, host: target.host, port: target.port, reason: error.message }, "database connection test failed");
        return reply.code(422).send({ error: `Could not connect: ${error.message}` });
      }
      throw error;
    }

    const connection = await deps.connections.update(row, input, deps.secretKey);
    return { connection };
  });

  /**
   * Auth, ownership, decryption and error mapping for anything asked of the
   * server as a whole, the way the manager routes do it for one database.
   */
  async function withServer(
    request: FastifyRequest<{ Params: { id: string } }>,
    reply: FastifyReply,
    fn: (adapter: DbAdapter) => Promise<unknown>,
  ): Promise<unknown> {
    const principal = await deps.principalFor(request.cookies);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const row = await deps.connections.findForUser(request.params.id, principal.userId);
    if (!row) return reply.code(404).send({ error: "connection not found" });
    if (!deps.secretKey) return reply.code(409).send({ error: NO_SECRET_KEY });

    let password: string;
    try {
      password = decryptSecret(row.passwordEncrypted, deps.secretKey);
    } catch {
      // Encrypted under a SECRET_KEY that has since changed.
      return reply.code(409).send({ error: "the stored password cannot be read; remove and add the connection again" });
    }
    const adapter = deps.adapterFor(
      { engine: row.engine as ProbeTarget["engine"], host: row.host, port: row.port, username: row.username, password, database: row.database },
      null,
    );

    try {
      return await fn(adapter);
    } catch (error) {
      if (error instanceof ZodError) {
        const issue = error.issues[0];
        return reply.code(400).send({ error: issue ? `${issue.path.join(".") || "body"}: ${issue.message}` : "invalid request" });
      }
      if (error instanceof DbRefusal) return reply.code(422).send({ error: error.message });
      if (error instanceof DbQueryError) return reply.code(400).send({ error: error.message, code: error.code });
      if (error instanceof DbConnectError) {
        request.log.info({ engine: row.engine, host: row.host, port: row.port, reason: error.message }, "database request failed");
        return reply.code(502).send({ error: `Could not connect: ${error.message}` });
      }
      throw error;
    }
  }

  // The sidebar wants names; the connection page wants sizes too. One
  // round trip serves both.
  app.get<{ Params: { id: string } }>("/api/database-connections/:id/databases", (request, reply) =>
    withServer(request, reply, async (adapter) => {
      const details = await adapter.describeDatabases();
      return { databases: details.map((d) => d.name), details };
    }),
  );

  app.post<{ Params: { id: string } }>("/api/database-connections/:id/databases", (request, reply) =>
    withServer(request, reply, async (adapter) => {
      await adapter.createDatabase(CreateDatabaseBody.parse(request.body).name);
      return reply.code(201).send({ ok: true });
    }),
  );

  app.delete<{ Params: { id: string; db: string } }>("/api/database-connections/:id/databases/:db", (request, reply) =>
    withServer(request, reply, async (adapter) => {
      await adapter.dropDatabase(DbName.parse(request.params.db));
      return reply.code(204).send();
    }),
  );

  app.delete<{ Params: { id: string } }>("/api/database-connections/:id", async (request, reply) => {
    const principal = await deps.principalFor(request.cookies);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const removed = await deps.connections.remove(request.params.id, principal.userId);
    if (!removed) return reply.code(404).send({ error: "connection not found" });
    return reply.code(204).send();
  });
}
