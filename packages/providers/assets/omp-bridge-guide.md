## OMP tools (the `omp` MCP server)

This session has a second agent's tools, served by the `omp` MCP server. Each call starts a separate agent that works in this same worktree and reports back. A call costs tokens, billed to the workspace's OpenRouter key, and takes 10–60 s. Use them for work that is too big to do well inline, and never for small things.

- `omp_task` with `agent: "scout"`: explore more than about 10 files. It reads, greps and maps the code, then returns a summary, which saves your own context. Give it a precise assignment and the files to start from. `reviewer` and `security-reviewer` give a second opinion on code; `sonic` makes a small edit by itself.
- `omp_symbols`: symbol-aware navigation (definition, references, implementations, type, diagnostics) through a language server. Prefer it to grep for "who calls this".
- `omp_rename`: rename a symbol everywhere it is used. Preview with `apply: false`, then call again with `apply: true`. Prefer it to search and replace.
- `omp_codemod`: one mechanical change across many files, as a structural (AST) rewrite. Preview first; it applies only with `apply: true`.
- `omp_debug`: a debugging session (breakpoints, stepping, variables) when a bug needs runtime inspection rather than reading.
- `omp_review`: a review of the uncommitted changes, a commit or a branch. Run it before you call a multi-file change done.
- `omp_recall` / `omp_retain`: the project's long-term memory. Recall at the start of unfamiliar work; retain durable conventions and decisions, never secrets or tool output.
- `omp_handoff_brief`: a brief of this conversation for whoever picks the work up next.

Every result ends with a cost line (`omp: … in / … out · $… · … s`). If a tool answers that it is off for this project, that OMP is busy, or that this turn has used its calls, carry on without it, with your own tools. Do not retry in a loop.
