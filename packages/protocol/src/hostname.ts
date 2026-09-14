/**
 * The public hostname grammar.
 *
 * Every request to `*.ucch.danialirfan.dev` arrives at the gateway through a
 * single Traefik router, and this function decides where it goes. It is a pure
 * string function with no I/O so it can be exhaustively tested, including
 * against hostile input -- it runs before any authentication.
 *
 *   ucch.danialirfan.dev              -> the web app
 *   www.ucch.danialirfan.dev          -> the web app
 *   api.ucch.danialirfan.dev          -> the API server
 *   p3000-a1b2c3d4e5f6.ucch...        -> project a1b2c3d4e5f6, port 3000
 *   pv-9f8e7d6c5b4a.ucch...           -> published preview 9f8e7d6c5b4a
 */

export type HostTarget =
  | { kind: "web" }
  | { kind: "api" }
  | { kind: "project"; projectHash: string; port: number }
  | { kind: "preview"; previewHash: string }
  | { kind: "unknown"; reason: string };

const HASH = /^[a-z0-9]{12}$/;
const PROJECT_LABEL = /^p(\d{1,5})-([a-z0-9]{12})$/;
const PREVIEW_LABEL = /^pv-([a-z0-9]{12})$/;

/** Ports below 1024 are privileged and never bound by an unprivileged dev server. */
const MIN_PORT = 1024;
const MAX_PORT = 65535;

export function parseHost(host: string, rootDomain: string): HostTarget {
  // Strip the port a proxy or a local `.localhost` setup may append, and
  // normalize case -- hostnames are case-insensitive but regexes are not.
  const hostname = host.split(":")[0]!.trim().toLowerCase().replace(/\.$/, "");
  const root = rootDomain.trim().toLowerCase();

  if (hostname === root) return { kind: "web" };
  if (!hostname.endsWith("." + root)) {
    return { kind: "unknown", reason: `host ${hostname} is outside ${root}` };
  }

  const prefix = hostname.slice(0, -(root.length + 1));
  // Only single-label prefixes are meaningful. A nested prefix like
  // `evil.p3000-abc` must not resolve to the project.
  if (prefix.includes(".")) return { kind: "unknown", reason: "nested subdomain" };
  if (prefix === "" ) return { kind: "unknown", reason: "empty subdomain" };
  if (prefix === "www") return { kind: "web" };
  if (prefix === "api") return { kind: "api" };

  const project = PROJECT_LABEL.exec(prefix);
  if (project) {
    const port = Number(project[1]);
    if (port < MIN_PORT || port > MAX_PORT) {
      return { kind: "unknown", reason: `port ${port} out of range` };
    }
    return { kind: "project", projectHash: project[2]!, port };
  }

  const preview = PREVIEW_LABEL.exec(prefix);
  if (preview) return { kind: "preview", previewHash: preview[1]! };

  return { kind: "unknown", reason: `unrecognized subdomain ${prefix}` };
}

// -- URL construction (used by the UI) --------------------------------------

/**
 * `publicPort` is the port the gateway itself is reached on, appended when
 * there is no reverse proxy in front of it (development: `:3001`). It is
 * not the project's port -- that one lives in the hostname.
 */
export function projectUrl(
  hash: string,
  port: number,
  rootDomain: string,
  scheme = "https",
  publicPort?: number,
): string {
  if (!HASH.test(hash)) throw new Error(`invalid project hash: ${hash}`);
  if (port < MIN_PORT || port > MAX_PORT) throw new Error(`port out of range: ${port}`);
  const suffix = publicPort ? `:${publicPort}` : "";
  return `${scheme}://p${port}-${hash}.${rootDomain}${suffix}`;
}

export function previewUrl(hash: string, rootDomain: string, scheme = "https"): string {
  if (!HASH.test(hash)) throw new Error(`invalid preview hash: ${hash}`);
  return `${scheme}://pv-${hash}.${rootDomain}`;
}

/** Container name for a project's workspace. Must match `runtime/docker.ts`. */
export function projectContainerName(projectHash: string): string {
  return `ucch-proj-${projectHash}`;
}

export function previewContainerName(previewHash: string): string {
  return `ucch-preview-${previewHash}`;
}

/**
 * Parses the path-based alias kept for backwards compatibility:
 * `/{projectHash}/port:{n}/rest` -> a 302 to the equivalent subdomain.
 */
export function parsePathAlias(pathname: string): { projectHash: string; port: number; rest: string } | null {
  const m = /^\/([a-z0-9]{12})\/port:(\d{1,5})(\/.*)?$/.exec(pathname);
  if (!m) return null;
  const port = Number(m[2]);
  if (port < MIN_PORT || port > MAX_PORT) return null;
  return { projectHash: m[1]!, port, rest: m[3] ?? "/" };
}

/**
 * Parses the shareable entry point `/{projectHash}/preview[/rest]`. The port
 * is not in the URL: the server resolves it from the project's stored
 * preview port and redirects to the matching subdomain.
 */
export function parsePreviewAlias(pathname: string): { projectHash: string; rest: string } | null {
  const m = /^\/([a-z0-9]{12})\/preview(\/.*)?$/.exec(pathname);
  if (!m) return null;
  return { projectHash: m[1]!, rest: m[2] ?? "/" };
}
