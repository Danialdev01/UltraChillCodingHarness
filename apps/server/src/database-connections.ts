import { and, asc, eq, inArray } from "drizzle-orm";
import { databaseConnections, workspaceMembers, type Database, type DatabaseConnection } from "@ucch/db";
import type { DatabaseConnectionCreate, DatabaseConnectionSummary, DatabaseConnectionUpdate, DatabaseEngine } from "@ucch/protocol";
import { encryptSecret } from "./crypto.js";

/**
 * Saved MySQL and PostgreSQL servers, one list per workspace.
 *
 * Organisation rather than project activity, so like workspaces they sit
 * outside the event log and are served over REST. The password is encrypted
 * on the way in and only `findForUser` -- the read behind a live query --
 * hands back a row that still carries it.
 */
export class DatabaseConnectionService {
  constructor(private readonly db: Database) {}

  async list(workspaceId: string): Promise<DatabaseConnectionSummary[]> {
    const rows = await this.db
      .select()
      .from(databaseConnections)
      .where(eq(databaseConnections.workspaceId, workspaceId))
      .orderBy(asc(databaseConnections.createdAt));
    return rows.map(summarize);
  }

  async create(
    workspaceId: string,
    input: DatabaseConnectionCreate,
    secretKey: string,
  ): Promise<DatabaseConnectionSummary> {
    const [row] = await this.db
      .insert(databaseConnections)
      .values({
        workspaceId,
        name: input.name,
        engine: input.engine,
        host: input.host,
        port: input.port,
        username: input.username,
        passwordEncrypted: encryptSecret(input.password, secretKey),
        database: input.database || null,
      })
      .returning();
    return summarize(row!);
  }

  /** The row as it stands with the change applied; the password only if a new one came. */
  async update(row: DatabaseConnection, input: DatabaseConnectionUpdate, secretKey: string): Promise<DatabaseConnectionSummary> {
    const [updated] = await this.db
      .update(databaseConnections)
      .set({
        ...(input.name !== undefined ? { name: input.name } : {}),
        ...(input.engine !== undefined ? { engine: input.engine } : {}),
        ...(input.host !== undefined ? { host: input.host } : {}),
        ...(input.port !== undefined ? { port: input.port } : {}),
        ...(input.username !== undefined ? { username: input.username } : {}),
        ...(input.password !== undefined ? { passwordEncrypted: encryptSecret(input.password, secretKey) } : {}),
        ...(input.database !== undefined ? { database: input.database || null } : {}),
      })
      .where(eq(databaseConnections.id, row.id))
      .returning();
    return summarize(updated!);
  }

  /**
   * The full row -- password included -- when the connection belongs to a
   * workspace this user may work in (any role but viewer: a live query can
   * write). Existence and membership are one predicate, as with
   * `WorkspaceService.membership`.
   */
  async findForUser(id: string, userId: string): Promise<DatabaseConnection | null> {
    const [row] = await this.db
      .select({ connection: databaseConnections })
      .from(databaseConnections)
      .innerJoin(
        workspaceMembers,
        and(
          eq(workspaceMembers.workspaceId, databaseConnections.workspaceId),
          eq(workspaceMembers.userId, userId),
        ),
      )
      .where(and(eq(databaseConnections.id, id), inArray(workspaceMembers.role, ["owner", "admin", "member"])))
      .limit(1);
    return row?.connection ?? null;
  }

  /** True when a row was removed; false when there was nothing of this user's to remove. */
  async remove(id: string, userId: string): Promise<boolean> {
    const owned = await this.findForUser(id, userId);
    if (!owned) return false;
    await this.db.delete(databaseConnections).where(eq(databaseConnections.id, id));
    return true;
  }
}

function summarize(row: DatabaseConnection): DatabaseConnectionSummary {
  return {
    id: row.id,
    name: row.name,
    engine: row.engine as DatabaseEngine,
    host: row.host,
    port: row.port,
    username: row.username,
    database: row.database,
    createdAt: row.createdAt.toISOString(),
  };
}
