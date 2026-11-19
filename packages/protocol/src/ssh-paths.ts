/**
 * The Terminal section's plain helpers, with no zod in them: shared by the
 * server and the browser through `@ucch/protocol/plain`.
 */

/**
 * A remote path, made absolute and tidy: `/`-separated, no `.` or `..`
 * segments, no trailing slash except the root itself. `~` and a relative
 * path are taken from `home`. Null for what is not a path at all.
 *
 * Not a guard -- whoever may browse a host may also open a shell on it --
 * but a path the server can name unambiguously in a listing, an upload and
 * a move alike.
 */
export function normalizeRemotePath(path: string, home = "/"): string | null {
  if (typeof path !== "string" || path.length > 4096 || path.includes("\0")) return null;
  let raw = path.trim();
  if (raw === "" || raw === "~") raw = home;
  else if (raw.startsWith("~/")) raw = `${home}/${raw.slice(2)}`;
  else if (!raw.startsWith("/")) raw = `${home}/${raw}`;
  const parts: string[] = [];
  for (const segment of raw.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") parts.pop();
    else parts.push(segment);
  }
  return `/${parts.join("/")}`;
}

/** The folder a remote path is in; the root is its own parent. */
export function remoteParent(path: string): string {
  const at = path.lastIndexOf("/");
  return at <= 0 ? "/" : path.slice(0, at);
}

/** A remote path's last segment; "/" for the root. */
export function remoteBasename(path: string): string {
  return path === "/" ? "/" : path.slice(path.lastIndexOf("/") + 1);
}

/** `name` inside `dir`. */
export function remoteJoin(dir: string, name: string): string {
  return dir === "/" ? `/${name}` : `${dir}/${name}`;
}

/**
 * The nil UUID: the `projectId` the remote agent's events carry, since they
 * belong to no project. The client folds them like any thread's.
 */
export const REMOTE_CHAT_PROJECT_ID = "00000000-0000-0000-0000-000000000000";
