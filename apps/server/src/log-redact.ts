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
