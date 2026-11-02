import { z } from "zod";
import { failure, runOmpCall } from "../call.js";
import { tool, where, withText, worktreeState } from "./tool.js";

/** `omp_symbols`' operations, as OMP's `lsp` tool names its actions (18.14.1). */
const LSP_ACTION = {
  definition: "definition",
  references: "references",
  implementations: "implementation",
  type: "type_definition",
  diagnostics: "diagnostics",
} as const;

/** `omp_symbols`: language-server answers, through OMP's `lsp` tool alone (solution §10.2). */
export const ompSymbols = tool({
  name: "omp_symbols",
  description: [
    "Symbol-aware code navigation from a language server: a symbol's definition, its references, its implementations or its type, or a file's diagnostics.",
    "Follows re-exports and shadowing that grep misses. Changes nothing.",
  ].join(" "),
  inputSchema: {
    op: z.enum(["definition", "references", "implementations", "type", "diagnostics"]),
    symbol: z.string().optional().describe("The symbol, as written at the position. Required except for diagnostics."),
    file: z.string().optional().describe("The file it appears in, relative to the project root; for diagnostics, a file or glob."),
    line: z.number().int().positive().optional().describe("Its 1-based line."),
    packageDir: z.string().optional().describe("The package the file belongs to, in a monorepo."),
  },
  annotations: { title: "OMP symbols", readOnlyHint: true, openWorldHint: false },
  run: ({ op, symbol, file, line, packageDir }, ctx) => {
    if (op !== "diagnostics" && !symbol) return Promise.resolve(failure(`${op} needs a symbol`));
    const target = op === "diagnostics" ? `for \`${file ?? "*"}\`` : `of \`${symbol}\`${where(file, line)}`;
    const prompt = [
      `Using the lsp tool only, run its \`${LSP_ACTION[op]}\` action ${target}.`,
      ...(packageDir ? [`The file belongs to the package in \`${packageDir}\`.`] : []),
      "Report every result as `file:line` with that line's code, nothing else. Do not edit anything.",
    ].join(" ");
    return runOmpCall(ctx, { tools: ["lsp", "read"], model: "@smol", prompt, answer: {} });
  },
});

/**
 * `omp_rename`: a language-server rename (solution §10.2). OMP's `lsp`
 * rename applies unless told `apply: false`, so a preview is asked for in
 * the prompt, given no write tool, and checked: a worktree that changed
 * anyway is reported as an error, not as a preview.
 */
export const ompRename = tool({
  name: "omp_rename",
  description: [
    "Renames a symbol everywhere it is used, through the language server, so no call site is missed.",
    "With `apply: false` it only previews the edits; with `apply: true` it makes them.",
  ].join(" "),
  inputSchema: {
    symbol: z.string().min(1),
    file: z.string().min(1).describe("A file the symbol appears in, relative to the project root."),
    line: z.number().int().positive().optional(),
    newName: z.string().min(1),
    apply: z.boolean(),
  },
  annotations: { title: "OMP rename", destructiveHint: false, openWorldHint: false },
  run: async ({ symbol, file, line, newName, apply }, ctx) => {
    const before = apply ? null : await worktreeState(ctx);
    const prompt = apply
      ? `Using the lsp tool's \`rename\` action, rename \`${symbol}\`${where(file, line)} to \`${newName}\`, applying it. Then list every file it changed.`
      : `Using the lsp tool's \`rename\` action with \`apply: false\`, preview renaming \`${symbol}\`${where(file, line)} to \`${newName}\`. Do not apply it and do not change any file. Report every edit it would make, as \`file:line\`: old → new.`;
    const result = await runOmpCall(ctx, {
      tools: apply ? ["lsp", "read", "edit", "write"] : ["lsp", "read"],
      model: "@smol",
      prompt,
      answer: { toolResults: ["lsp"] },
    });
    if (!apply && before !== null && (await worktreeState(ctx)) !== before) {
      return failure("the preview changed files in the worktree although apply was false; check `git status` before going on");
    }
    return result;
  },
});

/**
 * `omp_codemod`: a structural rewrite with OMP's `ast_edit` (solution
 * §10.2). `ast_edit` matches as well as rewrites, so `ast_grep` is not
 * asked for: it exists only with `astGrep.enabled`, off by default, and a
 * `--tools` naming a missing tool stops OMP before `ready` (18.14.1).
 *
 * `ast_edit` only stages a proposal; it is applied by writing to
 * `xd://resolve`, which takes the `write` tool (measured, 18.14.1). Without
 * `apply` the call has no `write`, so the proposal can only be shown -- and
 * since OMP then keeps forcing the model to resolve it, the call ends
 * itself once the proposal is in (`stopAfter`).
 */
export const ompCodemod = tool({
  name: "omp_codemod",
  description: [
    "Makes the same mechanical change across many files by matching syntax, not text (ast-grep patterns such as `oldApi($$$ARGS)` → `newApi($$$ARGS)`).",
    "With `apply: false` it returns the proposed diff and changes nothing; with `apply: true` it applies it.",
  ].join(" "),
  inputSchema: {
    description: z.string().min(1).describe("The change, in words."),
    pattern: z.string().optional().describe("An ast-grep pattern to match."),
    rewrite: z.string().optional().describe("Its replacement template."),
    language: z.string().optional().describe("The language, when the file extension leaves it ambiguous."),
    paths: z.array(z.string()).optional().describe("Files, directories or globs to limit it to."),
    apply: z.boolean(),
  },
  annotations: { title: "OMP codemod", destructiveHint: false, openWorldHint: false },
  run: async ({ description, pattern, rewrite, language, paths, apply }, ctx) => {
    const details = [
      pattern ? `Pattern: \`${pattern}\`.` : "",
      rewrite !== undefined ? `Rewrite: \`${rewrite}\`.` : "",
      language ? `Language: ${language}.` : "",
      paths?.length ? `Only in: ${paths.map((path) => `\`${path}\``).join(", ")}.` : "",
    ].filter(Boolean);
    const prompt = [
      `Using ast_edit, which finds the matches and rewrites them: ${description}`,
      ...details,
      apply
        ? "Then apply the staged proposal by writing a one-sentence reason to `xd://resolve`, and report what changed."
        : "Stage the rewrite with ast_edit and stop there: do not apply it. Report the proposed changes.",
    ].join("\n");
    if (apply) {
      return runOmpCall(ctx, { tools: ["ast_edit", "read", "write"], model: "@smol", prompt, answer: { toolResults: ["ast_edit"] } });
    }
    const result = await runOmpCall(ctx, { tools: ["ast_edit", "read"], model: "@smol", prompt, answer: { toolResults: ["ast_edit"] }, stopAfter: "ast_edit" });
    return result.isError ? result : withText(result, (text) => text.replace(STAGED, PREVIEW));
  },
});

/** `ast_edit`'s own instruction to resolve the proposal, which the calling CLI cannot follow. */
const STAGED = /To apply: write a one-sentence reason to xd:\/\/resolve\. To discard: write to xd:\/\/reject\./;
const PREVIEW = "Not applied: call omp_codemod again with `apply: true` to make these changes.";
