import type { TextPart } from "./completion.js";
import type { Executor } from "./executor.js";

/** The `context.injected` sources this assembles, in prompt order. */
export type ContextSource = "system_prompt" | "project_context" | "agents_md" | "file_tree";

export interface PromptPart {
  source: ContextSource;
  content: string;
}

export interface PromptInput {
  executor: Executor;
  /** From `projects.stack`, set by the clone reactor. Null before the clone. */
  stack: string | null;
  /**
   * `research` appends the pipeline's rules after the harness's own. Absent
   * is an ordinary turn, and the prompt is byte-for-byte what it always was.
   */
  mode?: "research";
  signal: AbortSignal;
}

/** Files listed in the tree. Enough to orient; not enough to dominate. */
const MAX_TREE_ENTRIES = 200;

/** Bytes of AGENTS.md or CLAUDE.md that make it into the prompt. */
const MAX_INSTRUCTIONS_BYTES = 16_000;

/**
 * The fixed part, and deliberately the first thing in the prefix.
 *
 * Not one interpolated value in it: no timestamp, no working directory, no
 * model name. `plan.md` §10 names a timestamp in the system prompt as a
 * silent cache invalidator, and silent is the problem -- every reply still
 * looks right while every turn pays full price.
 */
const HARNESS_RULES = `You are the coding agent inside UCCH, a cloud coding harness. You are talking to the developer who owns this project, working in their repository.

You have tools. Use them rather than guessing:
- Read and search before you edit. glob finds files by name, grep finds them by content, read_file shows you one.
- Prefer edit_file over write_file for an existing file: it replaces an exact string and fails loudly if that string is not unique, which is what stops a silent wrong edit.
- Paths are relative to the project root. There is no path outside it.
- delete_file removes a file. Use it instead of a shell command; it works even where the shell is not available.
- Every tool argument is required. Send a JSON object with all of the properties, using null for the ones you have no value for, and write numbers and booleans unquoted: {"timeout_ms": 5000}, not {"timeout_ms": "5000"}.
- current_time is the only way you can know today's date. Never state a date without calling it.
- web_search is for anything that changed after your training, and for documentation you are not sure of.

When the developer asks for a document -- a report, a spec, a proposal, a README rendered for sharing, anything that is a file for people rather than for code -- write it as Markdown with write_file, then convert it with pandoc through bash. pandoc is installed. \`pandoc input.md -o output.docx\` for Word, \`-o output.html --standalone\` for a web page, \`-o output.pdf --pdf-engine=typst\` for PDF, \`-o output.epub\` for an e-book; \`--toc\` adds a table of contents. Do not hand-build docx, pptx or PDF bytes, and do not reach for another converter: Markdown in, pandoc out, and say where the file landed.

Be concise and concrete. Say what you did, not what you are about to do. When something is ambiguous, make the reasonable call and say which call you made rather than stopping to ask. When you cannot do something, say so plainly rather than claiming to have done it.`;

/**
 * What a research turn is told on top of the rules above.
 *
 * The order is the whole design: find, then read, then -- only when reading
 * fails -- browse. Each step is a different cost, and a model left to its
 * own devices reaches for the browser agent because it is the most capable,
 * which is exactly backwards. Fixed text, like `HARNESS_RULES`: it sits in
 * the cached prefix of every research turn.
 */
const RESEARCH_RULES = `This is a research turn. The developer wants live, sourced information, not code changes. You have a three-step pipeline, and the order is deliberate:

1. research_search first. It is Perplexity Sonar: a live web search that returns an answer, the URLs it drew on, and a line on each. Run several focused queries rather than one broad one -- one per sub-question, one per claim you need to check.
2. research_read next, on the URLs that matter. It is the Crawl4AI crawler: fast, and fine to call on several URLs in parallel. Read the page before you state anything from it as fact; a search summary is a lead, not a source. If a page is gated -- a bot check, a login wall, a 403 -- research_read escalates it to the browser agent on its own and says so.
3. research_browse only for a page that needs interaction: an app that is empty until something is clicked, results behind a search form, content behind pagination or a collapsed section. It is a model driving a real browser, and it takes minutes; say precisely what to do and what to bring back.

Then write the answer. Cite the URL beside every claim it supports. Keep what the sources confirm separate from what you inferred, and say what you could not find rather than filling it in. Give dates as the sources give them, and call current_time before saying how recent anything is. If asked to save the findings, write them into the repository with write_file; otherwise the answer is the deliverable.`;

/**
 * Assembles the system prompt, stable first and volatile last.
 *
 * `plan.md` §6.4 puts the fixed rules ahead of the detected stack, ahead of
 * the project's own instructions, ahead of the file tree -- because caching
 * is a prefix match, so anything that changes between turns must sit after
 * everything that does not. A tree that gained a file then costs the tree,
 * rather than the whole prompt.
 *
 * Every part is returned separately as well as joined, so the caller can
 * record each one as a `context.injected` event. That is what makes a run
 * exactly reproducible rather than approximately reproducible.
 */
