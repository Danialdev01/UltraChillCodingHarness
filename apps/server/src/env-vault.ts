import { randomBytes, randomUUID, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from "node:crypto";
import { lstat, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { decryptWithKey, encryptWithKey } from "./crypto.js";
import { AGENT_ENV } from "./dev-database.js";

/**
 * `.agent/env.val`: a project's environment variables, their values
 * encrypted under a key derived from the project key.
 *
 * The project key itself is never written anywhere. What the file holds is
 * the scrypt salt and parameters, a `check` (a known string encrypted under
 * the derived key, which is how a key is told right from wrong), and the
 * variables. Names, tags and urls stay readable so the list can be shown
 * while locked; only values are encrypted, each with its own IV, so one
 * value changing re-encrypts only itself.
 *
 * The file lives in the project's tree so it travels with the repository: a
 * clone elsewhere opens with the same project key.
 */

export interface VaultKdf {
  name: "scrypt";
  salt: string;
  N: number;
  r: number;
  p: number;
}

export interface VaultVar {
  id: string;
  name: string;
  tags: string[];
  url: string | null;
  /** `iv.tag.ciphertext` under the derived key. */
  value: string;
  createdAt: string;
  updatedAt: string;
}

export interface Vault {
  version: 1;
  kdf: VaultKdf;
  check: string;
  vars: VaultVar[];
}

/** Big enough for any sane number of variables; refuses to parse anything larger. */
const MAX_VAULT_BYTES = 16 * 1024 * 1024;
const CHECK_PLAINTEXT = "ucch-env-vault-v1";
const DEFAULT_KDF = { N: 2 ** 15, r: 8, p: 1 } as const;

/** A wrong project key: the check would not decrypt under it. */
export class WrongProjectKey extends Error {
  constructor() {
    super("wrong project key");
  }
}

/** A file that is not a vault this server can read. */
export class UnreadableVault extends Error {}

function scrypt(password: string, salt: Buffer, options: ScryptOptions): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCallback(password, salt, 32, options, (error, key) => (error ? reject(error) : resolve(key))),
  );
}

/** The AES key a project key derives, under the vault's own salt and parameters. */
export async function deriveKey(projectKey: string, kdf: VaultKdf): Promise<Buffer> {
  return scrypt(projectKey.normalize("NFC"), Buffer.from(kdf.salt, "base64url"), {
    N: kdf.N,
    r: kdf.r,
    p: kdf.p,
    maxmem: 256 * kdf.N * kdf.r,
  });
}

/** An empty vault for a new project key, and the key it derives. */
export async function initVault(
  projectKey: string,
  params: { N: number; r: number; p: number } = DEFAULT_KDF,
): Promise<{ vault: Vault; key: Buffer }> {
  const kdf: VaultKdf = { name: "scrypt", salt: randomBytes(16).toString("base64url"), ...params };
  const key = await deriveKey(projectKey, kdf);
  return { vault: { version: 1, kdf, check: encryptWithKey(CHECK_PLAINTEXT, key), vars: [] }, key };
}

/** The derived key, once the check proves `projectKey` is the vault's. Throws `WrongProjectKey`. */
export async function unlockVault(vault: Vault, projectKey: string): Promise<Buffer> {
  const key = await deriveKey(projectKey, vault.kdf);
  let plain: string;
  try {
    plain = decryptWithKey(vault.check, key);
  } catch {
    throw new WrongProjectKey();
  }
  const a = Buffer.from(plain);
  const b = Buffer.from(CHECK_PLAINTEXT);
  if (a.length !== b.length || !timingSafeEqual(a, b)) throw new WrongProjectKey();
  return key;
}

export function encryptValue(value: string, key: Buffer): string {
  return encryptWithKey(value, key);
}

/** A value under the vault's key. Throws `UnreadableVault` when it was tampered with. */
export function decryptValue(variable: VaultVar, key: Buffer): string {
  try {
    return decryptWithKey(variable.value, key);
  } catch {
    throw new UnreadableVault(`the value of ${variable.name} cannot be decrypted; the file may have been edited`);
  }
}

