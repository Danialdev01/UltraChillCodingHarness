import { z } from "zod";

import {
  PROJECT_COMMAND_DESCRIPTION_MAX,
  PROJECT_COMMAND_LABEL_MAX,
  PROJECT_COMMAND_MAX,
  PROJECT_COMMANDS_MAX,
} from "./plain.js";

/**
 * A project's command buttons, kept in `.agent/commands.json`.
 *
 * The file is the source of truth: the app's header reads it, the Manage
 * dialog writes it, and an agent or a person may edit it by hand. A click
 * sends only the command's `id`; the server reads the command line from the
 * file itself, so a client never hands the terminal a string to run.
 */

export const ProjectCommandId = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "lowercase letters, digits, dashes and underscores");

export const ProjectCommand = z.object({
  id: ProjectCommandId,
  label: z.string().trim().min(1).max(PROJECT_COMMAND_LABEL_MAX),
  command: z.string().trim().min(1).max(PROJECT_COMMAND_MAX),
  description: z.string().trim().max(PROJECT_COMMAND_DESCRIPTION_MAX).optional(),
  icon: z.string().max(40).optional(),
  /** Relative to the project root; the root when absent. Never outside it. */
  cwd: z.string().trim().max(500).optional(),
});
export type ProjectCommand = z.infer<typeof ProjectCommand>;

export const ProjectCommandsFile = z
  .object({ commands: z.array(ProjectCommand).max(PROJECT_COMMANDS_MAX) })
  .refine((file) => new Set(file.commands.map((c) => c.id)).size === file.commands.length, {
    message: "command ids must be unique",
    path: ["commands"],
  });
export type ProjectCommandsFile = z.infer<typeof ProjectCommandsFile>;
