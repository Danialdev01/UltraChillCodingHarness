/**
 * UCCH's guard for OMP turns (documentation/omp/solution.md §3.9).
 *
 * Copied into the subject's `omp/agent/` by `ensureCredsDir("omp")` and
 * loaded with `--hook <path>`: the one way to load a hook that survives
 * `--no-extensions`, which every UCCH run passes (spike report, OM0.4). It
 * runs inside the OMP process, so it imports nothing but Node builtins, and
 * reads its context from that process: the working directory is the
 * thread's worktree, and `UCCH_OMP_PRESET` names the composer mode.
 *
 * It is the hard floor under the approval table, not the approval table
 * itself: what a permission mode asks for is the overlay's `tools.approval`.
 * What is here holds whatever the mode, and whatever a cloned repository's
 * `.omp/config.yml` managed to relax:
 *
 * - no `git push` or `git commit` (the Git view owns both), and no
 *   `git reset --hard` aimed outside the worktree;
 * - no write, edit or shell outside the worktree, or outside `docs/` in the
 *   documentation preset;
 * - no printing the process environment, where the OpenRouter key is;
 * - no debugger attach to a process outside this turn's process tree;
 * - no subagent that is not one of OMP's bundled agents.
 *
 * The shell rules read the command line, so they stop the plain forms a
 * model reaches for, not a determined script (`eval` can read
 * `process.env` too). That is why they are a floor under the approvals and
 * not a substitute for them. A handler that throws or times out blocks the
 * call ("fails closed"), so a bug here refuses rather than allows.
 */
import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve } from "node:path";

export interface ToolCallEvent {
  toolName: string;
  input: Record<string, unknown> | undefined;
}

export interface GuardContext {
  /** The thread's worktree; everything a turn touches is inside it. */
  worktree: string;
  /** The composer mode; `documentation` confines writes to `docs/`. */
  preset: string | undefined;
  /** The OMP process, whose descendants a debugger may attach to. */
  pid: number;
  /** A process's parent, or null once it is gone. Replaced in tests. */
  parentOf?: (pid: number) => number | null;
}

export type Verdict = { block: true; reason: string } | undefined;

/** OMP's own agents. A project's `.omp/agents/` must not add to them. */
export const BUNDLED_AGENTS = ["scout", "reviewer", "security-reviewer", "sonic", "task", "seance"];

const block = (reason: string): Verdict => ({ block: true, reason: `UCCH: ${reason}` });

