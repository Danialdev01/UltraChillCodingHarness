
# UCCH — Pluggable Agent Providers (Claude Code / Codex / built-in)

A build spec for adding subscription-backed agent backends to UCCH, written to be handed
to an implementing agent. It slots in ahead of and around Phase 5 of `documentation/plan.md`.

> **Implementation note (2026-09-13).** P-1 through P-4 are built, plus the per-user concurrency
> cap from P-6. One deviation from §1.1: the container runtime (plan.md Phase 2) does not exist
> yet, so the CLIs run **on the host** in `WORKSPACE_ROOT/{projectId}` -- the same trade the
> `bash` tool and the terminal already make, behind the same `AGENT_ALLOW_HOST_SHELL` gate. The
> process boundary is `ProcessHost` in `packages/providers/src/process.ts`; a `docker exec`
> implementation of it is what Phase 2 swaps in, and nothing in the providers changes. Credential
> directories live at `CREDS_ROOT/{userId}/{claude,codex}` (`CLAUDE_CONFIG_DIR` / `CODEX_HOME`)
> and become bind mounts then. P-5 (transcript snapshots) waits on Phase 6 checkpoints; the rest of
> P-6 is open. Events map onto the harness's existing names (`agent.tool_use`, `agent.tool_result`,
> `agent.message`, …) rather than the aliases listed in §1.3; two were added:
> `agent.session_started` (the resume token) and `agent.retry`.

Target state: a project's agent runs under one of three providers, selected per project or
per thread —

| Provider   | Process                               | Billing                     |
| ---------- | ------------------------------------- | --------------------------- |
| `claude` | `claude` CLI, `-p` streaming mode | user's Claude subscription  |
| `codex`  | `codex exec --json`                 | user's ChatGPT subscription |
| `native` | UCCH's own loop (`packages/agent`)  | OpenRouter / API keys       |

---

## 0. The rule that decides whether this is safe

Everything about ban risk reduces to two questions:

1. **Who performed the login?** The human who owns the subscription, in a flow they can see, or
   your server on their behalf?
2. **What process makes the model request?** The vendor's own CLI, or your code holding a
   scraped token?

T3 Code answers these the safe way and that is the *whole* reason it isn't a problem. Its README
is explicit: it is an "agent harness control surface" that controls agents **on your machine**,
and it tells you to install and authenticate each provider yourself — `codex login`,
`claude auth login`, `cursor-agent login`. T3 Code never sees a credential. It spawns a local
process that already has one.

So:

**Safe (do this).** One subscription = one human. That human logs in themselves. The vendor CLI
is the process that talks to the vendor. Your harness is a control surface and an event log.

**Unsafe (do not do this).** Reading `auth.json` / `.credentials.json`, extracting the OAuth
token, and calling `api.anthropic.com` or `chatgpt.com/backend-api/codex/responses` from your own
HTTP client. Or: one subscription account serving N users of your product. Or: charging people
for access to inference you're buying on a personal plan. The first is credential misuse, the
second and third are account sharing and resale. These are what actually gets accounts terminated,
and note that they get *the user's* account terminated, not yours — which is worse for you.

UCCH is already documented as single-tenant with a root-equivalent Docker socket. Keep that
framing. This feature does not change it into a SaaS.

### What each vendor actually says

**Anthropic** provides a first-class path for this. `claude setup-token` mints a one-year OAuth
token that authenticates against a Pro / Max / Team / Enterprise subscription, and the docs
present it for exactly this case: *"For CI pipelines, scripts, or other environments where
interactive browser login isn't available."* You set it as `CLAUDE_CODE_OAUTH_TOKEN`. It is
model-requests-only — it can't open Remote Control sessions or pull claude.ai connectors. Locally
configured MCP servers still work. This is a sanctioned, documented mechanism. Use it.

**OpenAI** is more conservative. Their position: *"Use API key authentication for programmatic
Codex CLI workflows, such as CI/CD jobs. Don't expose Codex execution in untrusted or public
environments."* ChatGPT-managed auth in automation exists but is filed under "advanced," with
guardrails: don't use it for public or open-source repositories; if `codex login` isn't possible
on the runner, seed `auth.json` through secure storage, let Codex refresh it in place, and persist
the updated file between runs. There is no Codex equivalent of `setup-token` for consumer plans —
long-lived non-interactive tokens are a ChatGPT Enterprise feature (admin-granted Codex access
tokens) plus workload identity federation.

