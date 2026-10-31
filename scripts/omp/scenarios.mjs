/**
 * The OMP fixture scenarios (todo OM0.2). Each one is a model script plus the
 * RPC steps that drive it; record-rpc.mjs runs them.
 *
 * Tool arguments follow the schemas the pinned OMP sends the model: every
 * built-in tool takes an `i` (a one-line intent) beside its own fields.
 */

const ECHO_TOOL = {
  name: "ucch_echo",
  label: "Echo",
  description: "Echo text back from the host.",
  parameters: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
};

/** An answer long enough that summarising it frees room. */
const LONG = "word ".repeat(1500).trim();

const terminalEnd = (f) => f.type === "agent_end" && f.isTerminal !== false;
const promptDone = (f) => f.type === "prompt_result";

let ids = 0;
const id = () => `rec-${++ids}`;

/** Sends a command and waits for its response. */
async function command(ctx, frame, ms = 30000) {
  const cid = id();
  ctx.send({ id: cid, ...frame });
  return ctx.waitFor((f) => f.type === "response" && f.id === cid, ms, `response ${frame.type}`);
}

/** One prompt, run to its `prompt_result`. */
async function turn(ctx, message, ms = 60000) {
  await command(ctx, { type: "prompt", message });
  await ctx.waitFor(terminalEnd, ms, "agent_end");
  return ctx.waitFor(promptDone, ms, "prompt_result");
}

/** Approves every tool-approval dialog. */
const approveAll = (f) =>
  f.type === "extension_ui_request" && f.method === "select" && String(f.title).startsWith("Allow tool:")
    ? { type: "extension_ui_response", id: f.id, value: "Approve" }
    : null;

