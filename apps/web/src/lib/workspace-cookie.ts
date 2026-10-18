/** The cookie that remembers the last workspace open, by id, for the pages outside any. */
export const WORKSPACE_COOKIE_NAME = "ucch_workspace"

/**
 * The same workspace by address, for the middleware: it sends an old
 * root-level address (`/dashboard`, `/database/…`) on to `/{ws}/…` without
 * a lookup of its own.
 */
export const WORKSPACE_HASH_COOKIE_NAME = "ucch_workspace_hash"