**Practical consequence for UCCH:** Claude subscription mode is comfortable. Codex subscription
mode is doable for you, the box owner, on your own repos — treat it as an advanced opt-in with a
visible warning, and keep API-key mode as the documented default for Codex.

---

## 1. Architecture

### 1.1 Where the CLI runs

Inside the **project container**, not on the server. This is non-negotiable and it falls straight
out of your existing invariant: "Every tool executes inside the project container via
`docker exec`; the server never touches workspace files directly."

If you ran `claude` on the server you would have to bind-mount the workspace into the server
process, hand the CLI a shell on the host, and give a model-driven `bash` tool the same namespace
as your Docker socket. That is a host compromise waiting for a prompt injection in a README.

```
server (Fastify)
  │  spawns: docker exec -i ucch-proj-{hash} claude -p --output-format stream-json …
  │  reads:  stdout JSONL → normalise → append events → publish
  ▼
project container  (image: ucch/base — now ships `claude` and `codex`)
  /workspace                  ← bind mount from /srv/ucch/workspaces/{projectId}
  /home/coder/.claude         ← bind mount from /srv/ucch/creds/{userId}/claude
  /home/coder/.codex          ← bind mount from /srv/ucch/creds/{userId}/codex
```

### 1.2 Credential isolation

Both CLIs let you relocate their config directory, which is what makes per-user isolation
possible without the CLIs stepping on each other:

- Claude Code: `CLAUDE_CONFIG_DIR` — relocates `.credentials.json`, and on macOS also re-keys the
  Keychain entry. On Linux (your case) credentials are `~/.claude/.credentials.json`, mode `0600`.
- Codex: `CODEX_HOME` — relocates `auth.json`. Set `cli_auth_credentials_store = "file"` in
  `config.toml`; the default `auto` will try the OS keyring first and there isn't one in a
  container.

Rules:

1. Credential directories are mounted **per user**, never per project. Two projects owned by the
   same user share one login. Two users never share one.
2. Mount them `rw`. Both CLIs refresh tokens in place during normal use, and if the mount is
   read-only or ephemeral the refresh is lost and the login dies silently mid-run.
3. `chmod 0700` the directory, `0600` the files, owned by uid 1000 to match `coder`.
4. Never read the token values into the server process, never log them, never put them in an
   event. The server's job is to mount a directory, not to parse it.
5. Add `/srv/ucch/creds` to your backup exclusion list and to any `docker cp` deny path.

### 1.3 Provider interface

New package, `packages/providers`. One interface, three implementations. The server orchestrator
only ever sees the interface.

```ts
export type ProviderId = "claude" | "codex" | "native";

export interface AgentRun {
  /** Normalised events, in order. */
  events: AsyncIterable<AgentEvent>;
  /** Graceful end-of-turn. */
  interrupt(): Promise<void>;
  /** Hard stop. */
  kill(): Promise<void>;
}

export interface AgentProvider {
  readonly id: ProviderId;

  /** Is this provider usable in this container for this user right now? */
  probe(ctx: ContainerCtx): Promise<ProviderHealth>;

  /** Start or resume a turn. */
  run(input: {
    ctx: ContainerCtx;
    prompt: string;
    threadId: string;
    /** Provider-native session id from a previous turn, if any. */
    resumeToken?: string;
    model?: string;
    permission: PermissionProfile;
  }): AgentRun;
}

export interface ProviderHealth {
  installed: boolean;
  authenticated: boolean;
  /** "subscription" | "api-key" | "none" */
  authMode: string;
  account?: string;       // display only, e.g. masked email
  version?: string;
  expiresAt?: string;     // when the CLI reports it
  error?: string;
}
```

`AgentEvent` is your existing event vocabulary — do **not** invent a second one. Every provider
normalises into the same shapes you already have or will have for the native loop:

