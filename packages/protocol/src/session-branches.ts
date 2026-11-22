/**
 * Session branches: names only, with no zod, so the browser can take them
 * from `@ucch/protocol/plain` (git toolbar, project preferences). `ids.ts`
 * re-exports them for the schemas and the server.
 */

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
