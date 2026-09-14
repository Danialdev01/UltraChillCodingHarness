/**
 * Reading a repository URL before the server sees it.
 *
 * Both of these exist to keep the new-project dialog from making a request
 * per keystroke and from asking the user for a name it can work out itself.
 * Neither is a security check: the server holds the transport whitelist, and
 * `decide()` derives the same name if the field is left empty.
 */

/** Schemes a clone can actually use. `ext:` and friends are the server's to refuse. */
const SCHEMES = /^(https?|ssh|git):\/\//i;

/** The `git@github.com:owner/repo.git` form, which is not a URL at all. */
const SCP_LIKE = /^[\w.-]+@[\w.-]+:[\w./~-]+$/;

/**
 * Whether this is worth asking the server about yet.
 *
 * Deliberately loose: it is a "stop typing, this looks finished" test, not a
 * verdict on whether the repository exists. The server's answer is the
 * verdict.
 */
export function looksLikeRepoUrl(input: string): boolean {
  const value = input.trim();
  if (value.length < 8) return false;
  if (SCP_LIKE.test(value)) return true;
  if (!SCHEMES.test(value)) return false;
  try {
    const url = new URL(value);
    // A host and something after it: "https://github.com" alone is not a
    // repository, and asking about it wastes a `ls-remote`.
    return Boolean(url.hostname) && url.pathname.replace(/^\/+|\/+$/g, "").length > 0;
  } catch {
    return false;
  }
}

/**
 * The project name a URL implies: its last path segment, without `.git`.
 *
 * The same rule `decide()` uses when the command carries no name, so the
 * prefilled value is what the project would have been called anyway.
 */
export function deriveProjectName(repoUrl: string): string {
  const trimmed = repoUrl
    .trim()
    .replace(/[?#].*$/, "")
    .replace(/\.git$/i, "")
    .replace(/\/+$/, "");
  const last = trimmed.split(/[/:]/).pop() ?? "";
  return last.slice(0, 100);
}
