import { Readable } from "node:stream";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { ZodError } from "zod";
import {
  AddColumnBody,
  CreateTableBody,
  CreateUserBody,
  DbName,
  DropUserQuery,
  ExistingName,
  ExportQuery,
  GrantBody,
  ImportQuery,
  IndexSpec,
  ModifyColumnBody,
  RenameTableBody,
  RowDeleteBody,
  RowInsertBody,
  RowUpdateBody,
  RowsQuery,
  SqlBody,
  type ImportResult,
  type TableDetail,
} from "@ucch/protocol";
import { decryptSecret } from "./crypto.js";
import type { DatabaseConnectionService } from "./database-connections.js";
import { DbConnectError, DbQueryError, DbRefusal, RowConflictError, type DbAdapter, type DbTarget } from "./db-manager/index.js";
import { parseCsv } from "./db-manager/csv.js";
import { csvDump, sqlDump } from "./db-manager/dump.js";
import { splitStatements } from "./db-manager/sql-split.js";
import { contentDisposition } from "./uploads.js";

type Principal = { userId: string };

/**
 * A dump that always ends. The headers are gone by the time a table is
 * read, so an error partway cannot become a status code; left to itself
 * it left the chunked response open and the download spinning. It becomes
 * the last line of the file instead, where the person opening it will see
 * it, and the stream closes.
 */
async function* finishing(
  generator: AsyncIterable<string>,
  format: "sql" | "csv",
  request: FastifyRequest,
): AsyncGenerator<string> {
  try {
    yield* generator;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    request.log.warn({ err: error }, "export failed partway");
    yield format === "csv" ? `\n"export failed: ${message.replace(/"/g, '""')}"\n` : `\n-- export failed: ${message.replace(/\n/g, " ")}\n`;
  }
}

export interface DbManagerRouteDeps {
  principalFor(cookies: Record<string, string | undefined>): Promise<Principal | null>;
  connections: DatabaseConnectionService;
  secretKey: string | undefined;
  adapterFor(target: DbTarget, db: string): DbAdapter;
}

type DbParams = { id: string; db: string };
type TableParams = DbParams & { table: string };

const NO_SECRET_KEY = "SECRET_KEY is not configured, so the stored password cannot be read";

/**
 * The database views: structure, rows, SQL, import/export, users -- every
 * one under `/api/database-connections/:id/db/:db`.
 *
 * All of it runs on the user's own server with the user's own stored
 * credentials; what the routes guard is *which* server (the ownership
 * check on `:id`), not what may be asked of it. Errors keep the engine's
 * own words, since "column x of relation y does not exist" is the answer.
 */
