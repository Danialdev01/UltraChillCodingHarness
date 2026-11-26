/**
 * The language runtimes a project can choose a version of, and the shapes
 * the API answers with. No zod here: the browser takes these from
 * `@ucch/protocol/plain`, and `runtimes.ts` builds the file's schema from
 * them.
 *
 * A runtime is one id here and one provider on the server; the file, the
 * routes and the settings card are per runtime. Framework profiles
 * (`frameworks.ts`, plan3) choose among them.
 */

export const RUNTIMES_FILE = ".agent/runtimes.json";

export const RUNTIME_IDS = ["php", "composer", "node", "bun", "dotnet", "rust"] as const;
export type RuntimeId = (typeof RUNTIME_IDS)[number];

export const RUNTIME_LABELS: Record<RuntimeId, string> = {
  php: "PHP",
  composer: "Composer",
  node: "Node.js",
  bun: "Bun",
  dotnet: ".NET SDK",
  rust: "Rust",
};

/**
 * The runtimes every project gets without asking: PHP, as before profiles.
 * The rest are linked only when `.agent/runtimes.json` names them, so a
 * project never downloads a toolchain it does not use.
 */
export const IMPLICIT_RUNTIMES: readonly RuntimeId[] = ["php"];

/** Selection words that name a release channel rather than a number. */
export const RUNTIME_CHANNELS = ["lts", "stable", "beta", "nightly"] as const;

/**
 * What a project asks for:
 * - `latest`: the newest stable version installed on the server (the default);
 * - `system`: whatever the server's own PATH has, no managed version at all;
 * - `lts`: the newest long-term-support release (Node, .NET, Composer);
 * - `stable`, `beta`, `nightly`: that channel's newest (Rust);
 * - `22`: the newest installed release of that major;
 * - `8.4`: the newest installed patch of that line;
 * - `8.4.12`: exactly that version.
 */
export const RUNTIME_SELECTION_PATTERN = /^(latest|system|lts|stable|beta|nightly|\d{1,3}(\.\d{1,3}(\.\d{1,3})?)?)$/;
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
  /** What `.agent/runtimes.json` asks for: `latest` for PHP when it says nothing, `system` for the rest. */
  selection: string;
  /** Whether the project uses it: PHP always, the rest once its file names them. */
  used: boolean;
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
