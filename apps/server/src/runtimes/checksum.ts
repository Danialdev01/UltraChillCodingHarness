import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";

/** The hex digest of a file, streamed. */
export async function fileDigest(file: string, algorithm: "sha256" | "sha512"): Promise<string> {
  const hash = createHash(algorithm);
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/**
 * Throws unless `file` hashes to what the release said. A release without a
 * digest passes: the provider decides whether its index publishes one.
 */
export async function verifyDigest(file: string, expected: { sha256?: string; sha512?: string }): Promise<void> {
  for (const algorithm of ["sha512", "sha256"] as const) {
    const want = expected[algorithm]?.trim().toLowerCase();
    if (!want) continue;
    const got = await fileDigest(file, algorithm);
    if (got !== want) throw new Error(`the download's ${algorithm} is ${got.slice(0, 16)}…, not the published ${want.slice(0, 16)}…`);
    return;
  }
}

/** `SHASUMS256.txt`: `<hex>  <name>` lines, as a map of name to digest. */
export function parseShasums(text: string): Map<string, string> {
  const sums = new Map<string, string>();
  for (const line of text.split("\n")) {
    const match = /^([0-9a-f]{64})\s+\*?(?:\.\/)?(\S+)\s*$/i.exec(line.trim());
    if (match) sums.set(match[2]!, match[1]!.toLowerCase());
  }
  return sums;
}
