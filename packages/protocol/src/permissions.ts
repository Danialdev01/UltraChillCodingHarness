import { z } from "zod";

/**
 * How much an agent may do before a person is asked.
 *
 *   strict     every call that changes something -- an edit, a command --
 *              waits for an answer. Reads never do.
 *   normal     edits and ordinary commands run; a command that can destroy
 *              work or reach past the project (see `isRiskyCommand`) waits.
 *   allow_all  nothing waits.
 *
 * An account setting, so it follows the person rather than the project. A
 * chat can be loosened to `allow_all` for the rest of its session from the
 * prompt itself, which is the "stop asking me" button.
 */
export const AgentPermissionMode = z.enum(["strict", "normal", "allow_all"]);
export type AgentPermissionMode = z.infer<typeof AgentPermissionMode>;

export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = "normal";

/** What a tool call does, as far as asking about it goes. */
export type ToolCallKind = "read" | "write" | "exec" | "other";

/**
 * Whether a call needs a person's answer under `mode`.
 *
 * `command` is the shell line when the call is one; Normal mode judges a
 * shell call by it, and lets every other kind of call through.
 */
export function needsApproval(
  mode: AgentPermissionMode,
  call: { kind: ToolCallKind; command?: string | null },
): boolean {
  switch (mode) {
    case "allow_all":
      return false;
    case "strict":
      return call.kind !== "read";
    case "normal":
      return typeof call.command === "string" && isRiskyCommand(call.command);
  }
}

/**
 * Programs whose ordinary use deletes, overwrites the system, escalates
 * privilege, or reaches other machines. Matched on the program's base name.
 */
const RISKY_PROGRAMS = new Set([
  "rm",
  "rmdir",
  "shred",
  "truncate",
  "dd",
  "mkfs",
  "fdisk",
  "parted",
  "wipefs",
  "sudo",
  "su",
  "doas",
  "chmod",
  "chown",
  "chgrp",
  "kill",
  "killall",
  "pkill",
  "shutdown",
  "reboot",
  "halt",
  "poweroff",
  "systemctl",
  "service",
  "crontab",
  "mount",
  "umount",
  "iptables",
  "ufw",
  "docker",
  "podman",
  "kubectl",
  "ssh",
  "scp",
  "sftp",
  "nc",
  "ncat",
  "eval",
]);

/** `git` subcommands that rewrite or publish history, or throw work away. */
const RISKY_GIT = new Set(["push", "reset", "clean", "rebase", "filter-branch", "filter-repo", "gc"]);

/** Prefixes that run the command after them; the real program follows. */
const WRAPPERS = new Set(["env", "nohup", "time", "nice", "ionice", "exec", "command", "builtin", "xargs", "timeout", "stdbuf"]);

/** Whole-line patterns: piping a download into a shell, dropping a database, and so on. */
const RISKY_PATTERNS: RegExp[] = [
  // curl … | sh, wget -O- | bash
  /\|\s*(sudo\s+)?(ba|z|da|k)?sh\b/,
  /\bdrop\s+(database|schema|table)\b/i,
  /\btruncate\s+table\b/i,
  // Writing over something outside the project: > /etc/…, >> ~/.bashrc.
  />>?\s*(\/(?!dev\/null\b|tmp\/)|~)/,
  /\bfind\b[^|;&]*\s-(delete|exec\s+rm)\b/,
  /\bartisan\s+(migrate:(fresh|reset|rollback)|db:wipe)\b/,
  /\b(npm|pnpm|yarn)\s+publish\b/,
  /\bgit\s+(checkout|restore)\s+(--\s+)?\.(\s|$)/,
  /\bgit\s+branch\s+-D\b/,
  /\brsync\b.*--delete\b/,
  /:\(\)\s*\{/, // fork bomb
];

/**
 * Whether a shell line can do damage a person should see first.
 *
 * Deliberately a short, readable list rather than a sandbox: it decides
 * when to *ask*, and asking about `npm install` on every turn is how a
 * person learns to click Allow without reading. Anything it misses still
 * runs inside the project's own workspace.
 */
export function isRiskyCommand(command: string): boolean {
  const line = command.trim();
  if (line === "") return false;
  if (RISKY_PATTERNS.some((pattern) => pattern.test(line))) return true;

  // Every command in a chain, a pipeline or a substitution counts.
  const segments = line.split(/&&|\|\||[;|\n&]|\$\(|`|\(|\)/);
  for (const segment of segments) {
    const words = segment.trim().split(/\s+/).filter(Boolean);
    let i = 0;
    // Leading `FOO=bar` assignments and wrappers like `env`, `xargs`.
    while (i < words.length) {
      const word = words[i]!;
      if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(word)) i++;
      else if (WRAPPERS.has(baseName(word))) {
        i++;
        // A wrapper's own flags (`xargs -0`, `timeout 5`) are not the program.
        while (i < words.length && (words[i]!.startsWith("-") || /^\d+[smhd]?$/.test(words[i]!))) i++;
      } else break;
    }
    const program = words[i];
    if (!program) continue;
    const name = baseName(program);
    if (RISKY_PROGRAMS.has(name) || /^mkfs\./.test(name)) return true;
    if (name === "git") {
      // Any later word, not just the first: `git -C repo push` is a push.
      if (words.slice(i + 1).some((word) => RISKY_GIT.has(word))) return true;
    }
  }
  return false;
}

function baseName(word: string): string {
  const slash = word.lastIndexOf("/");
  return slash === -1 ? word : word.slice(slash + 1);
}
