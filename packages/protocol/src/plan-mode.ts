/**
 * Plan mode (`/plan` in the composer), as Claude Code's and Codex's CLIs
 * have it.
 *
 * A message sent in plan mode is a `draft` turn: the agent reads and
 * searches but changes nothing, asks the person whatever it needs to
 * confirm, and -- once it has what it needs -- writes the plan between the
 * `<proposed_plan>` tags. The chat offers to run a plan it finds there; the
 * person's yes is a `run` turn, which carries the plan out to the end.
 */
export const PLAN_OPEN = "<proposed_plan>";
export const PLAN_CLOSE = "</proposed_plan>";

/** What a draft turn is told ahead of the person's message. */
export const PLAN_DRAFT_RULES = `<plan-mode>
You are in plan mode. Plan only: do not edit, create or delete files, do not commit, install or run anything that changes the workspace or the outside world. Read, search and run read-only commands as much as the plan needs.

1. Work out what the person is asking for and look at the code it touches. Resolve every fact you can discover with your tools -- reading, searching, read-only commands -- before asking anything.
2. If the goal, the scope or a choice between approaches is still not clear, ask short numbered questions and end your turn there, without a plan. Ask only what changes the plan; do not ask what the code already answers.
3. Once you have what you need -- the person's answers, or nothing left to ask -- write the final plan between ${PLAN_OPEN} and ${PLAN_CLOSE}, in Markdown: the goal in one line, numbered steps (each naming the files it changes), how the result will be verified, and any risks. Make it decision-complete: every choice made, so it can be carried out without further questions. Then end your turn without starting on it: the person approves the plan in the chat, and it is carried out after that.
</plan-mode>`;

/** Ahead of a draft turn's message. */
export function planDraftPrompt(text: string): string {
  return `${PLAN_DRAFT_RULES}\n\n${text}`;
}

/**
 * What a run turn is told: the approved plan, to carry out to the end. The
 * plan rides in the prompt rather than relying on the history, so it holds
 * after the session has compacted.
 */
export function planRunPrompt(plan: string, text: string): string {
  return `<approved-plan>
${plan.trim()}
</approved-plan>

The person approved the plan above. Carry it out now, every step, in order, to the end, without stopping to ask unless you are blocked on something only they can decide. Plan mode is over: edit files and run commands as the steps need. Verify the result as the plan says, and finish with a short account of what was done and what the checks showed.

${text}`;
}

/**
 * The newest finished plan in an agent's text, without its tags, or null.
 * An open tag with no close yet is a plan still being written: not one.
 */
export function proposedPlanIn(text: string): string | null {
  const close = text.lastIndexOf(PLAN_CLOSE);
  if (close === -1) return null;
  const open = text.lastIndexOf(PLAN_OPEN, close);
  if (open === -1) return null;
  const plan = text.slice(open + PLAN_OPEN.length, close).trim();
  return plan || null;
}

/** The text as the chat shows it: the plan's tags gone, its Markdown kept. */
export function stripPlanTags(text: string): string {
  return text.split(PLAN_OPEN).join("").split(PLAN_CLOSE).join("");
}
