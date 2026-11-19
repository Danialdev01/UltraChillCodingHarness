import { z } from "zod";

/**
 * Project hashes appear in public hostnames (`p3000-{hash}.ucch...`), so the
 * alphabet is restricted to what is safe and unambiguous in a DNS label:
 * lowercase alphanumerics only, no hyphens (the hostname grammar uses `-` as
 * its own field separator).
 */
export const ProjectHash = z.string().regex(/^[a-z0-9]{12}$/, "invalid project hash");
export const PreviewHash = z.string().regex(/^[a-z0-9]{12}$/, "invalid preview hash");
/** A workspace's and a project session's (thread's) web address use the same grammar. */
export const WorkspaceHash = z.string().regex(/^[a-z0-9]{12}$/, "invalid workspace hash");
export const ThreadHash = z.string().regex(/^[a-z0-9]{12}$/, "invalid session hash");

/**
 * A branch a session may fork from: what git accepts, minus anything that
 * could be read as an option or walk out of `refs/heads`.
 */
export const BranchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^(?!-)(?!.*\.\.)(?!.*\/\/)(?!.*\.lock$)[A-Za-z0-9._\/-]+(?<![./])$/, "invalid branch name");

/**
 * The prefix of every session's own branch. Reserved for the harness: these
 * are plumbing, never one of the project's branches, so branch lists leave
 * them out and nobody may create one by hand.
 */
export const SESSION_BRANCH_PREFIX = "ucch/";

/** The branch a project session works on, forked from its base. */
export function sessionBranch(threadHash: string): string {
  return `${SESSION_BRANCH_PREFIX}${threadHash}`;
}

/**
 * Whether a branch is a session's: `ucch/x`, or with `remote` a
 * remote-tracking name, `<remote>/ucch/x`.
 */
export function isSessionBranch(name: string, remote = false): boolean {
  const local = remote ? name.slice(name.indexOf("/") + 1) : name;
  return (!remote || name.includes("/")) && local.startsWith(SESSION_BRANCH_PREFIX);
}

/**
 * A name nobody may give a branch by hand: a session's, or the bare `ucch`,
 * which git could not hold beside `ucch/*` (a ref cannot also be a folder).
 */
export function isReservedBranchName(name: string): boolean {
  return name === SESSION_BRANCH_PREFIX.slice(0, -1) || isSessionBranch(name);
}

export const ProjectId = z.string().uuid();
export const ThreadId = z.string().uuid();
export const TurnId = z.string().uuid();
export const UserId = z.string().uuid();

export type ProjectId = z.infer<typeof ProjectId>;
export type ThreadId = z.infer<typeof ThreadId>;
export type TurnId = z.infer<typeof TurnId>;
export type UserId = z.infer<typeof UserId>;

const HASH_ALPHABET = "abcdefghijklmnopqrstuvwxyz0123456789";
const HASH_LENGTH = 12;

/** Generates a 12-char hash from the DNS-safe alphabet above. */
export function generateHash(randomIndex: (max: number) => number = cryptoRandomIndex): string {
  let out = "";
  for (let i = 0; i < HASH_LENGTH; i++) out += HASH_ALPHABET[randomIndex(HASH_ALPHABET.length)];
  return out;
}

function cryptoRandomIndex(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  // Modulo bias over 2^32 is negligible for collision avoidance, and every
  // generated hash is uniqueness-checked against the database on insert.
  return buf[0]! % max;
}
