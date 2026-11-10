/**
 * The language runtimes a project can choose a version of, and the shapes
 * the API answers with. No zod here: the browser takes these from
 * `@ucch/protocol/plain`, and `runtimes.ts` builds the file's schema from
 * them.
 *
 * Only PHP today. A runtime added later (node, dotnet, cargo, ...) is one
 * more id here and one more provider on the server; the file, the routes
 * and the settings card are already per runtime.
 */

export const RUNTIMES_FILE = ".agent/runtimes.json";

export const RUNTIME_IDS = ["php"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export const RUNTIME_LABELS: Record<RuntimeId, string> = {
  php: "PHP",
};

/**
 * What a project asks for:
 * - `latest`: the newest stable version installed on the server (the default);
 * - `system`: whatever the server's own PATH has, no managed version at all;
 * - `8.4`: the newest installed patch of that line;
 * - `8.4.12`: exactly that version.
 */
export const RUNTIME_SELECTION_PATTERN = /^(latest|system|\d{1,3}\.\d{1,3}(\.\d{1,3})?)$/;
export const RUNTIME_DEFAULT_SELECTION = "latest";

/** A download in flight, as the settings card shows it. */
export interface RuntimeInstallProgress {
  version: string;
  /** Bytes so far, and in all when the server said; null when it did not. */
  received: number;
  total: number | null;
}

/** One runtime of one project, as `GET /api/projects/:hash/runtimes` reports it. */
export interface ProjectRuntimeStatus {
  id: RuntimeId;
  label: string;
  /** What `.agent/runtimes.json` asks for, `latest` when it says nothing. */
  selection: string;
  /** The installed version the project uses; null means the system one. */
  resolved: string | null;
  /** The server's own version (`php` on its PATH), null when there is none. */
  system: string | null;
  /** Installed on this server, newest first. Shared by every project. */
  installed: string[];
  /** Offered for download, newest first; null when the list could not be fetched. */
  available: string[] | null;
  /** Why `available` is null. */
  availableError: string | null;
  /**
   * A newer version the selection would take once installed: the newest
   * patch of a line, the newest stable for `latest`. Null when the project
   * is already on it, or is pinned exactly.
   */
  update: string | null;
  /** A selection nothing installed satisfies yet: the version that would. */
  missing: string | null;
  installing: RuntimeInstallProgress[];
  /** The last install that failed, for this runtime, and why. */
  lastError: string | null;
  /** The project's own requirement (composer.json's `require.php`), if any. */
  constraint: string | null;
  /** Whether `resolved` (or the system version) meets `constraint`; null when unknown. */
  satisfies: boolean | null;
}

export interface ProjectRuntimesResponse {
  runtimes: ProjectRuntimeStatus[];
  /** Why `.agent/runtimes.json` could not be used; null when it was fine or absent. */
  error: string | null;
}
