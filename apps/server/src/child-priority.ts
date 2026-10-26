import { accessSync, constants } from "node:fs";
import { execFileSync } from "node:child_process";
import { delimiter, join, resolve } from "node:path";

/**
 * What the kernel should give up first when the container runs short.
 *
 * Everything the server starts on someone's behalf -- the CLIs, the agent's
 * tool calls, terminals and the dev servers run in them -- starts with a
 * raised OOM score and a lower CPU and I/O priority, so a runaway dev server
 * is killed and a busy build yields before the API or Postgres does. Raising
 * a child's score needs no privilege; lowering the server's own would.
 *
 * The prefix is `choom -n <adj> -- nice -n <n> ionice -c2 -n7`. Each of them
 * sets its value and execs the next, so the child keeps the pid, process
 * group and signals it would have had without them. Never an address-space
 * limit (`prlimit --as`): V8 reserves large ranges up front, and a Node
 * child such as Claude Code would not start.
 */
export interface ChildPriority {
  /** `oom_score_adj`, 0..1000: higher is killed sooner. */
  oomScoreAdj: number;
  /** 0..19: higher yields the CPU sooner. */
  nice: number;
}

/**
 * A terminal's: shells are interactive, so they go after the background
 * work -- never sooner than it, whatever `CHILD_OOM_ADJ` and `CHILD_NICE` say.
 */
export function terminalPriority(children: ChildPriority): ChildPriority {
  return { oomScoreAdj: Math.min(500, children.oomScoreAdj), nice: Math.min(5, children.nice) };
}

/** Puts a child's argv behind the priority prefix. */
export type ArgvWrapper = (argv: readonly string[], env?: NodeJS.ProcessEnv, cwd?: string) => string[];

/** The bare argv: what children run with when the tools are missing. */
export const unwrapped: ArgvWrapper = (argv) => [...argv];

/** `name` on `path` (or, with a slash in it, from `cwd`), as an absolute path, or null. */
export function which(name: string, path = process.env.PATH ?? "", cwd = process.cwd()): string | null {
  const candidates = name.includes("/")
    ? [resolve(cwd, name)]
    : path.split(delimiter).filter(Boolean).map((dir) => resolve(cwd, join(dir, name)));
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      /* next */
    }
  }
  return null;
}

/** The tools the prefix needs, by absolute path, so a child's own PATH cannot hide them. */
export interface PriorityTools {
  choom: string;
  nice: string;
  ionice: string;
}

export function prefixFor(tools: PriorityTools, priority: ChildPriority): string[] {
  const { choom, nice, ionice } = tools;
  return [choom, "-n", String(priority.oomScoreAdj), "--", nice, "-n", String(priority.nice), ionice, "-c2", "-n7"];
}

/**
 * A wrapper that prefixes `priority`. A command that is not on the child's
 * PATH runs bare, so it fails as it always did -- `spawn` reporting ENOENT
 * -- rather than as `choom` saying it could not exec it.
 */
export function wrapperFor(tools: PriorityTools, priority: ChildPriority): ArgvWrapper {
  const prefix = prefixFor(tools, priority);
  return (argv, env, cwd) => {
    const [command] = argv;
    if (!command || !which(command, env?.PATH ?? process.env.PATH, cwd)) return [...argv];
    return [...prefix, ...argv];
  };
}

/**
 * Finds the tools and runs the prefix once, at boot. Null, with the reason,
 * when a tool is missing or the prefix fails here (a kernel or sandbox that
 * refuses one of them): children then run bare.
 */
export function probePriorityTools(
  priority: ChildPriority,
  run: (argv: string[]) => void = ([file, ...args]) => {
    execFileSync(file!, args, { stdio: "ignore", timeout: 10_000 });
  },
): { tools: PriorityTools } | { tools: null; reason: string } {
  const found = { choom: which("choom"), nice: which("nice"), ionice: which("ionice") };
  const missing = Object.entries(found).filter(([, path]) => !path).map(([name]) => name);
  if (missing.length > 0) return { tools: null, reason: `${missing.join(", ")} not found` };
  const tools = found as PriorityTools;
  try {
    run([...prefixFor(tools, priority), process.execPath, "-e", ""]);
  } catch (error) {
    return { tools: null, reason: error instanceof Error ? error.message : String(error) };
  }
  return { tools };
}