export async function buildPrompt(input: PromptInput): Promise<{
  segments: TextPart[];
  parts: PromptPart[];
}> {
  const parts: PromptPart[] = [{ source: "system_prompt", content: HARNESS_RULES }];

  // Directly after the rules and before anything project-specific: fixed
  // text belongs in the fixed part of the prefix.
  if (input.mode === "research") parts.push({ source: "system_prompt", content: RESEARCH_RULES });

  if (input.stack) {
    parts.push({
      source: "project_context",
      content: `This project's stack is ${input.stack}. Use the conventions and tooling that implies.`,
    });
  }

  const instructions = await readInstructions(input.executor);
  if (instructions) parts.push({ source: "agents_md", content: instructions });

  const tree = await readTree(input.executor, input.signal);
  if (tree) parts.push({ source: "file_tree", content: tree });

  return { segments: segmentsFor(parts), parts };
}

/**
 * Where the reusable prefixes end.
 *
 * Two marks, and both earn their place:
 *
 *  - **after the harness rules**, which are the same bytes for every project
 *    and every turn this harness will ever run. Tools sit ahead of the system
 *    prompt in the cached prefix, so this one mark covers the whole tool
 *    block too -- which is most of the fixed cost;
 *  - **after the last of the project's own context** -- the stack line and
 *    `AGENTS.md` -- which changes when the repository does and not once per
 *    turn.
 *
 * The file tree deliberately gets none. It is the one part that moves when
 * anybody adds a file, and a mark after it would be written far more often
 * than it was read. Left unmarked it is simply the volatile tail: the turn
 * pays for the tree and reads everything before it back.
 */
function segmentsFor(parts: readonly PromptPart[]): TextPart[] {
  // The last part that is not the tree: the project-context boundary.
  let boundary = -1;
  parts.forEach((part, i) => {
    if (part.source !== "file_tree") boundary = i;
  });

  return parts.map((part, i) => ({
    type: "text" as const,
    text: part.content,
    // `i === 0` is the rules; `i === boundary` is the project context. They
    // coincide on a bare project, and one mark is then the right answer.
    ...(i === 0 || i === boundary ? { cacheable: true } : {}),
  }));
}

/**
 * The project's own instructions to its agent, if it has written any.
 *
 * Both names are checked because both conventions are in use, and a
 * repository that has one usually does not have the other.
 */
async function readInstructions(executor: Executor): Promise<string | null> {
  const found: string[] = [];
  for (const name of ["AGENTS.md", "CLAUDE.md"]) {
    try {
      const content = await executor.readFile(name, { maxBytes: MAX_INSTRUCTIONS_BYTES });
      if (content.trim()) found.push(`--- ${name} ---\n${content.trim()}`);
    } catch {
      // Absent, which is the common case and not worth saying anything about.
    }
  }
  return found.length > 0 ? found.join("\n\n") : null;
}

/**
 * A shallow map of the repository, from `rg --files`.
 *
 * ripgrep rather than a walk because `.gitignore` comes free with it, and
 * `node_modules`, `.next` and build output would otherwise be the entire
 * listing. This is what answers "what files are in this project?" before the
 * model calls a single tool.
 */
async function readTree(executor: Executor, signal: AbortSignal): Promise<string | null> {
  const root = executor.root();
  const cached = treeCache.get(root);
  if (cached && Date.now() - cached.at < TREE_TTL_MS) return cached.tree;

  let stdout: string;
  try {
    // `--no-config` before anything else: without it `RIPGREP_CONFIG_PATH`
    // can bend every flag that follows. `safeEnv` does not currently pass
    // that variable through, but the flag costs nothing and does not depend
    // on a decision made in another package to stay correct.
    const result = await executor.exec(["rg", "--no-config", "--files", "--", root], {
      timeoutMs: 15_000,
      signal,
    });
    if (result.exitCode > 1) return remember(root, null);
    stdout = result.stdout;
  } catch {
    // No ripgrep, no workspace yet, or a timeout. The agent still has tools;
    // failing the whole turn over a convenience would be the wrong trade.
    return remember(root, null);
  }

  const prefix = root + "/";
  const paths = stdout
    .split("\n")
    .filter(Boolean)
    .map((path) => (path.startsWith(prefix) ? path.slice(prefix.length) : path))
    .sort();

  if (paths.length === 0) return remember(root, null);

  const shown = paths.slice(0, MAX_TREE_ENTRIES);
  const more =
    paths.length > shown.length
      ? `\n(${paths.length - shown.length} more files; use glob or list_dir to see them)`
      : "";

  return remember(root, `Files in this project:\n${shown.join("\n")}${more}`);
}

/**
 * The tree, kept between turns.
 *
 * `rg --files` over a real repository is not free, and it ran once per turn
 * for an answer that is usually the same one. Two things bound how stale this
 * can get: `invalidateTree` on every `file.changed`, which covers everything
 * the agent itself does, and a short TTL, which covers what it does not --
 * a terminal running `npm install`, a `git pull`, the browser file API.
 *
 * Being briefly out of date is survivable in a way that being wrong is not:
 * the tree is an orientation aid, it is explicitly labelled as partial, and
 * `glob` and `list_dir` are always live.
 */
const TREE_TTL_MS = 60_000;

const treeCache = new Map<string, { tree: string | null; at: number }>();

function remember(root: string, tree: string | null): string | null {
  treeCache.set(root, { tree, at: Date.now() });
  return tree;
}

/** Drops the cached tree for one workspace. Called when a file changes. */
export function invalidateTree(root: string): void {
  treeCache.delete(root);
}
