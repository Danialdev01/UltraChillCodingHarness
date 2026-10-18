import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import { users, workspaces, type Database } from "@ucch/db";
import type { CliProviderId, ProviderId, ReasoningEffort } from "@ucch/protocol";
import {
  PROVIDER_LABELS,
  type AgentProvider,
  type ProcessHost,
  type ProviderHealth,
  type RunContext,
} from "@ucch/providers";
import type { Config } from "./config.js";
import { cliProvidersEnabled } from "./config.js";
import { decryptSecret } from "./crypto.js";
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
 * - The pasted token is decrypted for one spawn's environment and nowhere
 *   else. It is never logged and never put in an event.
 */

/** A probe is cached this long per user, so the settings page is cheap to refresh. */
const HEALTH_TTL_MS = 30_000;

/** A `setup-token` lives a year; the settings page warns from here on. */
export const TOKEN_WARN_AFTER_MS = 11 * 30 * 24 * 3600_000;

export type LoginProgram = "claude-login" | "codex-login";

export interface ProviderCard extends ProviderHealth {
  id: ProviderId;
  label: string;
  /** False when the server refuses this provider outright, whatever its health. */
  enabled: boolean;
  models: readonly { id: string; name: string; efforts?: readonly ReasoningEffort[] }[];
  /** Claude only: the pasted-token state. */
  token?: { configured: boolean; issuedAt: string | null; expiresSoon: boolean };
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

  constructor(
    private readonly db: Database,
    private readonly config: Config,
    private readonly host: ProcessHost,
    private readonly providers: Record<CliProviderId, AgentProvider>,
  ) {}

  /** The provider object, or null for the native loop and for anything unknown. */
  provider(id: ProviderId): AgentProvider | null {
    return id === "claude" || id === "codex" ? this.providers[id] : null;
  }

  credsDir(userId: string, id: CliProviderId): string {
    return join(this.config.CREDS_ROOT, userId, id);
  }

  /**
   * Makes the credential directory, `0700`, owned by whoever the server runs
   * as -- which, until there is a container, is who the CLI runs as too.
   *
   * Synchronous because `TerminalReactor.#open` is: a login terminal must
   * exist before the first keystroke arrives, and this is one local mkdir.
   */
  ensureCredsDir(userId: string, id: CliProviderId): string {
    const dir = this.credsDir(userId, id);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (id === "codex") {
      // The default `auto` store tries the OS keyring first, and a server
      // process has none; without this the login succeeds and vanishes.
      const config = join(dir, "config.toml");
      if (!existsSync(config)) {
        writeFileSync(config, 'cli_auth_credentials_store = "file"\n', { mode: 0o600 });
      }
    }
    return dir;
  }

  /**
   * The environment a provider process gets.
   *
   * The operator's own, minus the harness's secrets (`terminalEnv`), which
   * is what makes the CLI resolve through a version manager the way it does
   * in the terminal. Then the one variable that relocates the CLI's config,
   * and, in token mode, the token itself. `terminalEnv` already strips every
   * `*_API_KEY`, which is the assertion the spec asks for: nothing here can
   * put a run onto API billing.
   */
  providerEnv(userId: string, id: CliProviderId, options: { token?: string } = {}): Record<string, string> {
    const env: Record<string, string> = {};
    for (const [name, value] of Object.entries(terminalEnv())) if (value !== undefined) env[name] = value;
    // Not a terminal: no colour, no progress bars, and the CLIs treat CI as
    // "nobody is here to answer a prompt".
    env.TERM = "dumb";
    env.CI = "1";
    delete env.CLAUDE_CODE_OAUTH_TOKEN;
    const dir = this.ensureCredsDir(userId, id);
    if (id === "claude") {
      env.CLAUDE_CONFIG_DIR = dir;
      if (options.token) env.CLAUDE_CODE_OAUTH_TOKEN = options.token;
    } else {
      env.CODEX_HOME = dir;
    }
    return env;
  }

  /** The env a login terminal runs the CLI's own sign-in flow under. */
  loginEnv(userId: string, program: LoginProgram): Record<string, string> {
    const id: CliProviderId = program === "claude-login" ? "claude" : "codex";
    const env = this.providerEnv(userId, id);
    // A real terminal after all: the login flow draws a prompt.
    env.TERM = "xterm-256color";
    delete env.CI;
    return env;
  }

