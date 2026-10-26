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

  /**
   * The shared servers projects' development databases are created on, as an
   * account that may create databases and nothing more privileged. Either one
   * unset makes that engine unavailable to new projects; empty counts as
   * unset, because Compose passes an unset variable through as "".
   */
  DEV_POSTGRES_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  DEV_MYSQL_URL: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),

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

  /**
   * The web app behind this server, in the single container: everything that
   * is not the API is streamed to it (see web-proxy.ts). Unset in development,
   * where `next dev` has its own port. `WEB_STATIC_DIR` is its build's
   * `.next/static`, served from disk.
   */
  WEB_UPSTREAM: z.preprocess((v) => (v === "" ? undefined : v), z.string().url().optional()),
  WEB_STATIC_DIR: z.preprocess((v) => (v === "" ? undefined : v), z.string().optional()),

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
   * Where OpenRouter is. Only a load test changes it, to point the native
   * loop at `scripts/load/mock-openrouter.mjs`; nothing else speaks
   * OpenRouter's API.
   */
  OPENROUTER_BASE_URL: z
    .string()
    .url()
    .default("https://openrouter.ai/api/v1")
    .transform((url) => url.replace(/\/+$/, "")),

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
   * The document pipeline behind the composer's Documentation toggle.
   *
   * The kit -- scripts, templates, skills -- ships in `packages/agent/doc-kit`
   * and is found from there unless moved. The interpreter is the one with
   * python-docx, pypdf, pdfplumber and vl-convert installed (the image's
   * venv). The vision model reads page renders and figures for
   * `doc_inspect`, billed to the person's own key like search.
   */
  DOC_KIT_DIR: z.string().optional(),
  DOC_PYTHON: z.string().default("python3"),
  DOC_VISION_MODEL: z.string().default("google/gemini-2.5-flash"),
  /**
   * Document renders run at once, across all turns: an office suite or a
   * headless browser each, so on a small server the rest wait their turn.
   */
  DOC_JOBS_MAX: z.coerce.number().int().positive().default(1),

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

  /**
   * CLI-provider turns running at once on the whole server. Each is a
   * process of about 400 MB; five fit the memory left beside Postgres, the
   * API and Next.js in a 7 GB container. A turn over the limit waits for a
   * slot, and the thread says how many are ahead (`turn-scheduler.ts`).
   */
  AGENT_MAX_CONCURRENT_TOTAL: z.coerce.number().int().positive().default(5),

  /** Native turns running at once on the whole server, diagram jobs included; likewise. */
  AGENT_MAX_NATIVE_TOTAL: z.coerce.number().int().positive().default(32),

  /** The vendor CLIs. Bare names resolve through PATH; absolute paths pin. */
  CLAUDE_BIN: z.string().default("claude"),
  CODEX_BIN: z.string().default("codex"),

  GITHUB_CLIENT_ID: z.string().optional(),
  GITHUB_CLIENT_SECRET: z.string().optional(),

  /**
   * Who may sign in with GitHub, by login and by organisation membership
   * (comma-separated, case-insensitive). Either list admits. With both
   * empty, GitHub sign-in admits only accounts that already exist here:
   * every account gets a shell, so "anyone with a GitHub account" is never
   * the default.
   */
  GITHUB_ALLOWED_USERS: z.string().optional().transform(csvLower),
  GITHUB_ALLOWED_ORGS: z.string().optional().transform(csvLower),

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

  /**
   * The bearer token `/metrics` asks for. Unset, it answers loopback only:
   * a scraper inside the container, or `docker exec ... curl`. Set it to
   * scrape from elsewhere; it is the only thing standing between the
   * numbers and the internet, so it must not be guessable.
   */
  METRICS_TOKEN: z.string().min(16).optional(),

  /**
   * Where the watchdog POSTs an alert (watchdog.ts): memory near the limit,
   * a lagging event loop, an OOM kill, a backed-up engine. JSON with the
   * message in `text`, for ntfy or a Slack-compatible hook. Unset, alerts
   * are only logged, at error.
   */
  ALERT_WEBHOOK_URL: z.string().url().optional(),

  /**
   * Log every resource sample (resource-sampler.ts: memory and CPU by
   * service and kind of child, and the cgroup's figures), one line each
   * 15 s. Off, the figures are on `/metrics` only.
   */
  LOG_RESOURCE_SAMPLES: z
    .string()
    .optional()
    .transform((v) => v === "true" || v === "1"),

  /**
   * Connections the server's database pool may open. Postgres allows 200 by
   * default here (deploy/s6/s6-rc.d/postgres/run), shared with the projects'
   * dev servers.
   */
  DB_POOL_MAX: z.coerce.number().int().min(5).default(20),

  /**
   * Commands the engine handles at once, each on a different project (one
   * project's run in order). Every one can hold a database connection, so it
   * must stay at least 4 below `DB_POOL_MAX`, leaving room for the routes and
   * reactors; a larger value is refused at boot.
   */
  ENGINE_MAX_PARALLEL: z.coerce.number().int().positive().default(8),

  /**
   * What everything the server starts for someone -- CLIs, agent tool calls,
   * dev servers -- runs with: an `oom_score_adj` (0..1000; higher is killed
   * sooner) and a `nice` value (0..19). Terminals get at most 500 and 5. See
   * child-priority.ts.
   */
  CHILD_OOM_ADJ: z.coerce.number().int().min(0).max(1000).default(800),
  CHILD_NICE: z.coerce.number().int().min(0).max(19).default(10),

  /** The server log's level. Unset: `info` in production, `debug` otherwise. */
  LOG_LEVEL: z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),

  /**
   * Requests are not logged one by one; only those slower than this (ms),
   * and every 5xx. `/metrics` counts the rest.
   */
  LOG_SLOW_MS: z.coerce.number().int().min(0).default(1000),

  /**
   * How long a turn's streamed tokens are held to go out together, in ms:
   * one frame per run rather than per token. The first token of a turn is
   * never held.
   */
  STREAM_FLUSH_MS: z.coerce.number().int().min(0).max(1000).default(40),

  /**
   * Thread events kept in memory for the agent's context, across all
   * threads: the least recently used thread goes first, and a thread longer
   * than half of this is read from the database each turn instead.
   */
  HISTORY_CACHE_EVENTS: z.coerce.number().int().min(0).default(20_000),

  /**
   * Terminals open at once: in one project, for one person, and on the
   * whole server. Over a limit the terminal says so; nothing queues.
   */
  TERMINAL_MAX_PER_PROJECT: z.coerce.number().int().positive().default(10),
  TERMINAL_MAX_PER_USER: z.coerce.number().int().positive().default(5),
  TERMINAL_MAX_TOTAL: z.coerce.number().int().positive().default(40),
  /** A terminal nobody has typed into for this long is closed. */
  TERMINAL_IDLE_MINUTES: z.coerce.number().int().positive().default(15),
});

