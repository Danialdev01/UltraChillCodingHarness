import { z } from "zod";

import { FRAMEWORK_IDS } from "./plain.js";

/**
 * `.agent/framework.json`: the framework a project was set up for, and the
 * choices made (plan3 §1.2). Committed beside `runtimes.json` and
 * `commands.json`; the server derives the profile's per-process environment
 * from it at every spawn, so a `git pull` that changes it takes effect.
 *
 *   { "framework": "laravel", "options": { "php": "8.4" }, "appliedAt": "…" }
 *
 * `framework: null` with `dismissed: true` is "not a framework project":
 * the auto-detect offer is not shown again. Unknown keys and unknown
 * options are kept, so a newer server's file survives an older one.
 */

export const FrameworkOptionsRecord = z.record(z.union([z.string().max(200), z.boolean()]));

export const FrameworkFile = z
  .object({
    framework: z.enum(FRAMEWORK_IDS).nullable(),
    options: FrameworkOptionsRecord.default({}),
    appliedAt: z.string().max(40).optional(),
    dismissed: z.boolean().optional(),
    /** Runtime selections the repository's own files decided: `{ "php": "^8.2 (from composer.json)" }`. */
    overrides: z.record(z.string().max(300)).optional(),
    /** The runtime selections this profile asked for: a later change replaces the ones still as set. */
    runtimes: z.record(z.string().max(60)).optional(),
    /**
     * The command buttons this profile added, by id, with a hash of what it
     * wrote: a later change of framework removes the ones nobody edited.
     */
    commands: z.record(z.string().max(80)).optional(),
  })
  .passthrough();
export type FrameworkFile = z.infer<typeof FrameworkFile>;

/** `project.create`'s and `project.framework_set`'s choice. */
export const FrameworkChoiceSchema = z.object({
  id: z.enum(FRAMEWORK_IDS),
  options: FrameworkOptionsRecord.default({}),
  /** Generate a starter project (Empty and New Repo only). */
  scaffold: z.boolean().optional(),
});
export type FrameworkChoiceInput = z.infer<typeof FrameworkChoiceSchema>;