```
agent.turn_started        { threadId, turn, provider, model }
agent.text_delta          { text }
agent.thinking_delta      { text }          // claude only, when enabled
agent.tool_started        { toolCallId, name, input, parentToolCallId? }
agent.tool_completed      { toolCallId, ok, summary }
agent.file_changed        { path, kind }
agent.usage               { inputTokens, outputTokens, cachedInputTokens, costUsd? }
agent.turn_completed      { threadId, turn, resumeToken, stopReason }
agent.turn_failed         { threadId, turn, category, message }
agent.retry               { attempt, maxRetries, delayMs, category }
```

This is the single most important design decision in the whole feature. If the browser has to
know which provider produced an event, you have lost — the UI forks, the revert logic forks, the
checkpoint logic forks, and you now maintain three harnesses. Normalise at the boundary.

---

## 2. Provider: Claude Code

### 2.1 Invocation

```bash
docker exec -i -u coder \
  -w /workspace \
  -e CLAUDE_CONFIG_DIR=/home/coder/.claude \
  -e CLAUDE_CODE_OAUTH_TOKEN="$token"        # only in token mode; omit in /login mode
  ucch-proj-{hash} \
  claude -p "$PROMPT" \
    --output-format stream-json \
    --verbose \
    --include-partial-messages \
    --permission-mode acceptEdits \
    --permission-prompts none \
    --append-system-prompt-file /workspace/.ucch/system.md \
    --resume "$SESSION_ID"                    # when continuing
```

Critical flags and traps:

- **Never pass `--bare`.** Bare mode explicitly does not read OAuth credentials or the keychain,
  and does not read `CLAUDE_CODE_OAUTH_TOKEN`. It's the recommended mode for scripted calls in
  general, but it is exactly wrong for subscription auth. If someone adds `--bare` for startup
  speed, subscription mode breaks with an authentication error.
- **Unset `ANTHROPIC_API_KEY` in the container.** Auth precedence puts `ANTHROPIC_API_KEY` above
  subscription OAuth, and in `-p` mode the key is always used when present — no prompt. A stray
  key in the base image silently moves every run onto API billing, which is the exact thing this
  feature exists to avoid. Assert it is unset in `probe()`.
- `--permission-prompts none` (requires CLI ≥ 2.1.259) tells Claude nobody can approve and not to
  retry. Without it, a run with no permission host can stall.
- `--permission-mode` for `-p` starts at Manual on every plan, so you must pass one.
  `acceptEdits` is the sane default for a container; `dontAsk` for locked-down runs. Do not ship
  `bypassPermissions` as a user-facing option.
- `--include-partial-messages` is what gives you token-level `stream_event` deltas for the UI.

### 2.2 Reading the stream

Newline-delimited JSON on stdout. Handle these:

| Line                                   | Do                                                                                                               |
| -------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `system` / `init`                  | capture`session_id`, model, tools, `mcp_servers`, `plugins`, `capabilities`; emit `agent.turn_started` |
| `system` / `api_retry`             | emit`agent.retry` (`attempt`, `max_retries`, `retry_delay_ms`, `error` category)                       |
| `stream_event` with `text_delta`   | emit`agent.text_delta`                                                                                         |
| `assistant` with `tool_use` block  | emit`agent.tool_started`                                                                                       |
| `user` with `tool_result` block    | emit`agent.tool_completed`                                                                                     |
| any message with`parent_tool_use_id` | subagent output — set`parentToolCallId`, nest in the UI                                                       |
| `permission_denied`                  | surface as a warning, not a failure                                                                              |
| `result` (last line)                 | `agent.usage` + `agent.turn_completed`, carry `session_id` as `resumeToken`                              |

Feature-detect with the `capabilities` array on `system/init` rather than comparing version
strings. Values you don't recognise, ignore.

Set `--forward-subagent-text` (or `CLAUDE_CODE_FORWARD_SUBAGENT_TEXT`) if you want subagent prose
in the log, not just their tool calls.

### 2.3 Session continuity

`session_id` from `system/init` or the `result` line is your `resumeToken`. Store it on the thread
row and pass `--resume <id>` next turn. Claude Code finds a session by id in any project on the
machine, so the container's cwd doesn't have to match — but keep it matching anyway, because your
checkpoints are cwd-relative.

You may also pass `--resume` an absolute path to the session's `.jsonl` transcript. That is worth
knowing: it means the transcript is a file in the container you can snapshot alongside the
workspace, which makes fork-a-thread work for free.

### 2.4 Stopping

