/**
 * The composer's `/` menu: which command is being typed, and what it could be.
 *
 * These are the app's own actions -- the buttons around the composer, reached
 * from the keyboard -- not the CLI's commands. They run in the browser and are
 * never sent to the agent; a `/word` that matches none of them is just text,
 * and sends as a message like any other.
 */

export type SlashArg = "model" | "effort" | "harness";

export interface SlashCommand {
  name: string;
  description: string;
  /** What the command chooses between, when it takes a value. */
  takesArg?: SlashArg;
}

export const SLASH_COMMANDS: readonly SlashCommand[] = [
  { name: "clear", description: "Start a fresh conversation" },
  { name: "model", description: "Choose the model", takesArg: "model" },
  { name: "effort", description: "Choose how hard the model thinks", takesArg: "effort" },
  { name: "harness", description: "Choose what runs the agent", takesArg: "harness" },
  { name: "research", description: "Turn research mode on or off" },
  { name: "documentation", description: "Turn documentation mode on or off" },
  { name: "attach", description: "Attach files from your computer" },
];

export interface Slash {
  /** The command word typed so far, without the slash. */
  name: string;
  /** What follows the first space, or null while the name is still being typed. */
  arg: string | null;
}

/**
 * The command the caret is in, if any.
 *
 * Only at the very start of the draft and on its first line: a slash later on
 * is a path or a fraction, and a menu opening over it would be in the way.
 */
export function slashAt(text: string, caret: number): Slash | null {
  if (!text.startsWith("/")) return null;
  const typed = text.slice(1, caret);
  if (caret < 1 || typed.includes("\n")) return null;
  const space = typed.indexOf(" ");
  if (space === -1) return { name: typed, arg: null };
  return { name: typed.slice(0, space), arg: typed.slice(space + 1) };
}

/** The items whose text contains `query`, the ones it starts first. */
export function matchOptions<T>(items: readonly T[], query: string, text: (item: T) => string): T[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...items];
  const starts: T[] = [];
  const contains: T[] = [];
  for (const item of items) {
    const at = text(item).toLowerCase().indexOf(q);
    if (at === 0) starts.push(item);
    else if (at > 0) contains.push(item);
  }
  return [...starts, ...contains];
}

export function matchCommands(commands: readonly SlashCommand[], query: string): SlashCommand[] {
  return matchOptions(commands, query, (command) => command.name);
}
