import { z } from "zod";

/**
 * Configuration is validated once at boot and then treated as frozen. A
 * missing or malformed value should stop the process immediately rather than
 * surface as a confusing failure three layers down at request time.
 */
const Env = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().int().positive().default(3001),
  HOST: z.string().default("0.0.0.0"),

  DATABASE_URL: z.string().url(),

  /** Public root domain. All public URLs are derived from this. */
  ROOT_DOMAIN: z.string().default("ucch.localhost"),
  PUBLIC_SCHEME: z.enum(["http", "https"]).default("http"),
  /**
   * The port appended to preview subdomain URLs. Only needed when nothing
   * sits in front of this server: in development `p8001-{hash}.ucch.localhost`
   * reaches it on :3001, behind Traefik on the scheme's default.
   */
  PUBLIC_PREVIEW_PORT: z.coerce.number().int().min(1).max(65535).optional(),
  /**
   * Where the web app lives, for sending a preview visitor back to sign in.
   * Defaults to the root domain; in development that is `localhost:3000`
   * rather than `ucch.localhost`, which no dev server listens on.
   */
  PUBLIC_WEB_ORIGIN: z.string().url().optional(),

  /** Host path bind-mounted into project containers as /workspace. */
  WORKSPACE_ROOT: z.string().default("/srv/ucch/workspaces"),
  PREVIEW_ROOT: z.string().default("/srv/ucch/previews"),

  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  PROJECT_NETWORK: z.string().default("ucch-projects"),
  BASE_IMAGE: z.string().default("ucch/base:latest"),

  ANTHROPIC_API_KEY: z.string().optional(),

  /**
   * The model a turn uses when the client does not name one. An id rather
   * than a provider choice: the key is OpenRouter's, and OpenRouter routes.
   */
  DEFAULT_MODEL: z.string().default("anthropic/claude-sonnet-4.5"),

  /**
   * The model that summarises rather than works: `web_search`'s reading of
   * result pages, and the compaction pass that folds a long thread down.
   *
   * Separate from `DEFAULT_MODEL` because these are the two cheapest things a
   * model is asked to do here, and billing them at the coding model's rate
   * made a single search cost about as much as a turn of real work.
   */
  SEARCH_MODEL: z.string().default("google/gemini-2.5-flash"),

  /**
   * The research pipeline behind the composer's Research toggle.
   *
   * Three backends in escalation order. The search model is an OpenRouter
   * id billed to the person's own key, so it needs no configuration beyond
   * a name; Perplexity Sonar is what the pipeline is designed around. The
   * crawler is a Crawl4AI server, reached by URL, and the browser agent is
   * Browser Use's API, reached by key. Each of those two is optional: a
   * research turn without a crawler says so on the first read, and one
   * without a browser agent reports a gated page instead of getting past it.
   */
  RESEARCH_SEARCH_MODEL: z.string().default("perplexity/sonar"),
  /** e.g. `http://127.0.0.1:11235`, the Docker image's default port. Empty disables. */
  CRAWL4AI_URL: z.string().optional(),
  /** The `CRAWL4AI_API_TOKEN` the server was started with, when it was. */
  CRAWL4AI_API_TOKEN: z.string().optional(),
  BROWSER_USE_API_KEY: z.string().optional(),
  /** Override for a self-hosted server that speaks the cloud API. */
  BROWSER_USE_API_URL: z.string().url().optional(),

  /**
   * The hard stop on the agent loop. A model that keeps calling tools without
   * ever answering costs money on every iteration, so the cap is a budget
   * bound as much as a liveness one; hitting it is reported as
   * `stopReason: "max_iterations"` rather than as a failure.
   */
  AGENT_MAX_ITERATIONS: z.coerce.number().int().positive().default(25),

  /**
   * Permits the `shell` plugin -- `bash` on the host, as the server user --
   * in production. Until the container runtime lands this is remote code
   * execution by whichever model the composer selected, so it is opt-in
   * rather than opt-out. See `shellPluginEnabled` below for the exact rule.
   */
  AGENT_ALLOW_HOST_SHELL: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  /**
   * Where each account's CLI credentials live: `{CREDS_ROOT}/{userId}/claude`
   * is that user's `CLAUDE_CONFIG_DIR`, `.../codex` their `CODEX_HOME`. Per
   * user and never per project, so one login serves every project they own
   * and no two accounts ever share one. Exclude it from backups.
   */
  CREDS_ROOT: z.string().default("/srv/ucch/creds"),

  /**
   * CLI-provider turns one account may have in flight at once. A
   * subscription is one human's; several containers hammering it together is
   * how a rate limit gets mistaken for a broken integration.
   */
  AGENT_MAX_CONCURRENT_PER_USER: z.coerce.number().int().positive().default(2),

  /** The vendor CLIs. Bare names resolve through PATH; absolute paths pin. */
  CLAUDE_BIN: z.string().default("claude"),
  CODEX_BIN: z.string().default("codex"),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  /** 32-byte hex key for AES-256-GCM at-rest encryption of stored secrets. */
  SECRET_KEY: z.string().length(64).optional(),

  /**
   * Skips GitHub OAuth and authenticates every connection as a fixed local
   * user. Refused outside development -- an unauthenticated harness with a
   * Docker socket is a root shell on the host.
   */
  DEV_AUTH_BYPASS: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  IDLE_STOP_MINUTES: z.coerce.number().int().positive().default(30),

  /**
   * The largest single file the composer may attach.
   *
   * Bounded because an upload is held in memory before it reaches staging,
   * and because an attachment is context for a question rather than a way to
   * move a disk image into a repository.
   */
  UPLOAD_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),

  /**
   * How long an attachment nobody placed stays staged. Attachments are
   * working memory: past this they are swept, and the conversation that
   * referred to them still records that they existed.
   */
  UPLOAD_TTL_HOURS: z.coerce.number().int().positive().default(24),

  /**
   * Seeded on boot so a fresh install has a way in before GitHub OAuth is
   * configured. Only created when the email is unused, so restarting never
   * resets a password that has been changed.
   */
  DEFAULT_USER_EMAIL: z.string().email().optional(),
  DEFAULT_USER_PASSWORD: z.string().min(8).optional(),
});

