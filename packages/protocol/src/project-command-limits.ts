/**
 * The command buttons' limits and names, with no zod in them: the browser
 * takes these from `@ucch/protocol/plain`, and `project-commands.ts` builds
 * the schema of `.agent/commands.json` from them.
 */

import type { ProjectCommand } from "./project-commands.js";

export const PROJECT_COMMANDS_FILE = ".agent/commands.json";
export const PROJECT_COMMANDS_MAX = 30;
export const PROJECT_COMMAND_LABEL_MAX = 40;
export const PROJECT_COMMAND_MAX = 2000;
export const PROJECT_COMMAND_DESCRIPTION_MAX = 300;

/** Icons the header knows how to draw; anything else falls back to `terminal`. */
export const PROJECT_COMMAND_ICONS = [
  "terminal",
  "play",
  "hammer",
  "flask",
  "rocket",
  "database",
  "refresh",
  "package",
  "bug",
  "sparkles",
] as const;
export type ProjectCommandIcon = (typeof PROJECT_COMMAND_ICONS)[number];

/** What `GET /api/projects/:hash/commands` answers: the list, and why the file was not read when it was not. */
export interface ProjectCommandsResponse {
  commands: ProjectCommand[];
  error: string | null;
}
