import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { users, workspaces, type Database } from "@ucch/db";
import type { CliProviderId, ProviderId, ReasoningEffort } from "@ucch/protocol";
import {
  isOmpCredentialEnv,
  ompGuardHookSource,
  PROVIDER_LABELS,
  type AgentProvider,
  type CliProviders,
  type ProcessHost,
  type ProviderHealth,
  type RunContext,
} from "@ucch/providers";
import type { Config } from "./config.js";
import { cliProvidersEnabled } from "./config.js";
import { isDefaultProfile, profileKey, type ProfileRef } from "./profile-ref.js";
import { SubscriptionQuotaService } from "./quotas.js";

export { isDefaultProfile, profileKey, type ProfileRef };
import { terminalEnv } from "./terminals.js";

/**
 * Everything the CLI providers need from the server and must not reach for
 * themselves: the credential directories, the environment a run gets, the
 * account's stored token, and the answer to "can this person use this
 * provider right now".
 *
 * The rules from the spec, in code rather than in prose:
 *
 * - Credential directories are per **subject**, never per project: a user,
 *   or a workspace's dedicated subscription (`ws-<id>`, see
 *   `workspaceSubject`). Two projects billed to one subject share one
 *   login; two people never share one unless a workspace says so.
 * - `0700`, and the server never reads what is in them. Its job is to name
 *   the directory, not to parse it.
 * - The server never reads, copies or forwards what a CLI's sign-in wrote,
 *   and never holds a Claude token of its own: a login happens only in the
 *   CLI's own flow, in a terminal (Claude Code legal and compliance). Usage
 *   is asked of the CLI too (`quotas.ts`).
 */

/** A probe is cached this long per user, so the settings page is cheap to refresh. */
const HEALTH_TTL_MS = 30_000;

/**
 * The subject's OMP settings, below every run's overlay. Only what must hold
 * for every turn: a process started without `--resume` is a new session,
 * never "the most recent one in this directory", which would be another
 * thread's.
 */
const OMP_AGENT_CONFIG = "# Managed by UCCH; rewritten when it differs.\nautoResume: false\n";

/** Worker output an OMP turn keeps per subagent (solution §3.3). */
const OMP_TASK_MAX_OUTPUT_BYTES = "65536";

/** Writes `content` to `path` unless it already holds exactly that. */
function writeIfChanged(path: string, content: string): void {
  if (existsSync(path) && readFileSync(path, "utf8") === content) return;
  writeFileSync(path, content, { mode: 0o600 });
}

export type LoginProgram = "claude-login" | "codex-login";

export interface ProviderCard extends ProviderHealth {
  modelsAuthoritative?: boolean;
  id: ProviderId;
  label: string;
  /** False when the server refuses this provider outright, whatever its health. */
  enabled: boolean;
  models: readonly { id: string; name: string; efforts?: readonly ReasoningEffort[] }[];
}

/**
 * The credential subject for a workspace's dedicated subscription. Every
 * method below that takes a `userId` accepts one of these in its place:
 * the directories live beside the users' under `CREDS_ROOT`, and the stored
 * keys are read from the workspace row instead.
 */
export function workspaceSubject(workspaceId: string): string {
  return `ws-${workspaceId}`;
}

/** The workspace id inside a subject, or null for a user. */
export function workspaceOfSubject(subject: string): string | null {
  return subject.startsWith("ws-") ? subject.slice(3) : null;
}

interface Cached {
  at: number;
  cards: Record<ProviderId, ProviderCard>;
}

