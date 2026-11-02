import { VerifierFinding, VerifierVerdict, type TaskFinding } from "@ucch/protocol";

/**
 * UCCH's roles on OMP (solution §6.4). Custom agents do not run under
 * `--no-extensions` (OM0), so a role is a bundled agent given the role's
 * instructions in the `task` call's `context` and a reply format in its
 * assignment. The prompts live here, next to the code that reads the replies.
 */

/** The verifier's instructions: the `task` call's `context`. */
export const VERIFIER_CONTEXT =
  "Verify the assigned task against its acceptance criteria. Run the project's tests if the task names them. Cite file and line for every finding. Do not edit files.";

/** The verdict the worker ends with, and that the main agent repeats. */
export const VERIFIER_REPLY_FORMAT = [
  "End your answer with one fenced JSON block and nothing after it:",
  "```json",
  '{ "passed": true | false, "reason": "<one or two sentences>", "findings": [{ "file": "<path from the repository root>", "line": <number or null>, "note": "<what is unmet>" }] }',
  "```",
  "`findings` lists every acceptance criterion that is not met, and is empty when the task passes.",
].join("\n");

/**
 * The message for an OMP turn that verifies a task (OM7.9): one `task`
 * worker, the bundled `task` agent, with the verifier's instructions as
 * `context` and `brief` -- the card, its research and what the coding agent
 * reported -- as its assignment. The main agent ends with the worker's
 * verdict, so the thread shows it; UCCH reads it from the worker's answer
 * too, whichever comes through.
 */
export function ompVerifierPrompt(brief: string): string {
  return [
    "## Task verification request",
    "",
    "You are the verification step of an automated task pipeline. Do not do the verification yourself and do not edit files.",
    "",
    'Distribution: Use `task` with a `tasks` array. Set `agent: "task"` inside the `tasks[]` item (`tasks[].agent`), never at the top level or omitted. Create exactly **1 task**.',
    `Set the \`task\` call's \`context\` to: ${VERIFIER_CONTEXT}`,
    "Put everything between the lines below in that task's `task`, unchanged.",
    "",
    "When the worker has finished, end your reply with its JSON block exactly as it gave it.",
    "",
    "---",
    brief.trim(),
    "",
    VERIFIER_REPLY_FORMAT,
    "---",
  ].join("\n");
}

export interface OmpVerdict {
  passed: boolean;
  reason: string;
  findings: TaskFinding[];
}

/**
 * The verdict in a reply: its last JSON block that parses as one, fenced or
 * the reply's last `{ … }`. Null when there is none -- `parseVerdict`'s
 * regex is the caller's fallback.
 */
export function parseVerifierReply(text: string): OmpVerdict | null {
  // The last block wins: an answer that quotes an example first and gives
  // its verdict after is read by the verdict.
  const fenced = [...text.matchAll(/```(?:json)?[ \t]*\r?\n([\s\S]*?)\r?\n[ \t]*```/g)].map((m) => m[1]!).reverse();
  const open = text.lastIndexOf("\n{");
  const start = open === -1 ? text.indexOf("{") : open + 1;
  const end = text.lastIndexOf("}");
  const bare = start !== -1 && end > start ? [text.slice(start, end + 1)] : [];
  for (const candidate of [...fenced, ...bare]) {
    let json: unknown;
    try {
      json = JSON.parse(candidate);
    } catch {
      continue;
    }
    const verdict = VerifierVerdict.safeParse(json);
    if (!verdict.success) continue;
    const findings: TaskFinding[] = [];
    for (const item of verdict.data.findings) {
      const finding = VerifierFinding.safeParse(item);
      if (finding.success) findings.push({ file: finding.data.file.replace(/^\.\//, ""), line: finding.data.line || null, note: finding.data.note });
    }
    const reason = verdict.data.reason || (verdict.data.passed ? "No reason given." : (findings[0]?.note ?? "No reason given."));
    return { passed: verdict.data.passed, reason, findings };
  }
  return null;
}
