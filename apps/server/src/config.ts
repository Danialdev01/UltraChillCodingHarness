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

  /** Host path bind-mounted into project containers as /workspace. */
  WORKSPACE_ROOT: z.string().default("/srv/ucch/workspaces"),
  PREVIEW_ROOT: z.string().default("/srv/ucch/previews"),

  DOCKER_SOCKET: z.string().default("/var/run/docker.sock"),
  PROJECT_NETWORK: z.string().default("ucch-projects"),
  BASE_IMAGE: z.string().default("ucch/base:latest"),

  ANTHROPIC_API_KEY: z.string().optional(),

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
   * Seeded on boot so a fresh install has a way in before GitHub OAuth is
   * configured. Only created when the email is unused, so restarting never
   * resets a password that has been changed.
   */
  DEFAULT_USER_EMAIL: z.string().email().optional(),
  DEFAULT_USER_PASSWORD: z.string().min(8).optional(),
});

export type Config = Readonly<z.infer<typeof Env>>;

export function loadConfig(source: NodeJS.ProcessEnv = process.env): Config {
  const parsed = Env.safeParse(source);
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