export const scenarios = [
  {
    name: "plain",
    script: [{ text: "Hello from the scripted model." }],
    async run(ctx) {
      await command(ctx, { type: "get_state" });
      await turn(ctx, "Say hello.");
      await command(ctx, { type: "get_session_stats" });
    },
  },
  {
    name: "tool",
    files: { "notes.txt": "alpha\nbeta\n" },
    script: [
      { toolCalls: [{ name: "read", arguments: { i: "read the notes", path: "notes.txt" } }] },
      { toolCalls: [{ name: "write", arguments: { i: "write a summary", path: "summary.txt", content: "two lines\n" } }] },
      { text: "Wrote summary.txt." },
    ],
    async run(ctx) {
      await turn(ctx, "Summarise notes.txt into summary.txt.");
      await command(ctx, { type: "get_session_stats" });
    },
  },
  {
    name: "confirm",
    args: ["--approval-mode", "write"],
    script: [
      { toolCalls: [{ name: "bash", arguments: { i: "list files", command: "ls" } }] },
      { toolCalls: [{ name: "bash", arguments: { i: "print a word", command: "echo denied-run" } }] },
      { text: "Ran both." },
    ],
    // OMP asks for a tool approval with a `select`, not a `confirm`: options
    // "Approve", "Approve <tool> for this session", "Deny".
    onFrame(f) {
      if (f.type !== "extension_ui_request" || f.method !== "select" || !String(f.title).startsWith("Allow tool:")) return null;
      // The first prompt is allowed, the second denied: both paths recorded.
      this.asked = (this.asked ?? 0) + 1;
      return { type: "extension_ui_response", id: f.id, value: this.asked === 1 ? "Approve" : "Deny" };
    },
    async run(ctx) {
      await turn(ctx, "List the files, then echo a word.");
    },
  },
  {
    name: "compaction",
    // Every reply reports 100 prompt tokens, but OMP counts the session
    // itself: three long answers take it far past a 50-token threshold, and
    // the soft method alone keeps the summary the scripted side call gives.
    // A short session is skipped instead ("would not reduce context").
    config: "compaction:\n  methodOrder: [soft]\n  thresholdTokens: 50\n  keepRecentTokens: 10\n",
    script: [{ text: LONG }, { text: LONG }, { text: LONG }, { text: "Fourth answer." }],
    async run(ctx) {
      for (const q of ["First question.", "Second question.", "Third question.", "Fourth question."]) await turn(ctx, q);
      await command(ctx, { type: "compact", customInstructions: "keep the answers" }, 60000);
      // The compaction entry's method and token counts are on the summary
      // message, not on the auto_compaction_end frame.
      await command(ctx, { type: "get_messages" });
      await command(ctx, { type: "get_session_stats" });
    },
  },
  {
    name: "handoff",
    // Handoff only replaces history older than the verbatim tail; with the
    // default 20k tail a short session has nothing to hand off.
    config: "compaction:\n  keepRecentTokens: 10\n",
    script: [
      { text: "The bug is in the parser." },
      { text: "Investigated the bug; next step is the fix." },
      // OMP's handoff request carries tools, so it takes a script entry.
      { when: "Write a handoff document", text: "## Goal\nFix the parser bug.\n## Next\nPatch src/parser.ts." },
    ],
    async run(ctx) {
      await turn(ctx, "Look into the bug.");
      await turn(ctx, "Where exactly?");
      await command(ctx, { type: "handoff", customInstructions: "focus on the fix" }, 60000);
      // The handoff response carries no brief; the session's messages do.
      await command(ctx, { type: "get_messages" });
      await command(ctx, { type: "get_session_stats" });
    },
  },
  {
    name: "subagent",
    files: { "src/a.ts": "export const a = 1;\n" },
    script: [
      {
        toolCalls: [
          {
            name: "task",
            arguments: {
              i: "explore the source",
              context: "A tiny TypeScript repo.",
              tasks: [{ name: "ScoutSrc", agent: "scout", task: "List what src/ exports.", solutionSpace: "Read-only; report exports." }],
            },
          },
        ],
      },
      { when: "List what src/ exports.", text: "src/a.ts exports `a`." },
      { text: "The scout reports that src/a.ts exports a." },
    ],
    async run(ctx) {
      await command(ctx, { type: "set_subagent_subscription", level: "progress" });
      await turn(ctx, "Use a scout to find what src exports.", 90000);
      await command(ctx, { type: "get_subagents" });
    },
  },
  {
    name: "host-tool",
    script: [
      { toolCalls: [{ name: "ucch_echo", arguments: { text: "ping" } }] },
      { text: "The host tool answered." },
    ],
    onFrame(f) {
      if (f.type !== "host_tool_call") return null;
      return {
        type: "host_tool_result",
        id: f.id,
        result: { content: [{ type: "text", text: `echo: ${f.arguments?.text ?? ""}` }] },
      };
    },
    async run(ctx) {
      await command(ctx, {
        type: "set_host_tools",
        tools: [ECHO_TOOL],
      });
      await turn(ctx, "Call ucch_echo with ping.");
    },
  },
  {
    // How a real model reaches a host tool: OMP mounts it as the device
    // xd://<name> (tools.xdev) and lists it in the system prompt, and the
    // model writes the JSON arguments there with the ordinary write tool.
    name: "host-tool-xd",
    script: [
      { toolCalls: [{ name: "write", arguments: { i: "ask the host", path: "xd://ucch_echo", content: JSON.stringify({ text: "ping" }) } }] },
      { text: "The host tool answered." },
    ],
    onFrame(f) {
      if (f.type !== "host_tool_call") return null;
      return {
        type: "host_tool_result",
        id: f.id,
        result: { content: [{ type: "text", text: `echo: ${f.arguments?.text ?? ""}` }] },
      };
    },
    async run(ctx) {
      await command(ctx, { type: "set_host_tools", tools: [ECHO_TOOL] });
      await turn(ctx, "Call ucch_echo with ping.");
    },
  },
  {
    name: "resume",
    script: [{ text: "First session answer." }, { text: "Resumed answer." }],
    async run(ctx) {
      await turn(ctx, "Remember the word kiwi.");
      const state = await command(ctx, { type: "get_state" });
      await command(ctx, { type: "new_session" });
      await command(ctx, { type: "switch_session", sessionPath: state.data.sessionFile });
      await turn(ctx, "What was the word?");
      await command(ctx, { type: "get_state" });
    },
  },
  {
    name: "error",
    script: [{ httpError: 400, message: "This model does not support that request." }],
    async run(ctx) {
      await command(ctx, { type: "prompt", message: "Hello?" });
      await ctx.waitFor(promptDone, 60000, "prompt_result");
    },
  },
  {
    name: "retry",
    script: [{ httpError: 503, message: "overloaded" }, { text: "Answered after a retry." }],
    async run(ctx) {
      await turn(ctx, "Hello?", 120000);
    },
  },
];

export { approveAll };
