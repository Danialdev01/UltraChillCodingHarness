import { and, asc, eq } from "drizzle-orm";
import { projectKeys, type Database, type ProjectKey } from "@ucch/db";
import { decryptSecret, encryptSecret } from "./crypto.js";

/** A key as a list carries it: everything but the value. */
export interface ProjectKeyRecord {
  id: string;
  name: string;
  tags: string[];
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectKeyInput {
  name: string;
  value: string;
  tags?: string[];
  url?: string | null;
}

export type ProjectKeyPatch = Partial<ProjectKeyInput>;

/**
 * A project's saved keys -- the ones a provider shows once and never again.
 *
 * Every method takes the project id first and scopes its query by it, so a
 * key id from another project is simply not found; the route resolves the
 * project through `findByHash` and ownership is checked once, there. Values
 * are encrypted on the way in and only `reveal` decrypts one.
 */
export class ProjectKeyService {
  constructor(
    private readonly db: Database,
    private readonly secretKey: string,
  ) {}

  async list(projectId: string): Promise<ProjectKeyRecord[]> {
    const rows = await this.db
      .select()
      .from(projectKeys)
      .where(eq(projectKeys.projectId, projectId))
      .orderBy(asc(projectKeys.createdAt));
    return rows.map(toRecord);
  }

  async create(projectId: string, input: ProjectKeyInput): Promise<ProjectKeyRecord> {
    const [row] = await this.db
      .insert(projectKeys)
      .values({
        projectId,
        name: input.name,
        valueEncrypted: encryptSecret(input.value, this.secretKey),
        tags: input.tags ?? [],
        url: input.url || null,
      })
      .returning();
    return toRecord(row!);
  }

  /** The key as it stands with the change applied; the value only if a new one came. */
  async update(projectId: string, id: string, patch: ProjectKeyPatch): Promise<ProjectKeyRecord | null> {
    const [row] = await this.db
      .update(projectKeys)
      .set({
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.value !== undefined ? { valueEncrypted: encryptSecret(patch.value, this.secretKey) } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.url !== undefined ? { url: patch.url || null } : {}),
        updatedAt: new Date(),
      })
      .where(and(eq(projectKeys.projectId, projectId), eq(projectKeys.id, id)))
      .returning();
    return row ? toRecord(row) : null;
  }

  /** True when a key was removed; false when there was nothing of this project's to remove. */
  async remove(projectId: string, id: string): Promise<boolean> {
    const rows = await this.db
      .delete(projectKeys)
      .where(and(eq(projectKeys.projectId, projectId), eq(projectKeys.id, id)))
      .returning({ id: projectKeys.id });
    return rows.length > 0;
  }

  /**
   * The plaintext value, or null when the key is not this project's.
   * Throws when the value was encrypted under a `SECRET_KEY` since changed.
   */
  async reveal(projectId: string, id: string): Promise<string | null> {
    const [row] = await this.db
      .select({ valueEncrypted: projectKeys.valueEncrypted })
      .from(projectKeys)
      .where(and(eq(projectKeys.projectId, projectId), eq(projectKeys.id, id)))
      .limit(1);
    return row ? decryptSecret(row.valueEncrypted, this.secretKey) : null;
  }
}

function toRecord(row: ProjectKey): ProjectKeyRecord {
  return {
    id: row.id,
    name: row.name,
    tags: row.tags,
    url: row.url,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