/** Whether `path`, resolved from the worktree, stays inside `root`. */
function inside(root: string, worktree: string, path: string): boolean {
  const rel = relative(root, resolve(worktree, path));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * Where a write may land: anywhere in the worktree, or only under `docs/`
 * in the documentation preset.
 */
function writable(ctx: GuardContext, path: string): Verdict {
  if (!inside(ctx.worktree, ctx.worktree, path)) return block(`${path} is outside the worktree`);
  if (ctx.preset === "documentation" && !inside(resolve(ctx.worktree, "docs"), ctx.worktree, path)) {
    return block(`documentation mode writes only under docs/, not ${path}`);
  }
  return undefined;
}

/** The files an `edit` patch names: its `[PATH#TAG]` headers and `MV` targets. */
export function editPaths(patch: string): string[] {
  const paths: string[] = [];
  for (const line of patch.split("\n")) {
    const header = /^\[(.+)#[0-9A-Fa-f]{4}\]\s*$/.exec(line);
    if (header) paths.push(header[1]!);
    const move = /^MV\s+(.+?)\s*$/.exec(line);
    if (move) paths.push(move[1]!.replace(/^(["'])(.*)\1$/, "$2"));
  }
  return paths;
}

function defaultParentOf(pid: number): number | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
  } catch {
    return null;
  }
}

/** Whether `pid` is `root` or one of its descendants. */
function descends(pid: number, root: number, parentOf: (pid: number) => number | null): boolean {
  for (let current: number | null = pid, hops = 0; current && current > 1 && hops < 64; hops++) {
    if (current === root) return true;
    current = parentOf(current);
  }
  return false;
}

/** The shell rules, applied to one command line and the directory it runs in. */
function shell(ctx: GuardContext, command: string, cwd: unknown): Verdict {
  if (typeof cwd === "string" && cwd && !inside(ctx.worktree, ctx.worktree, cwd)) {
    return block(`commands run inside the worktree, not ${cwd}`);
  }
  // A word boundary each side, so `git-push-notes.md` is not a push, but
  // `git -C x push`, `git --no-pager commit` and `&& git push -f` are.
  const git = /(?:^|[\s;&|(`])git(?:\s+-{1,2}[^\s]+(?:\s+[^-\s][^\s]*)?)*\s+(push|commit|reset)\b([^;&|\n]*)/g;
  for (const [, verb, rest] of command.matchAll(git)) {
    if (verb === "push") return block("git push is done from UCCH's Git view");
    if (verb === "commit") return block("commits are made from UCCH's Git view");
    if (verb === "reset" && /--hard/.test(rest ?? "")) {
      const target = /(?:^|\s)-C\s+(\S+)/.exec(command)?.[1] ?? /(?:^|[\s;&|])cd\s+(\S+)/.exec(command)?.[1];
      if (target && !inside(ctx.worktree, ctx.worktree, target)) return block("git reset --hard outside the worktree");
    }
  }
  // `printenv` in any form; `env`, `export -p` and `set` only bare, since
  // `env FOO=1 cmd` and `set -e` are how scripts are written.
  if (
    /(?:^|[\s;&|(`])printenv(?=$|[\s;&|)`])/.test(command) ||
    /(?:^|[;&|(`]\s*|^\s*)(?:env|export\s+-p|declare\s+-x|set)\s*(?=$|[;&|)`])/.test(command)
  ) {
    return block("the process environment is not readable");
  }
  if (/\/proc\/[^\s/]+\/environ/.test(command)) return block("the process environment is not readable");
  return undefined;
}

export function decide(event: ToolCallEvent, ctx: GuardContext): Verdict {
  const input = event.input ?? {};
  switch (event.toolName) {
    case "bash":
      return shell(ctx, String(input.command ?? ""), input.cwd);
    case "write": {
      const path = String(input.path ?? "");
      // `xd://` is a device, not a file: a host tool, or OMP's own
      // rarely-used tools. The debugger is the one that reaches outside.
      if (path.startsWith("xd://")) {
        if (path === "xd://debug") {
          let args: { action?: unknown; pid?: unknown } = {};
          try {
            args = JSON.parse(String(input.content ?? "{}"));
          } catch {
            return block("debug arguments are not JSON");
          }
          if (args.action === "attach") {
            const pid = Number(args.pid);
            if (!Number.isInteger(pid) || !descends(pid, ctx.pid, ctx.parentOf ?? defaultParentOf)) {
              return block(`attach only to this turn's own processes, not pid ${String(args.pid)}`);
            }
          }
        }
        return undefined;
      }
      return writable(ctx, path);
    }
    case "edit": {
      const paths = editPaths(String(input.input ?? ""));
      if (paths.length === 0) return block("an edit must name its files");
      for (const path of paths) {
        const verdict = writable(ctx, path);
        if (verdict) return verdict;
      }
      return undefined;
    }
    case "task": {
      const tasks = Array.isArray(input.tasks) ? input.tasks : [];
      for (const task of tasks) {
        const agent = (task as { agent?: unknown }).agent;
        if (agent !== undefined && !BUNDLED_AGENTS.includes(String(agent))) {
          return block(`subagent ${String(agent)} is not one of OMP's own`);
        }
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The hook OMP loads. */
export default function ucchGuard(pi: { on(event: "tool_call", handler: (event: ToolCallEvent) => Verdict): void }) {
  const ctx: GuardContext = { worktree: process.cwd(), preset: process.env.UCCH_OMP_PRESET, pid: process.pid };
  pi.on("tool_call", (event) => decide(event, ctx));
}