- **End the turn cleanly:** SIGINT.
- **Kill:** SIGTERM → exit code 143, in-progress turn left unfinished with no result recorded,
  `SessionEnd` hooks run, bash process trees terminated. On resume, Claude Code continues the
  unfinished turn.

Wire your UI "stop" button to SIGINT and your container-teardown path to SIGTERM. Do not use
SIGTERM for user-initiated stop — you'll strand a turn.

### 2.5 Auth setup flows

Two, both user-driven:

**A. Token paste (recommended, headless-friendly).**
The user runs `claude setup-token` on their own machine, approves in a browser, copies the printed
token, pastes it into UCCH's settings page. You encrypt it with the existing `SECRET_KEY`
machinery (you already do this for GitHub tokens) and inject it as `CLAUDE_CODE_OAUTH_TOKEN` at
`docker exec` time. One year lifetime. Record the issue date and warn at 11 months.

**B. In-container `/login`.**
Attach a terminal to the container (Phase 2 gives you this) and run `claude`. The browser can't
reach the container's local callback server, so the CLI shows a code-paste prompt — the documented
path for WSL2/SSH/containers. The user completes the flow in their own browser and pastes the
code back. Credentials land in the mounted `CLAUDE_CONFIG_DIR` and persist.

B is better hygiene: your server never holds the credential at all. A is better UX. Ship both,
default to B, and make A the fallback with a short explanation of what the token is.

---

## 3. Provider: Codex

### 3.1 Invocation

```bash
docker exec -i -u coder \
  -w /workspace \
  -e CODEX_HOME=/home/coder/.codex \
  ucch-proj-{hash} \
  codex exec "$PROMPT" \
    --json \
    --sandbox workspace-write \
    --skip-git-repo-check            # only if the workspace genuinely isn't a repo
```

Resume:

```bash
codex exec resume "$SESSION_ID" --json "$PROMPT"
```

Notes:

- Default sandbox is **read-only**. You must pass `--sandbox workspace-write` or the agent will
  appear broken. `danger-full-access` only inside a container you already treat as disposable —
  which yours is, so it's defensible, but make it an explicit per-project setting.
- Progress goes to **stderr**, final message to **stdout**, unless `--json`, in which case stdout
  becomes the JSONL event stream. Capture both; stderr is where login and config errors surface.
- `--ephemeral` skips writing session rollout files. Do not use it — you need the rollout for
  resume.
- `--output-schema <file>` + `-o <path>` gives you schema-constrained final output. Useful later
  for structured commit-message or plan generation.
- `--ignore-user-config` / `--ignore-rules` if a repo's own `.rules` or `config.toml` shouldn't
  apply. Consider defaulting `--ignore-rules` on, since repo-controlled policy files in a cloned
  third-party repo are an injection surface.

### 3.2 Reading the stream

JSONL on stdout:

```
{"type":"thread.started","thread_id":"0199a213-…"}
{"type":"turn.started"}
{"type":"item.started","item":{"id":"item_1","type":"command_execution","command":"bash -lc ls","status":"in_progress"}}
{"type":"item.completed","item":{"id":"item_3","type":"agent_message","text":"…"}}
{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122,"reasoning_output_tokens":0}}
```

Mapping:

| Codex                                                              | UCCH                                      |
| ------------------------------------------------------------------ | ----------------------------------------- |
| `thread.started`                                                 | capture`thread_id` as `resumeToken`   |
| `turn.started`                                                   | `agent.turn_started`                    |
| `item.*` type `agent_message`                                  | `agent.text_delta` (whole-message)      |
| `item.*` type `reasoning`                                      | `agent.thinking_delta`                  |
| `item.*` type `command_execution`                              | `agent.tool_started` / `_completed`   |
| `item.*` type `file_change`                                    | `agent.file_changed`                    |
| `item.*` type `mcp_tool_call`, `web_search`, `plan_update` | tool events                               |
| `turn.completed` + `usage`                                     | `agent.usage`, `agent.turn_completed` |
| `turn.failed`, `error`                                         | `agent.turn_failed`                     |

Note the asymmetry with Claude: Codex items are message-granular, not token-granular. Your UI
must tolerate a provider that streams in chunks rather than characters. Don't build a typewriter
effect that assumes deltas.

### 3.3 Auth setup