export type Config = Readonly<z.infer<typeof Env>>;

function csvLower(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((v) => v.trim().toLowerCase())
    .filter(Boolean);
}

/** The server log's level: `LOG_LEVEL`, or `info` in production and `debug` otherwise. */
export function logLevel(config: Config): NonNullable<Config["LOG_LEVEL"]> {
  return config.LOG_LEVEL ?? (config.NODE_ENV === "production" ? "info" : "debug");
}

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

  // Checked against the environments that may have it rather than the one
  // that may not: `NODE_ENV` defaults to development, so a server started
  // outside the image with no `NODE_ENV` at all would otherwise come up open.
  // The bypass has to be asked for in an environment that says what it is.
  if (config.DEV_AUTH_BYPASS && source.NODE_ENV !== "development" && source.NODE_ENV !== "test") {
    throw new Error("DEV_AUTH_BYPASS is only allowed when NODE_ENV is explicitly development or test");
  }
  // Every command in flight can hold a connection for its transaction; the
  // routes and reactors need the rest of the pool.
  if (config.ENGINE_MAX_PARALLEL > config.DB_POOL_MAX - 4) {
    throw new Error(
      `ENGINE_MAX_PARALLEL (${config.ENGINE_MAX_PARALLEL}) must be at most DB_POOL_MAX - 4 (${config.DB_POOL_MAX - 4})`,
    );
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