export type Config = Readonly<z.infer<typeof Env>>;

/** The origin the browser reaches the web app on. */
export function webOrigin(config: Config): string {
  return config.PUBLIC_WEB_ORIGIN ?? `${config.PUBLIC_SCHEME}://${config.ROOT_DOMAIN}`;
}

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  // An empty value is an unset one. Compose files and hosting dashboards
  // pass every declared variable, blank or not, and `DEFAULT_USER_EMAIL=""`
  // should mean "no default user", not "an invalid email address".
  const present = Object.fromEntries(Object.entries(source).filter(([, v]) => v !== ""));
  const parsed = Env.safeParse(present);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `  ${i.path.join(".")}: ${i.message}`);
    throw new Error(`invalid configuration:\n${issues.join("\n")}`);
  }
  const config = parsed.data;

  if (config.DEV_AUTH_BYPASS && config.NODE_ENV === "production") {
    throw new Error("DEV_AUTH_BYPASS must not be enabled in production");
  }
  // The server needs at least one way to authenticate somebody. Password
  // login, GitHub, or the development bypass all qualify; none of them does
  // not, and starting in that state would produce a server nobody can enter.
  const hasGithub = Boolean(config.GITHUB_CLIENT_ID && config.GITHUB_CLIENT_SECRET);
  const hasDefaultUser = Boolean(config.DEFAULT_USER_EMAIL && config.DEFAULT_USER_PASSWORD);
  if (!config.DEV_AUTH_BYPASS && !hasGithub && !hasDefaultUser) {
    throw new Error(
      "no authentication method configured: set GITHUB_CLIENT_ID/SECRET, or DEFAULT_USER_EMAIL/PASSWORD, or DEV_AUTH_BYPASS",
    );
  }
  return Object.freeze(config);
}

/**
 * Whether the tool registry may load the `shell` plugin.
 *
 * Development gets `bash` unasked -- a harness you cannot run a command in is
 * not much of a harness, and the blast radius is the developer's own machine.
 * Production is the case that has to be chosen deliberately: there the same
 * process holds the Docker socket, so an unguarded `bash` is root on the
 * host. The flag is the whole difference, and it is checked where the plugin
 * loads rather than at boot, so a server without it still starts -- just
 * without `bash`.
 */
export function shellPluginEnabled(config: Config): boolean {
  return config.NODE_ENV !== "production" || config.AGENT_ALLOW_HOST_SHELL;
}

/**
 * Whether the `claude` and `codex` providers may run at all.
 *
 * Until the container runtime lands they are host processes with a shell,
 * exactly what the `shell` plugin is -- so they are held to the same gate
 * rather than opening a second door to the same room.
 */
export function cliProvidersEnabled(config: Config): boolean {
  return shellPluginEnabled(config);
}