/** The same variables under a new project key: a new salt, every value re-encrypted. */
export async function rekeyVault(vault: Vault, oldKey: Buffer, newProjectKey: string): Promise<Vault> {
  const values = vault.vars.map((v) => decryptValue(v, oldKey));
  const { vault: fresh, key } = await initVault(newProjectKey, { N: vault.kdf.N, r: vault.kdf.r, p: vault.kdf.p });
  return { ...fresh, vars: vault.vars.map((v, i) => ({ ...v, value: encryptValue(values[i]!, key) })) };
}

/** A new variable, its value encrypted. */
export function newVar(
  input: { name: string; value: string; tags?: string[]; url?: string | null },
  key: Buffer,
  now = new Date(),
): VaultVar {
  const at = now.toISOString();
  return {
    id: randomUUID(),
    name: input.name,
    tags: input.tags ?? [],
    url: input.url || null,
    value: encryptValue(input.value, key),
    createdAt: at,
    updatedAt: at,
  };
}

/**
 * The project's vault, or null when it has none. A symlink is refused rather
 * than followed: the tree is the repository author's, and a link would point
 * the server at a host file.
 */
export async function readVault(dir: string): Promise<Vault | null> {
  const path = join(dir, AGENT_ENV);
  const info = await lstat(path).catch(() => null);
  if (!info) return null;
  if (info.isSymbolicLink() || !info.isFile()) throw new UnreadableVault(".agent/env.val is not a plain file");
  if (info.size > MAX_VAULT_BYTES) throw new UnreadableVault(".agent/env.val is too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readFile(path, "utf8"));
  } catch {
    throw new UnreadableVault(".agent/env.val is not valid JSON");
  }
  if (!isVault(parsed)) throw new UnreadableVault(".agent/env.val is not an environment variable file");
  return parsed;
}

/** Written whole and renamed into place, so a reader never sees half a file. */
export async function writeVault(dir: string, vault: Vault): Promise<void> {
  const path = join(dir, AGENT_ENV);
  const info = await lstat(path).catch(() => null);
  if (info?.isSymbolicLink()) throw new UnreadableVault(".agent/env.val is a symlink; refusing to write through it");
  const temp = `${path}.${randomBytes(6).toString("hex")}.tmp`;
  await writeFile(temp, `${JSON.stringify(vault, null, 2)}\n`, { mode: 0o600 });
  try {
    await rename(temp, path);
  } catch (error) {
    await rm(temp, { force: true });
    throw error;
  }
}

export async function removeVault(dir: string): Promise<void> {
  const path = join(dir, AGENT_ENV);
  const info = await lstat(path).catch(() => null);
  if (!info) return;
  await rm(path);
}

function isVault(value: unknown): value is Vault {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<Vault>;
  const kdf = v.kdf as Partial<VaultKdf> | undefined;
  return (
    v.version === 1 &&
    typeof v.check === "string" &&
    !!kdf &&
    kdf.name === "scrypt" &&
    typeof kdf.salt === "string" &&
    // Bounded, so a crafted file cannot make the server derive forever.
    Number.isInteger(kdf.N) && kdf.N! >= 2 ** 10 && kdf.N! <= 2 ** 20 && (kdf.N! & (kdf.N! - 1)) === 0 &&
    Number.isInteger(kdf.r) && kdf.r! >= 1 && kdf.r! <= 32 &&
    Number.isInteger(kdf.p) && kdf.p! >= 1 && kdf.p! <= 4 &&
    Array.isArray(v.vars) &&
    v.vars.every(
      (x) =>
        x &&
        typeof x.id === "string" &&
        typeof x.name === "string" &&
        typeof x.value === "string" &&
        Array.isArray(x.tags) &&
        x.tags.every((t) => typeof t === "string") &&
        (x.url === null || typeof x.url === "string") &&
        typeof x.createdAt === "string" &&
        typeof x.updatedAt === "string",
    )
  );
}
