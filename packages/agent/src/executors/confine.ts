import { lstat, realpath } from "node:fs/promises";
import { dirname, sep } from "node:path";

/**
 * Filesystem confinement shared by the agent's executor and the server's
 * editor routes.
 *
 * Both already refuse a path that *lexically* leaves the workspace. These
 * close the two ways a lexically-inside path still reaches outside it:
 *
 * - a symlink somewhere along it -- a cloned repository can ship
 *   `dir -> /etc`, and git preserves it, so writing `dir/new` lands in `/etc`;
 * - the repository's own `.git`, where `config` (`core.fsmonitor`) and
 *   `hooks/*` are commands the server's next `git status` runs on its behalf.
 */

/** True when any segment of a normalised workspace path is `.git`. */
export function isGitInternalPath(normalized: string): boolean {
  // Lower-cased: on a case-insensitive filesystem `.GIT/config` is the same file.
  return normalized.split(/[\\/]/).some((segment) => segment.toLowerCase() === ".git");
}

/**
 * Refuses an absolute path whose real location is not under `root`'s.
 *
 * The path need not exist yet: the deepest ancestor that does is resolved
 * instead, which is exactly the directory a write or `mkdir -p` would follow
 * into. Throws the error `refuse` builds, so each caller keeps its own type.
 */
export async function assertRealpathInside(
  root: string,
  absolute: string,
  refuse: () => Error,
): Promise<void> {
  let realRoot: string;
  try {
    realRoot = await realpath(root);
  } catch {
    return; // No root yet means nothing under it can be a link.
  }

  let probe = absolute;
  for (;;) {
    let real: string | null = null;
    try {
      real = await realpath(probe);
    } catch {
      real = null;
    }
    if (real !== null) {
      if (real !== realRoot && !real.startsWith(realRoot + sep)) throw refuse();
      return;
    }
    // Present but unresolvable is a dangling link: writing through it would
    // create its target, wherever that is.
    if (await lstat(probe).then(() => true, () => false)) throw refuse();
    const parent = dirname(probe);
    if (parent === probe) return;
    probe = parent;
  }
}
