import type { GitStatus } from "@ucch/protocol"

export function gitRepairPrompt(status: GitStatus, error: string | null): string {
  const conflicts = status.files.filter((file) => file.conflicted).map((file) => file.path)
  return [
    "Help me fix the Git issue in this session's working tree so I can commit and push.",
    `Branch: ${status.branch ?? "detached HEAD"}. Upstream: ${status.upstream ?? "none"}.`,
    error ? `Git reported:\n${error}` : null,
    conflicts.length ? `Conflicted files:\n${conflicts.join("\n")}` : null,
    status.rebaseInProgress ? "A rebase is in progress." : status.mergeInProgress ? "A merge is in progress." : null,
    "Inspect the current Git state first. Preserve my local work and resolve conflicts while keeping the intended changes from both sides. Verify the result and explain anything that needs my input. Leave the changes ready for me to review, commit and push; do not discard work, reset branches, force push, or commit or push automatically.",
  ].filter(Boolean).join("\n\n")
}