- `codex login --device-auth` inside the container — prints a URL and code, user completes it in
  their own browser. This is the clean path.
- Or seed `auth.json` from the user's own machine through your encrypted-secrets path, exactly as
  OpenAI documents for CI runners: seed through secure storage, run Codex so it refreshes in
  place, persist the updated file between runs. The mounted-volume design already satisfies the
  persistence requirement.
- `auth.json` contains `access_token` and `refresh_token` under `"auth_mode": "chatgpt"`. Treat
  the whole file as a password.
- API-key mode: `CODEX_API_KEY` set **only** for the single invocation, never as a container-wide
  env var. Anything running in that container — build scripts, test suites, postinstall hooks —
  can read a container-wide variable, and in a harness that clones arbitrary repos that is a real
  exfiltration path, not a theoretical one.

### 3.4 The warning you must show

Surface this in the UI before a user enables Codex subscription mode, in plain words:

> Codex subscription auth in automation is an advanced path. OpenAI's guidance is to use an API
> key for programmatic runs, and not to use account auth for public or open-source repositories.
> Your ChatGPT credentials will be stored on this server and used to run agents in containers you
> control. Only enable this on a machine you own and for repositories you trust.

An honest warning is also your best defence if anything ever goes wrong: you documented the
trade-off and the user chose.

---

## 4. Native provider

Unchanged from your Phase 5 plan — `packages/agent`, streaming loop against the Claude API with
your plugin tool registry, tools executed via `docker exec`. It stays as the fallback for users
with no subscription, and as the only provider where you control context editing, compaction, and
quotas (Phase 8). Keep it. It is also your insurance: if either vendor changes their stance on
harness integration, UCCH still works.

---

## 5. Checkpoints and revert across providers

Your checkpoint design — snapshot as `refs/ucch/checkpoints/{thread}/{turn}` through a temporary
index — already works for any provider, because it snapshots *the filesystem*, not the agent's
internal state. Good. But "reverting rolls back files and conversation together" needs one
addition per provider:

- **Native:** the conversation is in your event log. Already solved.
- **Claude Code:** the conversation lives in the session `.jsonl` transcript in the container.
  Snapshot that file into the checkpoint alongside the workspace, and on revert, restore it and
  resume from the restored transcript path (`--resume /path/to/transcript.jsonl`).
- **Codex:** rollout files under `CODEX_HOME`. Same treatment. Do not use `--ephemeral`.

If you skip this, revert on a CLI provider rolls back the files and leaves the agent believing it
already did the work — the precise failure your design exists to prevent, reintroduced through the
side door. Write a test for it.

---

## 6. Build order

Each phase has an acceptance check. Do not start the next one until it passes.

### P-1 — Base image and probe (small)

1. Add `claude` and `codex` to `images/base`, pinned to specific versions, plus `git`, `ripgrep`.
2. Set `CLAUDE_CONFIG_DIR` and `CODEX_HOME` in the image env.
3. Write `/home/coder/.codex/config.toml` with `cli_auth_credentials_store = "file"`.
4. Implement `probe()` for both: run `claude --version`, `codex --version`, and each CLI's status
   command; parse into `ProviderHealth`. Never surface a token, only a masked account label.