  /** What a provider run needs: the provider, and a context for a workspace. */
  async resolve(
    userId: string,
    id: CliProviderId,
  ): Promise<{ provider: AgentProvider; ctx: (cwd: string) => RunContext }> {
    const provider = this.providers[id];
    const token = id === "claude" ? await this.claudeToken(userId) : null;
    const env = this.providerEnv(userId, id, token ? { token } : {});
    return { provider, ctx: (cwd) => ({ cwd, env, host: this.host }) };
  }

  /** The three cards the settings page shows. Cached briefly per user. */
  async health(userId: string, options: { fresh?: boolean } = {}): Promise<Record<ProviderId, ProviderCard>> {
    const cached = this.#cache.get(userId);
    if (cached && !options.fresh && Date.now() - cached.at < HEALTH_TTL_MS) return cached.cards;

    const row = await this.#storedKeys(userId);

    const enabled = cliProvidersEnabled(this.config);
    const probe = async (id: CliProviderId): Promise<ProviderHealth> => {
      try {
        const { provider, ctx } = await this.resolve(userId, id);
        return await provider.probe(ctx(this.config.WORKSPACE_ROOT));
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
    const tokenSet = Boolean(row?.token) && Boolean(this.config.SECRET_KEY);
    const issuedAt = tokenSet ? (row?.issuedAt ?? null) : null;

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
        token: {
          configured: tokenSet,
          issuedAt: issuedAt ? issuedAt.toISOString() : null,
          expiresSoon: issuedAt ? Date.now() - issuedAt.getTime() > TOKEN_WARN_AFTER_MS : false,
        },
      },
      codex: {
        id: "codex",
        label: PROVIDER_LABELS.codex,
        ...codex,
        enabled,
        models: this.providers.codex.models,
      },
    };
    this.#cache.set(userId, { at: Date.now(), cards });
    return cards;
  }

  /** Forgets a probe: after a login, a sign-out or a token change. */
  invalidate(userId: string): void {
    this.#cache.delete(userId);
  }

  /**
   * Signs a provider out: the credential directory's contents go, and for
   * Claude the stored token with them. The directory itself stays, mode
   * intact, so the next login has somewhere to land.
   */
  async signOut(userId: string, id: CliProviderId): Promise<void> {
    const dir = this.credsDir(userId, id);
    // Async, unlike `ensureCredsDir`: a CLI's credential folder can hold a
    // cache of thousands of files, and a recursive delete of that on the
    // event loop stalls every other request while it runs.
    const entries = await readdir(dir).catch(() => [] as string[]);
    await Promise.all(entries.map((entry) => rm(join(dir, entry), { recursive: true, force: true })));
    if (id === "claude") {
      const workspaceId = workspaceOfSubject(userId);
      if (workspaceId) {
        await this.db
          .update(workspaces)
          .set({ claudeOauthTokenEncrypted: null, claudeTokenIssuedAt: null })
          .where(eq(workspaces.id, workspaceId));
      } else {
        await this.db
          .update(users)
          .set({ claudeOauthTokenEncrypted: null, claudeTokenIssuedAt: null })
          .where(eq(users.id, userId));
      }
    }
    this.invalidate(userId);
  }

  /** The pasted setup-token, decrypted, or null when there is none usable. */
  async claudeToken(userId: string): Promise<string | null> {
    if (!this.config.SECRET_KEY) return null;
    const row = await this.#storedKeys(userId);
    if (!row?.token) return null;
    try {
      return decryptSecret(row.token, this.config.SECRET_KEY);
    } catch {
      // Encrypted under a key that has since changed. Not usable, and the
      // settings page already says so through `describeKey`.
      return null;
    }
  }

  /** A subject's stored OpenRouter key and Claude token, from its user or workspace row. */
  async #storedKeys(
    subject: string,
  ): Promise<{ openrouter: string | null; token: string | null; issuedAt: Date | null } | undefined> {
    const workspaceId = workspaceOfSubject(subject);
    const table = workspaceId ? workspaces : users;
    const [row] = await this.db
      .select({
        openrouter: table.openrouterKeyEncrypted,
        token: table.claudeOauthTokenEncrypted,
        issuedAt: table.claudeTokenIssuedAt,
      })
      .from(table)
      .where(eq(table.id, workspaceId ?? subject))
      .limit(1);
    return row;
  }
}
