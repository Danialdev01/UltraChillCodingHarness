import { z } from "zod";

import { RUNTIME_SELECTION_PATTERN } from "./plain.js";

/**
 * `.agent/runtimes.json`: which version of each language runtime a project
 * uses. Committed with the repository, so the choice travels with it, and
 * readable by the agents. Absent, or a runtime absent from it, means
 * `latest`.
 *
 *   { "php": { "version": "8.4" } }
 */

export const RuntimeSelection = z
  .string()
  .trim()
  .regex(RUNTIME_SELECTION_PATTERN, "latest, system, a line like 8.4, or a version like 8.4.12");

export const RuntimeChoice = z.object({ version: RuntimeSelection });
export type RuntimeChoice = z.infer<typeof RuntimeChoice>;

/** Unknown runtimes are kept as they are, so a newer server's file survives an older one. */
export const RuntimesFile = z.object({ php: RuntimeChoice.optional() }).passthrough();
export type RuntimesFile = z.infer<typeof RuntimesFile>;
