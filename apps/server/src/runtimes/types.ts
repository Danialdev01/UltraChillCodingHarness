import type { RuntimeId } from "@ucch/protocol";

/**
 * A language runtime the server can install versions of, and a project can
 * pick one of. PHP is the only one today; Node, .NET, Cargo and the rest are
 * each one more of these, registered in `registry.ts` -- the manager, the
 * routes and the settings card need nothing new for them.
 *
 * An installed version is a folder, `RUNTIMES_ROOT/{id}/{version}`, holding
 * `bin/{binary}` for every name in `binaries`. A project uses one by having
 * those names linked into its own bin folder, which every process it starts
 * has first on PATH (manager.ts).
 */
export interface RuntimeProvider {
  readonly id: RuntimeId;
  /** The commands a project gets on PATH: `bin/{name}` in every installed version. */
  readonly binaries: readonly string[];

  /** What can be downloaded for this machine, any order. Throws when the list cannot be had. */
  listAvailable(signal?: AbortSignal): Promise<RuntimeRelease[]>;

  /**
   * Puts `release` into `dir` -- empty, already created, and renamed into
   * place only once this returns -- so that `dir/bin/{binary}` runs and is
   * that version. Throws on anything short of that.
   */
  install(release: RuntimeRelease, dir: string, context: InstallContext): Promise<void>;

  /** The version a binary reports, or null when it does not run. Bare names go through PATH. */
  versionOf(bin: string): Promise<string | null>;

  /** What the project's own files require (`composer.json`'s `require.php`), if they say. */
  constraintOf?(root: string): string | null;
}

export interface RuntimeRelease {
  version: string;
  url: string;
}

export interface InstallContext {
  signal?: AbortSignal;
  onProgress?(received: number, total: number | null): void;
}
