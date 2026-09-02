import { randomBytes, scrypt, timingSafeEqual, type ScryptOptions } from "node:crypto";

/**
 * `promisify(scrypt)` collapses the overloads and drops the options argument,
 * so the callback form is wrapped by hand to keep the cost parameters.
 */
function scryptAsync(
  password: string,
  salt: string | Buffer,
  keylen: number,
  options: ScryptOptions,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    scrypt(password, salt, keylen, options, (error, key) => {
      if (error) reject(error);
      else resolve(key);
    });
  });
}

/**
 * Password hashing with scrypt.
 *
 * scrypt is memory-hard and ships in Node's standard library, so there is no
 * native dependency to build. The cost parameters are stored alongside the
 * hash rather than hardcoded, so they can be raised later without
 * invalidating existing passwords -- an old hash still carries the parameters
 * it was created with.
 */
const N = 16384; // CPU/memory cost
const R = 8; //     block size
const P = 1; //     parallelization
const KEY_LENGTH = 64;
const SALT_BYTES = 16;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(password, salt, KEY_LENGTH, { N, r: R, p: P });
  return ["scrypt", N, R, P, salt.toString("base64url"), key.toString("base64url")].join("$");
}

/**
 * Returns false for a malformed or unknown-algorithm hash rather than
 * throwing: a corrupt stored hash must fail the login, not crash the request.
 */
export async function verifyPassword(password: string, encoded: string | null): Promise<boolean> {
  if (!encoded) {
    // Still spend the work factor. Returning early on a missing hash would
    // make "no such user" measurably faster than "wrong password".
    await scryptAsync(password, "no-such-user", KEY_LENGTH, { N, r: R, p: P });
    return false;
  }

  const parts = encoded.split("$");
  if (parts.length !== 6 || parts[0] !== "scrypt") return false;

  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  if (!Number.isInteger(n) || !Number.isInteger(r) || !Number.isInteger(p)) return false;

  let salt: Buffer;
  let expected: Buffer;
  try {
    salt = Buffer.from(parts[4]!, "base64url");
    expected = Buffer.from(parts[5]!, "base64url");
  } catch {
    return false;
  }
  if (expected.length === 0) return false;

  const actual = await scryptAsync(password, salt, expected.length, { N: n, r, p });
  return timingSafeEqual(actual, expected);
}
