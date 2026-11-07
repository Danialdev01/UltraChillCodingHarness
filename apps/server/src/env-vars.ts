import { asc, eq } from "drizzle-orm";
import { lstat, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { projectKeys, type Database } from "@ucch/db";
import { ENV_VARS_MAX } from "@ucch/protocol";
import { decryptSecret } from "./crypto.js";
import { AGENT_DIR } from "./dev-database.js";
import {
  decryptValue,
  encryptValue,
  initVault,
  newVar,
  readVault,
  rekeyVault,
  removeVault,
  unlockVault,
  writeVault,
  type Vault,
  type VaultVar,
} from "./env-vault.js";

/** A variable as a list carries it: everything but the value. */
export interface EnvVarRecord {
  id: string;
  name: string;
  tags: string[];
  url: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface EnvVarInput {
  name: string;
  value: string;
  tags?: string[];
  url?: string | null;
}

export type EnvVarPatch = Partial<EnvVarInput>;

export interface EnvStatus {
  /** The project has a project key, so `.agent/env.val` exists. */
  configured: boolean;
  /** Keys saved before env.val, still in the database, moved over when the key is set up. */
  legacyCount: number;
}

/** No project key yet: the section is not enabled. */
export class NotConfigured extends Error {
  constructor() {
    super("this project has no project key yet; set one up under Manage → Project key");
  }
}

export class AlreadyConfigured extends Error {
  constructor() {
    super("this project already has a project key");
  }
}

/**
 * The clone has not landed yet. It clears the directory first, so a vault
 * written now would be silently deleted.
 */
export class NotReady extends Error {
  constructor() {
    super("the project is still being set up; try again when its files are there");
  }
}

export class TooManyVars extends Error {
  constructor() {
    super(`a project keeps at most ${ENV_VARS_MAX} environment variables`);
  }
}

/** Where a project's files are; the vault is at `<dir>/.agent/env.val`. */
export type ProjectDir = (projectId: string) => string;

/**
 * A project's environment variables, kept in `.agent/env.val` and encrypted
 * under its project key (`env-vault.ts`).
 *
 * Every method that touches a value takes the project key and checks it
 * first, so nothing is read, written or removed by someone who does not
 * know it. Listing does not: names are not secret, and the locked view
 * shows them. Writes to one project's file are serialised, so two saves at
 * once cannot drop each other's change.
 *
 * Keys saved in the `project_keys` table before the file existed are moved
 * into it, re-encrypted, when the project key is first set up.
 */
export class EnvVarService {
  readonly #locks = new Map<string, Promise<unknown>>();

  constructor(
    private readonly db: Database,
    private readonly dirOf: ProjectDir,
    /** For the legacy `project_keys` rows; null when `SECRET_KEY` is not configured. */
    private readonly secretKey: string | null,
    /** After every write: refreshes the file list in `.agent/index.md`. */
    private readonly afterWrite: (dir: string) => Promise<void> = async () => {},
  ) {}

  async status(projectId: string): Promise<EnvStatus> {
    const [vault, legacy] = await Promise.all([readVault(this.dirOf(projectId)), this.#legacyRows(projectId)]);
    return { configured: vault !== null, legacyCount: legacy.length };
  }

  /** The variables without their values; empty when there is no project key yet. */
  async list(projectId: string): Promise<{ configured: boolean; vars: EnvVarRecord[] }> {
    const vault = await readVault(this.dirOf(projectId));
    return { configured: vault !== null, vars: vault ? vault.vars.map(toRecord) : [] };
  }

  /**
   * Sets the project key up: writes an empty `env.val` and moves the legacy
   * keys into it. `skipped` counts legacy keys that could not be read -- no
   * `SECRET_KEY`, or a changed one -- which are left where they are.
   */
  async setup(projectId: string, projectKey: string): Promise<{ migrated: number; skipped: number }> {
    return this.#serial(projectId, async () => {
      const dir = this.dirOf(projectId);
      if (await readVault(dir)) throw new AlreadyConfigured();
      if (!(await lstat(join(dir, ".git")).catch(() => null))) throw new NotReady();
      const { vault, key } = await initVault(projectKey);

      const legacy = await this.#legacyRows(projectId);
      const moved: string[] = [];
      let skipped = 0;
      for (const row of legacy) {
        let value: string;
        try {
          if (!this.secretKey) throw new Error("no SECRET_KEY");
          value = decryptSecret(row.valueEncrypted, this.secretKey);
        } catch {
          skipped++;
          continue;
        }
        vault.vars.push({
          id: row.id,
          name: row.name,
          tags: row.tags,
          url: row.url,
          value: encryptValue(value, key),
          createdAt: row.createdAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
        });
        moved.push(row.id);
      }

      await this.#write(dir, vault);
      // Only once the file holding them is safely on disk.
      for (const id of moved) await this.db.delete(projectKeys).where(eq(projectKeys.id, id));
      return { migrated: moved.length, skipped };
    });
  }

  /** Throws `WrongProjectKey` unless `projectKey` is the project's. */
  async unlock(projectId: string, projectKey: string): Promise<void> {
    await unlockVault(await this.#vault(projectId), projectKey);
  }

  async create(projectId: string, projectKey: string, input: EnvVarInput): Promise<EnvVarRecord> {
    return this.#serial(projectId, async () => {
      const vault = await this.#vault(projectId);
      const key = await unlockVault(vault, projectKey);
      if (vault.vars.length >= ENV_VARS_MAX) throw new TooManyVars();
      const variable = newVar(input, key);
      vault.vars.push(variable);
      await this.#write(this.dirOf(projectId), vault);
      return toRecord(variable);
    });
  }

  /** The variable with the change applied, or null when there is no such variable. */
  async update(projectId: string, projectKey: string, id: string, patch: EnvVarPatch): Promise<EnvVarRecord | null> {
    return this.#serial(projectId, async () => {
      const vault = await this.#vault(projectId);
      const key = await unlockVault(vault, projectKey);
      const at = vault.vars.findIndex((v) => v.id === id);
      if (at < 0) return null;
      const current = vault.vars[at]!;
      const next: VaultVar = {
        ...current,
        ...(patch.name !== undefined ? { name: patch.name } : {}),
        ...(patch.value !== undefined ? { value: encryptValue(patch.value, key) } : {}),
        ...(patch.tags !== undefined ? { tags: patch.tags } : {}),
        ...(patch.url !== undefined ? { url: patch.url || null } : {}),
        updatedAt: new Date().toISOString(),
      };
      vault.vars[at] = next;
      await this.#write(this.dirOf(projectId), vault);
      return toRecord(next);
    });
  }

  async remove(projectId: string, projectKey: string, id: string): Promise<boolean> {
    return this.#serial(projectId, async () => {
      const vault = await this.#vault(projectId);
      await unlockVault(vault, projectKey);
      const before = vault.vars.length;
      vault.vars = vault.vars.filter((v) => v.id !== id);
      if (vault.vars.length === before) return false;
      await this.#write(this.dirOf(projectId), vault);
      return true;
    });
  }

  /** The plaintext value, or null when there is no such variable. */
  async reveal(projectId: string, projectKey: string, id: string): Promise<string | null> {
    const vault = await this.#vault(projectId);
    const key = await unlockVault(vault, projectKey);
    const variable = vault.vars.find((v) => v.id === id);
    return variable ? decryptValue(variable, key) : null;
  }

  /** Re-encrypts every value under `newKey`. */
  async changeKey(projectId: string, oldKey: string, newKey: string): Promise<void> {
    await this.#serial(projectId, async () => {
      const vault = await this.#vault(projectId);
      const key = await unlockVault(vault, oldKey);
      await this.#write(this.dirOf(projectId), await rekeyVault(vault, key, newKey));
    });
  }

  /** For a forgotten key: removes `env.val`, and every value with it. */
  async reset(projectId: string): Promise<void> {
    await this.#serial(projectId, async () => {
      const dir = this.dirOf(projectId);
      await removeVault(dir);
      await this.afterWrite(dir);
    });
  }

  async #vault(projectId: string): Promise<Vault> {
    const vault = await readVault(this.dirOf(projectId));
    if (!vault) throw new NotConfigured();
    return vault;
  }

  async #write(dir: string, vault: Vault): Promise<void> {
    const folder = join(dir, AGENT_DIR);
    if ((await lstat(folder).catch(() => null))?.isSymbolicLink()) {
      throw new Error(".agent is a symlink; refusing to write through it");
    }
    await mkdir(folder, { recursive: true });
    await writeVault(dir, vault);
    await this.afterWrite(dir).catch(() => {});
  }

  #legacyRows(projectId: string) {
    return this.db
      .select()
      .from(projectKeys)
      .where(eq(projectKeys.projectId, projectId))
      .orderBy(asc(projectKeys.createdAt));
  }

  /** Runs `work` after every earlier write to the project has finished. */
  async #serial<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.#locks.get(projectId) ?? Promise.resolve();
    const run = previous.catch(() => {}).then(work);
    this.#locks.set(projectId, run);
    try {
      return await run;
    } finally {
      if (this.#locks.get(projectId) === run) this.#locks.delete(projectId);
    }
  }
}

function toRecord(v: VaultVar): EnvVarRecord {
  return { id: v.id, name: v.name, tags: v.tags, url: v.url, createdAt: v.createdAt, updatedAt: v.updatedAt };
}
