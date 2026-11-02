/**
 * End-of-turn retention for Claude Code and Codex turns (solution §7.3,
 * OM7.2). With the workspace's memory on and `retainCliTurns` set, a
 * completed turn's final answer -- the text of its last assistant message,
 * never a tool's output (§0.2) -- goes on stdin to a one-shot
 * `omp -p --no-session --tools retain` on the `smol` role, under an
 * overlay naming the project's bank. The model keeps what is durable and
 * drops the rest; OMP turns retain for themselves (`autoRetain`).
 */

/** How much of an answer is read: a long one is cut, not paid for whole. */
export const RETAIN_ANSWER_CHARS = 16_000;

export const RETAIN_PROMPT = [
  "The text on stdin is a coding agent's final answer at the end of one turn of work on this project.",
  "Keep in the project's memory only what a later session should know: conventions, decisions and their reasons, lessons from something that went wrong.",
  "Use the retain tool once, with project scope, one self-contained item per fact, at most five.",
  "Never retain secrets, credentials, personal data, or the state or progress of the current task.",
  "If nothing in it is durable, do not call the tool.",
  "Then reply with one line: how many facts you kept.",
].join(" ");

/**
 * The text of an `agent.message`'s content (Anthropic content blocks), or
 * null when it has none -- a message that was only tool calls.
 */
export function messageText(content: readonly unknown[]): string | null {
  const parts: string[] = [];
  for (const block of content) {
    if (block && typeof block === "object" && (block as { type?: unknown }).type === "text") {
      const text = (block as { text?: unknown }).text;
      if (typeof text === "string" && text.trim()) parts.push(text);
    }
  }
  return parts.length ? parts.join("\n\n") : null;
}

/** The answer as the retention run reads it on stdin. */
export function retainStdin(answer: string): string {
  const cut = answer.length > RETAIN_ANSWER_CHARS ? `${answer.slice(0, RETAIN_ANSWER_CHARS)}\n[… cut]` : answer;
  return `<answer>\n${cut}\n</answer>\n`;
}
