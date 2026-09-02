import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

/**
 * AES-256-GCM for secrets at rest (GitHub tokens, per-project environment
 * values). GCM is authenticated, so a tampered ciphertext fails to decrypt
 * rather than silently yielding garbage.
 *
 * The output is `iv.tag.ciphertext`, base64url, each part independently
 * decodable.
 */
const IV_BYTES = 12;

export function encryptSecret(plaintext: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("SECRET_KEY must be 32 bytes of hex (64 characters)");

  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();

  return [iv.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
}

export function decryptSecret(encoded: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("SECRET_KEY must be 32 bytes of hex (64 characters)");

  const parts = encoded.split(".");
  if (parts.length !== 3) throw new Error("malformed ciphertext");

  const [iv, tag, ciphertext] = parts.map((p) => Buffer.from(p, "base64url"));
  const decipher = createDecipheriv("aes-256-gcm", key, iv!);
  decipher.setAuthTag(tag!);
  return Buffer.concat([decipher.update(ciphertext!), decipher.final()]).toString("utf8");
}