5. Assert `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `CODEX_API_KEY` are absent from the image env.

*Accept:* `probe()` returns `installed: true, authenticated: false` on a fresh container without
throwing, and the UI shows three provider cards with correct state.

### P-2 — Credential volumes and login flows

1. `mkdir -p /srv/ucch/creds/{userId}/{claude,codex}`, `0700`, uid 1000, on first login attempt.
2. Mount both into every project container for that user.
3. Ship the in-container login flow: a dedicated terminal session that runs `claude` or
   `codex login --device-auth`, streamed to the browser, with the code-paste prompt visible.
4. Ship the token-paste fallback for Claude, encrypted with `SECRET_KEY`.
5. Add a "Sign out" that deletes the credential dir contents and, for token mode, the stored token.

*Accept:* a user logs in once, restarts the container, and `probe()` still reports
`authenticated: true, authMode: "subscription"`. Nothing in `/srv/ucch/creds` is readable by the
`web` service.

### P-3 — The Claude provider

1. Spawn, stream, normalise per §2.2. Handle partial lines across chunk boundaries — JSONL
   arrives split.
2. Persist `session_id` on the thread; wire `--resume`.
3. SIGINT on interrupt, SIGTERM on teardown; map exit 143 correctly.
4. Cap concurrent runs per user. One subscription, several containers, all hammering at once is
   how you hit a rate limit and think the integration is broken.

*Accept:* a two-turn conversation in the browser, with tool calls rendered, file diffs appearing,
a working stop button, and correct resume on turn two.

### P-4 — The Codex provider

Same, per §3. The event normaliser is the only genuinely new code; the process supervision is
shared with P-3, so factor that out first.

*Accept:* identical UI behaviour to P-3 with no provider-specific branches in `apps/web`.

### P-5 — Checkpoint integration

Per §5. Snapshot transcripts, restore on revert, resume from restored state.

*Accept:* a test that runs a turn, reverts it, and asserts the agent's next turn has no memory of
the reverted work and the files match the pre-turn tree.

### P-6 — Guardrails

1. Per-user concurrency and daily turn caps.
2. A visible banner when a run is consuming a subscription vs API credits.
3. Usage from `turn.completed.usage` and Claude's `result` cost fields, charted per thread.
   Both are client-side estimates and can differ from the actual bill — label them as estimates.
4. Rate-limit and usage-limit errors mapped to a clear UI state, not a generic failure.

---

## 7. Challenges, honestly

**Account-level risk lands on the user, not you.** If someone runs your harness against their Max
plan and abuses it, their account gets limited. That is a support burden and a reputational one.
Mitigate with concurrency caps and a usage display, not with hope.

**Two agents, two philosophies.** Claude Code streams token deltas, has permission modes, hooks,
skills, subagents, and its own checkpointing. Codex streams message-granular items, has a sandbox
model, and its own rollout format. The normalisation layer will leak — some Claude features will
have no Codex analogue and vice versa. Decide now that the intersection is what the UI exposes,
and provider-specific extras go in an "advanced" drawer or nowhere.

**You are now downstream of two changelogs.** Both CLIs ship weekly and both docs pages are full
of "requires v2.1.x or later" notes. Pin versions in the image. Test upgrades deliberately. Use
the `capabilities` array rather than version comparison where it exists.

**Prompt injection gets sharper.** You clone arbitrary repos and run an agent in them with
`workspace-write` or `acceptEdits`. A malicious `AGENTS.md`, `CLAUDE.md`, `.mcp.json`, or
`.rules` in a cloned repo is model-visible instruction. Note that a `claude -p` session runs a
project's `.claude/settings.json` hooks and connects its `.mcp.json` servers even in a folder
you've never trusted, with no trust dialog. Default to `--ignore-rules` for Codex and consider
`--strict-mcp-config` for Claude on untrusted clones. Your no-`git_push` rule is doing real work
here — keep it and extend it: no credential-directory reads, no network egress to arbitrary hosts.

**Cost attribution gets muddy.** Three providers, two of them subscription-metered in units you
can't see. The `total_cost_usd` Claude reports and Codex's token counts are estimates. Don't build
billing on them.

**`--bare` will bite someone.** It's the documented recommendation for scripted calls and it
silently breaks subscription auth. Put a comment in the code and an assertion in the test suite.

**Multi-user is the line.** The moment UCCH serves people who aren't the box owner, holding their
subscription credentials becomes a materially different product with materially different risk.
If you ever want that, the answer is BYO-key or a proper commercial arrangement, not more
containers.

---

## 8. Reference

- Claude Code programmatic use: https://code.claude.com/docs/en/headless.md
- Claude Code authentication (incl. `setup-token`): https://code.claude.com/docs/en/authentication.md
- Claude Code CLI flags: https://code.claude.com/docs/en/cli-reference.md
- Agent SDK (TS/Python, if you prefer a library to spawning): https://code.claude.com/docs/en/agent-sdk/overview.md
- Codex non-interactive mode: https://learn.chatgpt.com/codex/non-interactive-mode
- Codex authentication and credential storage: https://learn.chatgpt.com/docs/auth
- Codex SDK and app-server: https://learn.chatgpt.com/codex/codex-sdk , https://learn.chatgpt.com/codex/app-server
- T3 Code: https://github.com/pingdotgg/t3code
