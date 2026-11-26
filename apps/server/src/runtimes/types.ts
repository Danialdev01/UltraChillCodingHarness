import type { RuntimeId } from "@ucch/protocol";

/**
 * A language runtime the server can install versions of, and a project can
 * pick one of: PHP, Composer, Node, Bun, .NET and Rust, registered in
 * `registry.ts` -- the manager, the routes and the settings card need
 * nothing new for another.
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

  /**
   * The selection a constraint means, when it names one outright:
   * `rust-toolchain.toml`'s `nightly`, `global.json`'s `9.0.100`. Null when
   * the constraint is a range the selection cannot say.
   */
  selectionFor?(constraint: string): string | null;

  /** Variables a process using `version` (installed at `dir`) needs: `DOTNET_ROOT`, `RUSTUP_TOOLCHAIN`. */
  processEnv?(dir: string, version: string): Record<string, string>;

  /** What else an uninstall removes besides the version's folder (rustup's toolchain). */
  remove?(version: string): Promise<void>;
}

export interface RuntimeRelease {
  version: string;
  url: string;
  /** `lts`, from the index: what the `lts` selection picks. Kept beside an installed version. */
  tags?: string[];
  /** The download's digest, when the index publishes one: checked before anything is unpacked. */
  sha256?: string;
  sha512?: string;
}

export interface InstallContext {
  signal?: AbortSignal;
  onProgress?(received: number, total: number | null): void;
}