export class ProviderService {
  readonly #cache = new Map<string, Cached>();
  /** A named (non-Default) account's probe, by `profileKey`. */
  readonly #profileCache = new Map<string, { at: number; card: ProviderCard }>();
  /** Each subject's plan usage, as its CLIs report it. */
  readonly quotas = new SubscriptionQuotaService({
    rateLimits: async (subject, id, profile) => {
      const provider = this.providers[id];
      if (!provider?.rateLimits) throw new Error(`${PROVIDER_LABELS[id]} cannot report its usage`);
      const { ctx } = await this.resolve(subject, id, profile ? { profile } : {});
      return provider.rateLimits(ctx(this.config.WORKSPACE_ROOT));
    },
    signedIn: async (subject, id, profile) => {
      const card = isDefaultProfile(id, profile)
        ? (await this.health(subject))[id]
        : await this.profileHealth(subject, id, profile!);
      return card.authenticated && card.authMode !== "api-key";
    },
  });

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly host: ProcessHost,
    private readonly providers: CliProviders,
    /**
     * The folder to put first on PATH for a run in `cwd`: the project's
     * runtime versions (runtimes/manager.ts `pathFor`), so a CLI agent's
     * `php` is the one the project's terminal runs.
     */
    private readonly runtimePath?: (cwd: string) => string | null,
  ) {}

  /**
   * The provider object, or null for the native loop, for anything unknown,
   * and for `omp` until its provider is registered.
   */
  provider(id: ProviderId): AgentProvider | null {
    return id === "native" ? null : (this.providers[id] ?? null);
  }

  /**
   * A CLI's login folder: the subject's, and inside it the named account's
   * (`profile`) or the Default one. OMP has no accounts, only the one
   * folder, billed to an API key.
   */
  credsDir(userId: string, id: CliProviderId, profile?: ProfileRef | null): string {
    return join(this.config.CREDS_ROOT, userId, id === "omp" || !profile ? id : profile.dirName);
  }

  /**
   * Makes the credential directory, `0700`, owned by whoever the server runs
   * as -- which, until there is a container, is who the CLI runs as too.
   *
   * Synchronous because `TerminalReactor.#open` is: a login terminal must
   * exist before the first keystroke arrives, and this is one local mkdir.
   */
  ensureCredsDir(userId: string, id: CliProviderId, profile?: ProfileRef | null): string {
    const dir = this.credsDir(userId, id, profile);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (id === "codex") {
      // The default `auto` store tries the OS keyring first, and a server
      // process has none; without this the login succeeds and vanishes.
      const config = join(dir, "config.toml");
      if (!existsSync(config)) {
        writeFileSync(config, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      }
    }
    if (id === "omp") {
      // `agent/` is PI_CODING_AGENT_DIR: OMP's settings and any login.
      // Sessions, per-turn overlays and isolated workers' worktrees each
      // get their own directory beside it.
      for (const sub of ["agent", "sessions", "run", "wt"]) mkdirSync(join(dir, sub), { recursive: true, mode: 0o700 });
      writeIfChanged(join(dir, "agent", "config.yml"), OMP_AGENT_CONFIG);
      // Loaded with `--hook`, the one hook path `--no-extensions` leaves
      // open. Refreshed whenever the server ships a different one.
      writeIfChanged(this.ompGuardHook(userId), ompGuardHookSource());
    }
    return dir;
  }

  /** Where the subject's copy of the OMP guard hook lives (`--hook`). */
  ompGuardHook(userId: string): string {
    return join(this.credsDir(userId, "omp"), "agent", "ucch-guard.ts");
  }

  /** Where the subject's per-turn OMP overlays are written (`omp-overlay.ts`). */
  ompRunDir(userId: string): string {
    return join(this.ensureCredsDir(userId, "omp"), "run");
  }

  /** The subject's `PI_CODING_AGENT_DIR`: what the OMP bridge's calls run with too. */
  ompAgentDir(userId: string): string {
    return join(this.ensureCredsDir(userId, "omp"), "agent");
  }

  /**
   * Where a Claude Code or Codex turn's own files are written -- the MCP
   * config that offers the OMP bridge (`omp-bridge-config.ts`) -- made
   * `0700` on first use, beside the CLI's login.
   */
  cliRunDir(userId: string, id: "claude" | "codex", profile?: ProfileRef | null): string {
    const dir = join(this.ensureCredsDir(userId, id, profile), "run");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * A project's mnemopi bank under the subject (`mnemopi.dbPath`, solution
   * §7.1), its directory made `0700` on first use. One file per project:
   * its threads' worktrees share it, and another project never reads it.
   */
  ompMemoryDb(userId: string, projectId: string): string {
    const dir = join(this.ensureCredsDir(userId, "omp"), "memories", projectId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return join(dir, "mnemopi.db");
  }

  /**
   * A project's OMP sessions under the subject (`--session-dir`), made
   * `0700` on first use. Per project, so `--resume` only ever finds a
   * session of the project it runs in.
   */
  ompSessionDir(userId: string, projectId: string): string {
    const dir = join(this.ensureCredsDir(userId, "omp"), "sessions", projectId);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  }

  /**
   * The environment a provider process gets.
   *
   * The operator's own, minus the harness's secrets (`terminalEnv`), which
   * is what makes the CLI resolve through a version manager the way it does
   * in the terminal. Then the one variable that relocates the CLI's config.
   * `terminalEnv` already strips every
   * `*_API_KEY`, which is the assertion the spec asks for: nothing here can
   * put a run onto API billing.
   *
   * OMP is billed to the workspace's OpenRouter key, which it is handed
   * here, and nothing else: every other variable it would read as a
   * credential is dropped, including the ones `terminalEnv` lets through
   * because they are not named like secrets (`AWS_ACCESS_KEY_ID`). Its
   * guard hook reads the turn's preset from `UCCH_OMP_PRESET`, which is
   * this turn's or absent -- never one the server itself was started with.
   */
  providerEnv(
    userId: string,
    id: CliProviderId,
    options: { openrouterKey?: string; ompPreset?: string; profile?: ProfileRef | null } = {},
  ): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(terminalEnv())) if (value !== undefined) env[name] = value;
    // Not a terminal: no colour, no progress bars, and the CLIs treat CI as
    // "nobody is here to answer a prompt".
    env.TERM = "dumb";
    env.CI = "1";
    // A token the server was started with would sign every run in as
    // whoever minted it; a login is only ever the CLI's own.
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const dir = this.ensureCredsDir(userId, id, options.profile);
    if (id === "claude") {
      env.CLAUDE_CONFIG_DIR = dir;
    } else if (id === "codex") {
      env.CODEX_HOME = dir;
    } else {
      for (const name of Object.keys(env)) if (isOmpCredentialEnv(name)) delete env[name];
      env.PI_CODING_AGENT_DIR = join(dir, "agent");
      env.OMP_WORKTREE_DIR = join(dir, "wt");
      env.OMP_SKIP_SETUP = "1";
      env.PI_TASK_MAX_OUTPUT_BYTES = OMP_TASK_MAX_OUTPUT_BYTES;
      if (options.openrouterKey) env.OPENROUTER_API_KEY = options.openrouterKey;
      delete env.UCCH_OMP_PRESET;
      if (options.ompPreset) env.UCCH_OMP_PRESET = options.ompPreset;
    }
    return env;
  }

  /** The env a login terminal runs the CLI's own sign-in flow under. */
  loginEnv(userId: string, program: LoginProgram, profile?: ProfileRef | null): Record<string, string> {
    const id: CliProviderId = program === "claude-login" ? "claude" : "codex";
    const env = this.providerEnv(userId, id, profile ? { profile } : {});
    // A real terminal after all: the login flow draws a prompt.
    env.TERM = "xterm-256color";
    delete env.CI;
    return env;
  }

  /**
   * What a provider run needs: the provider, and a context for a workspace.
   * `openrouterKey` and `ompPreset` are an OMP run's -- the key decrypted by
   * the caller for this one run; the CLIs never get either.
   */
  async resolve(
    userId: string,
    id: CliProviderId,
    options: { openrouterKey?: string; ompPreset?: string; profile?: ProfileRef | null } = {},
  ): Promise<{ provider: AgentProvider; ctx: (cwd: string) => RunContext }> {
    const provider = this.providers[id];
    if (!provider) throw new Error(`The ${id} provider is not available on this server.`);
    const env = this.providerEnv(userId, id, {
      ...(id !== "omp" && options.profile ? { profile: options.profile } : {}),
      ...(id === "omp" && options.openrouterKey ? { openrouterKey: options.openrouterKey } : {}),
      ...(id === "omp" && options.ompPreset ? { ompPreset: options.ompPreset } : {}),
    });
    return {
      provider,
      ctx: (cwd) => {
        const prefix = this.runtimePath?.(cwd);
        return { cwd, env: prefix ? { ...env, PATH: prependPath(prefix, env.PATH) } : env, host: this.host };
      },
    };
  }

  /** The three cards the settings page shows. Cached briefly per user. */
  async health(userId: string, options: { fresh?: boolean } = {}): Promise<Record<ProviderId, ProviderCard>> {
    const cached = this.#cache.get(userId);
    if (cached && !options.fresh && Date.now() - cached.at < HEALTH_TTL_MS) return cached.cards;

    const row = await this.#storedKeys(userId);

    const enabled = cliProvidersEnabled(this.config);
    const probe = async (id: CliProviderId): Promise<ProviderHealth & { models?: AgentProvider["models"] }> => {
      try {
        const { provider, ctx } = await this.resolve(userId, id);
        const context = ctx(this.config.WORKSPACE_ROOT);
        const health = await provider.probe(context);
        if (health.installed && health.authenticated && provider.listModels) {
          try {
            return { ...health, models: await provider.listModels(context) };
          } catch {
            return { ...health, warnings: [...(health.warnings ?? []), "Could not refresh the model catalogue; showing fallback models."] };
          }
        }
        return health;
      } catch (error) {
        return {
          installed: false,
          authenticated: false,
          authMode: "none",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    };

    const [claude, codex] = await Promise.all([probe("claude"), probe("codex")]);

    const cards: Record<ProviderId, ProviderCard> = {
      native: {
        id: "native",
        label: PROVIDER_LABELS.native,
        installed: true,
        authenticated: Boolean(row?.openrouter),
        authMode: row?.openrouter ? "api-key" : "none",
        enabled: true,
        models: [],
      },
      claude: {
        id: "claude",
        label: PROVIDER_LABELS.claude,
        ...claude,
        enabled,
        models: this.providers.claude.models,
      },
      codex: {
        id: "codex",
        label: PROVIDER_LABELS.codex,
        ...codex,
        enabled,
        models: codex.models ?? this.providers.codex.models,
        modelsAuthoritative: codex.models !== undefined,
      },
      // A turn that names `omp` runs on it, but the card stays off until the
      // settings page has an OMP card to show (OMP plan, OM8.1).
      omp: {
        id: "omp",
        label: PROVIDER_LABELS.omp,
        installed: false,
        authenticated: false,
        authMode: "none",
        enabled: false,
        models: [],
      },
    };
    this.#cache.set(userId, { at: Date.now(), cards });
    return cards;
  }

  /**
   * One named account's card: the CLI's own status check, in that
   * account's folder. The Default account's is `health`'s.
   */
  async profileHealth(
    subject: string,
    id: "claude" | "codex",
    profile: ProfileRef,
    options: { fresh?: boolean } = {},
  ): Promise<ProviderCard> {
    if (isDefaultProfile(id, profile)) return (await this.health(subject, options))[id];
    const key = profileKey(subject, id, profile);
    const cached = this.#profileCache.get(key);
    if (cached && !options.fresh && Date.now() - cached.at < HEALTH_TTL_MS) return cached.card;
    let health: ProviderHealth;
    try {
      const { provider, ctx } = await this.resolve(subject, id, { profile });
      health = await provider.probe(ctx(this.config.WORKSPACE_ROOT));
    } catch (error) {
      health = { installed: false, authenticated: false, authMode: "none", error: error instanceof Error ? error.message : String(error) };
    }
    const card: ProviderCard = {
      id,
      label: PROVIDER_LABELS[id],
      ...health,
      enabled: cliProvidersEnabled(this.config),
      models: this.providers[id].models,
    };
    this.#profileCache.set(key, { at: Date.now(), card });
    return card;
  }

  /**
   * Forgets a probe: after a login, a sign-out or a token change. Every
   * account of the subject, unless one is named.
   */
  invalidate(userId: string, id?: CliProviderId, profile?: ProfileRef | null): void {
    if (id && profile && !isDefaultProfile(id, profile)) {
      const key = profileKey(userId, id, profile);
      this.#profileCache.delete(key);
      this.quotas.forget(key);
      return;
    }
    this.#cache.delete(userId);
    for (const key of this.#profileCache.keys()) if (key.startsWith(`${userId}/`)) this.#profileCache.delete(key);
    this.quotas.forget(userId);
  }

  /**
   * Signs a provider out: the credential directory's contents go. The
   * directory itself stays, mode
   * intact, so the next login has somewhere to land.
   */
  async signOut(userId: string, id: CliProviderId, profile?: ProfileRef | null): Promise<void> {
    const dir = this.credsDir(userId, id, profile);
    // Async, unlike `ensureCredsDir`: a CLI's credential folder can hold a
    // cache of thousands of files, and a recursive delete of that on the
    // event loop stalls every other request while it runs.
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(entries.map((entry) => rm(join(dir, entry), { recursive: true, force: true })));
    this.invalidate(userId, id, profile);
  }

  /** Deletes a named account's folder outright, login and all. */
  async removeProfileDir(userId: string, id: "claude" | "codex", profile: ProfileRef): Promise<void> {
    if (isDefaultProfile(id, profile)) throw new Error("The Default account's folder is not removed; sign it out instead.");
    await rm(this.credsDir(userId, id, profile), { recursive: true, force: true });
    this.invalidate(userId, id, profile);
  }

  /** A subject's stored OpenRouter key, from its user or workspace row. */
  async #storedKeys(subject: string): Promise<{ openrouter: string | null } | undefined> {
    const workspaceId = workspaceOfSubject(subject);
    const table = workspaceId ? workspaces : users;
    const [row] = await this.db
      .select({
        openrouter: table.openrouterKeyEncrypted,
      })
      .from(table)
      .where(eq(table.id, workspaceId ?? subject))
      .limit(1);
    return row;
  }
}

/** `dir` first on a PATH, which may be unset. */
export function prependPath(dir: string, path: string | undefined): string {
  return path ? `${dir}:${path}` : dir;
}