export function registerDbManagerRoutes(app: FastifyInstance, deps: DbManagerRouteDeps): void {
  /** Auth, ownership, decryption and error mapping, once. */
  async function withAdapter(
    request: FastifyRequest<{ Params: DbParams }>,
    reply: FastifyReply,
    fn: (adapter: DbAdapter, db: string) => Promise<unknown>,
  ): Promise<unknown> {
    const params = request.params as DbParams;
    const principal = await deps.principalFor(request.cookies);
    if (!principal) return reply.code(401).send({ error: "unauthorized" });
    const row = await deps.connections.findForUser(params.id, principal.userId);
    if (!row) return reply.code(404).send({ error: "connection not found" });
    if (!deps.secretKey) return reply.code(409).send({ error: NO_SECRET_KEY });
    const db = DbName.safeParse(params.db);
    if (!db.success) return reply.code(400).send({ error: "invalid database name" });

    let password: string;
    try {
      password = decryptSecret(row.passwordEncrypted, deps.secretKey);
    } catch {
      return reply.code(409).send({ error: "the stored password cannot be read; remove and add the connection again" });
    }
    const adapter = deps.adapterFor(
      { engine: row.engine as DbTarget["engine"], host: row.host, port: row.port, username: row.username, password, database: row.database },
      db.data,
    );

    try {
      return await fn(adapter, db.data);
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

  const base = "/api/database-connections/:id/db/:db";

  // --- structure -----------------------------------------------------------

  app.get<{ Params: DbParams }>(`${base}/tables`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => ({ tables: await adapter.listTables() })),
  );

  app.get<{ Params: TableParams }>(`${base}/tables/:table`, (request, reply) =>
    withAdapter(request, reply, (adapter) => adapter.describeTable(ExistingName.parse(request.params.table))),
  );

  app.get<{ Params: TableParams }>(`${base}/tables/:table/create-sql`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => ({ sql: await adapter.createTableSql(ExistingName.parse(request.params.table)) })),
  );

  app.post<{ Params: DbParams }>(`${base}/tables`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      await adapter.createTable(CreateTableBody.parse(request.body));
      return reply.code(201).send({ ok: true });
    }),
  );

  app.patch<{ Params: TableParams }>(`${base}/tables/:table`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      await adapter.renameTable(ExistingName.parse(request.params.table), RenameTableBody.parse(request.body).name);
      return reply.code(204).send();
    }),
  );

  app.delete<{ Params: TableParams }>(`${base}/tables/:table`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      await adapter.dropTable(ExistingName.parse(request.params.table));
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: TableParams }>(`${base}/tables/:table/truncate`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      await adapter.truncateTable(ExistingName.parse(request.params.table));
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: TableParams }>(`${base}/tables/:table/columns`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      await adapter.addColumn(ExistingName.parse(request.params.table), AddColumnBody.parse(request.body));
      return reply.code(201).send({ ok: true });
    }),
  );

  app.patch<{ Params: TableParams & { column: string } }>(`${base}/tables/:table/columns/:column`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      await adapter.modifyColumn(
        ExistingName.parse(request.params.table),
        ExistingName.parse(request.params.column),
        ModifyColumnBody.parse(request.body).column,
      );
      return reply.code(204).send();
    }),
  );

  app.delete<{ Params: TableParams & { column: string } }>(`${base}/tables/:table/columns/:column`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      await adapter.dropColumn(ExistingName.parse(request.params.table), ExistingName.parse(request.params.column));
      return reply.code(204).send();
    }),
  );

  app.post<{ Params: TableParams }>(`${base}/tables/:table/indexes`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      await adapter.addIndex(ExistingName.parse(request.params.table), IndexSpec.parse(request.body));
      return reply.code(201).send({ ok: true });
    }),
  );

  app.delete<{ Params: TableParams & { index: string } }>(`${base}/tables/:table/indexes/:index`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      await adapter.dropIndex(ExistingName.parse(request.params.table), ExistingName.parse(request.params.index));
      return reply.code(204).send();
    }),
  );

  // --- rows ----------------------------------------------------------------

  app.get<{ Params: TableParams; Querystring: Record<string, string> }>(`${base}/tables/:table/rows`, (request, reply) =>
    withAdapter(request, reply, (adapter) => adapter.browse(ExistingName.parse(request.params.table), RowsQuery.parse(request.query))),
  );

  app.post<{ Params: TableParams }>(`${base}/tables/:table/rows`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      const result = await adapter.insertRow(ExistingName.parse(request.params.table), RowInsertBody.parse(request.body).values);
      return reply.code(201).send(result);
    }),
  );

  app.patch<{ Params: TableParams }>(`${base}/tables/:table/rows`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      const body = RowUpdateBody.parse(request.body);
      try {
        await adapter.updateRow(ExistingName.parse(request.params.table), body.key, body.values, body.original);
      } catch (error) {
        if (error instanceof RowConflictError) return reply.code(409).send({ error: error.message, row: error.row });
        throw error;
      }
      return { ok: true };
    }),
  );

  app.delete<{ Params: TableParams }>(`${base}/tables/:table/rows`, (request, reply) =>
    withAdapter(request, reply, (adapter) => adapter.deleteRows(ExistingName.parse(request.params.table), RowDeleteBody.parse(request.body).keys)),
  );

  // --- sql -----------------------------------------------------------------

  app.post<{ Params: DbParams }>(`${base}/sql`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      const body = SqlBody.parse(request.body);
      return { results: await adapter.runSql(body.sql, { maxRows: body.maxRows, continueOnError: body.continueOnError }) };
    }),
  );

  // --- export / import -------------------------------------------------------

  app.get<{ Params: DbParams; Querystring: Record<string, string> }>(`${base}/export`, (request, reply) =>
    withAdapter(request, reply, async (adapter, db) => {
      const query = ExportQuery.parse(request.query);
      const wanted = query.tables
        ?.split(",")
        .map((t) => t.trim())
        .filter(Boolean);
      const names = wanted && wanted.length > 0 ? wanted : (await adapter.listTables()).map((t) => t.name);
      if (query.format === "csv" && names.length !== 1) throw new DbRefusal("a CSV export is one table at a time");
      const tables: TableDetail[] = [];
      for (const name of names) tables.push(await adapter.describeTable(ExistingName.parse(name)));

      const stem = names.length === 1 ? `${db}-${names[0]}` : db;
      const generator = query.format === "csv" ? csvDump(adapter, tables[0]!) : sqlDump(adapter, db, tables, query);
      const stream = Readable.from(finishing(generator, query.format, request));
      request.raw.on("close", () => stream.destroy());
      return reply
        .header("content-type", query.format === "csv" ? "text/csv; charset=utf-8" : "application/sql; charset=utf-8")
        .header("content-disposition", contentDisposition(`${stem}.${query.format}`))
        .header("cache-control", "private, no-store")
        .send(stream);
    }),
  );

  app.post<{ Params: DbParams; Querystring: Record<string, string> }>(`${base}/import`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      if (!Buffer.isBuffer(request.body)) return reply.code(415).send({ error: "send the file as application/octet-stream" });
      const query = ImportQuery.parse(request.query);
      const text = request.body.toString("utf8").replace(/^﻿/, "");
      const started = performance.now();

      if (query.format === "csv") {
        if (!query.table) throw new DbRefusal("a CSV import needs a target table");
        const rows = parseCsv(text);
        const header = rows.shift();
        if (!header || header.length === 0) throw new DbRefusal("the CSV has no header row");
        const { inserted } = await adapter.importCsv(query.table, header, rows, { emptyAsNull: query.emptyAsNull });
        const result: ImportResult = { format: "csv", inserted, durationMs: Math.round(performance.now() - started) };
        return result;
      }

      const statements = splitStatements(text, adapter.engine);
      const results = await adapter.runSql(text, { maxRows: 1, continueOnError: query.continueOnError, timeoutMs: 0 });
      const failedAt = results.findIndex((r) => r.error);
      const result: ImportResult = {
        format: "sql",
        statements: statements.length,
        executed: results.filter((r) => !r.error).length,
        durationMs: Math.round(performance.now() - started),
        ...(failedAt === -1 ? {} : { failed: { index: failedAt, statement: results[failedAt]!.statement, error: results[failedAt]!.error! } }),
      };
      return result;
    }),
  );

  // --- users -----------------------------------------------------------------

  app.get<{ Params: DbParams }>(`${base}/users`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => ({ users: await adapter.listUsers() })),
  );

  app.post<{ Params: DbParams }>(`${base}/users`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      const body = CreateUserBody.parse(request.body);
      await adapter.createUser(body.name, body.password, body.host);
      return reply.code(201).send({ ok: true });
    }),
  );

  app.delete<{ Params: DbParams & { name: string }; Querystring: Record<string, string> }>(`${base}/users/:name`, (request, reply) =>
    withAdapter(request, reply, async (adapter) => {
      const query = DropUserQuery.parse(request.query);
      await adapter.dropUser(ExistingName.parse(request.params.name), query.host, query.force);
      return reply.code(204).send();
    }),
  );

  for (const action of ["grant", "revoke"] as const) {
    app.post<{ Params: DbParams & { name: string } }>(`${base}/users/:name/${action}`, (request, reply) =>
      withAdapter(request, reply, async (adapter) => {
        const body = GrantBody.parse(request.body);
        await adapter[action]({ name: ExistingName.parse(request.params.name), host: body.host, privileges: body.privileges, connect: body.connect });
        return reply.code(204).send();
      }),
    );
  }
}
