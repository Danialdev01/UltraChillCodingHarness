/**
 * Field names whose values never reach a log line, whatever object they turn
 * up in. Request logging is off and nothing logs a body today; this is the
 * guarantee that nothing added later can leak a key or a password either.
 * pino's `redact`, so the censoring happens before serialisation.
 */
export const LOG_REDACT = {
  paths: [
    "req.headers.authorization",
    "req.headers.cookie",
    "*.authorization",
    "*.password",
    "*.currentPassword",
    "*.newPassword",
    "*.key",
    "*.apiKey",
    "*.token",
    "*.projectKey",
    "*.oldKey",
    "*.newKey",
    "*.*.password",
    "*.*.projectKey",
    "*.*.key",
    "*.*.apiKey",
    "*.*.token",
  ],
  censor: "[redacted]",
};

const redact = (value: string) => (/^(["']).*\1$/s.test(value) ? `${value[0]}<redacted>${value[0]}` : "<redacted>");

/**
 * Credentials as they show up in a transcript: an environment-style name
 * that says it is one, assigned (`OPENROUTER_API_KEY=...`, `GITHUB_TOKEN:
 * ...`); a config key that is exactly one (`"apiKey": "..."`, `password:
 * ...`) -- not one that merely contains the word, so `maxTokens: 24000`
 * survives; a bearer header; and the vendors' own key prefixes.
 */
const SECRET_PATTERNS: readonly [RegExp, (...groups: string[]) => string][] = [
  [
    /\b([A-Z0-9_]*(?:API_KEY|APIKEY|SECRET|TOKEN|PASSWORD|PASSWD)[A-Z0-9_]*)(\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/g,
    (_match, name, sep, value) => `${name}${sep}${redact(value!)}`,
  ],
  [
    /(["']?)\b(api[_-]?key|secret|client[_-]?secret|password|passwd|token|access[_-]?token|auth[_-]?token|refresh[_-]?token)\1(\s*[=:]\s*)("[^"]*"|'[^']*'|[^\s,}]+)/gi,
    (_match, quote, name, sep, value) => `${quote}${name}${quote}${sep}${redact(value!)}`,
  ],
  [/\b(Bearer\s+)[A-Za-z0-9._~+/=-]{8,}/g, (_match, bearer) => `${bearer}<redacted>`],
  [/\b(?:sk-(?:or-|ant-|proj-)?|ghp_|gho_|github_pat_|xox[abp]-|AKIA|sess-)[A-Za-z0-9_-]{8,}/g, () => "<redacted>"],
  // A JWT (Codex's ChatGPT login is one): three base64url parts, the first a JSON header.
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, () => "<redacted>"],
];

/** The text with anything that looks like a credential replaced by `<redacted>`. */
export function maskSecrets(text: string): string {
  let out = text;
  for (const [pattern, replace] of SECRET_PATTERNS) out = out.replace(pattern, (...args: string[]) => replace(...args));
  return out;
}

/**
 * What the logger runs every line through, on top of `LOG_REDACT`'s field
 * names: a credential by its look, in a message or an error. A CLI's
 * stderr that quotes its own login, a URL with a key in it -- the field
 * names cannot catch those.
 */
export const LOG_SCRUB = {
  hooks: {
    logMethod(this: unknown, args: unknown[], method: (...args: unknown[]) => void) {
      method.apply(this, args.map((arg) => (typeof arg === "string" ? maskSecrets(arg) : arg)));
    },
  },
  serializers: {
    err(error: unknown): { [key: string]: unknown; type: string; message: string; stack: string } {
      if (!(error instanceof Error)) return { type: typeof error, message: maskSecrets(String(error)), stack: "" };
      // The error's own fields (`code`, `status`, …), as pino's serializer keeps them, with strings masked.
      const fields: Record<string, unknown> = {};
      for (const [name, value] of Object.entries(error)) fields[name] = typeof value === "string" ? maskSecrets(value) : value;
      return { ...fields, type: error.name, message: maskSecrets(error.message), stack: maskSecrets(error.stack ?? "") };
    },
  },
};
