import { randomUUID } from "node:crypto";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DomainEvent } from "@ucch/protocol";
import { OmpNormaliser, OmpRpc, type OmpSessionStats, type ProcessHost } from "@ucch/providers";
import { ompEnv, refuseForeignCredentials, type BridgeConfig } from "./config.js";
import type { CallGate } from "./lease.js";

/**
 * One bridge call: one `omp --mode rpc --no-session` process, one prompt,
 * its answer, and the process closed (solution §10.2).
 *
 * The frames go through `OmpNormaliser`, the same reading an OMP turn gets,
 * so the bridge knows when the turn is over (a background `task` keeps it
 * going past its `prompt_result`), what each subagent answered, what each
 * tool returned, and what the call cost.
 */
export interface OmpCall {
  /** `--tools`; empty is `--no-tools`. Only these run: the allowlist is the control (§10.2). */
  tools: readonly string[];
  /** `--model`: a role (`@smol`) or a model. */
  model: string;
  prompt: string;
  /**
   * What the answer is made of, first found wins: the subagents' results
   * (`omp_task`, `omp_review`), the final assistant text, and the results of
   * these tools (a rename's or codemod's preview), added after the text.
   */
  answer: { subagents?: boolean; toolResults?: readonly string[] };
  /**
   * Ends the call, with an `abort`, as soon as this tool returns without an
   * error; what it returned is then the answer. For a codemod preview:
   * `ast_edit` stages a proposal and OMP then forces the model to `write`
   * it to `xd://resolve` or `xd://reject`, so a call with no `write` tool
   * never ends on its own -- 18.14.1 fails it after three forced turns.
   * Aborting there discards the proposal unapplied.
   */
  stopAfter?: string;
}

export interface CallContext {
  config: BridgeConfig;
  host: ProcessHost;
  parentEnv: NodeJS.ProcessEnv;
  now?: () => number;
  /** How long past `--max-time` a call is let run before it is killed; tests shorten it. */
  graceMs?: number;
  /** The turn's call budget and the server's OMP slots (`lease.ts`). None: unmetered. */
  gate?: CallGate;
}

/** The size a result is held to, before the cost line (§10.2). */
export const RESULT_BYTES = 64 * 1024;

/** How long past `--max-time` the bridge waits before it kills a call that did not stop: OMP's own stop comes first. */
const KILL_AFTER_MS = 30_000;

/** The argv for a call (§10.2): one throwaway session, no prompts, only the allowlisted tools. */
export function callArgv(config: BridgeConfig, call: Pick<OmpCall, "tools" | "model">): string[] {
  return [
    config.ompBin,
    "--mode",
    "rpc",
    "--no-session",
    "--no-title",
    "--model",
    call.model,
    "--max-time",
    String(config.maxSeconds),
    // Headless prompts fail rather than wait (approvals docs); the
    // allowlist is what limits a call.
    "--approval-mode",
    "yolo",
    ...(call.tools.length > 0 ? ["--tools", call.tools.join(",")] : ["--no-tools"]),
    // A turn's guards (solution §0.3): nothing from the repository loads.
    "--no-extensions",
    "--no-rules",
    // A language server only for a trusted project's call that asks for
    // one: a cloned repository's LSP config is a command (§0.3).
    ...(config.trusted && call.tools.includes("lsp") ? [] : ["--no-lsp"]),
    ...(config.overlay ? ["--config", config.overlay] : []),
  ];
}

export async function runOmpCall(ctx: CallContext, call: OmpCall): Promise<CallToolResult> {
  const env = ompEnv(ctx.config, ctx.parentEnv);
  const refused = refuseForeignCredentials(env);
  if (refused) return failure(refused);
  // The turn's budget and a server slot, before any process starts (§10.5).
  const admitted = ctx.gate ? await ctx.gate.enter() : null;
  if (admitted && "refused" in admitted) return failure(admitted.refused);
  try {
    return await callOmp(ctx, call, env);
  } finally {
    admitted?.release();
  }
}

async function callOmp(ctx: CallContext, call: OmpCall, env: Record<string, string>): Promise<CallToolResult> {
  const now = ctx.now ?? Date.now;
  const started = now();

  const events: DomainEvent[] = [];
  const normaliser = new OmpNormaliser({
    projectId: "omp-bridge",
    threadId: "omp-bridge",
    turnId: randomUUID(),
    workspace: ctx.config.worktree,
  });
  let settle!: () => void;
  const settled = new Promise<void>((resolve) => (settle = resolve));
  const names = new Map<string, string>();
  let stopped = false;
  // Assigned once the process is ready; no tool runs before then.
  let rpc!: OmpRpc;
  try {
    rpc = await OmpRpc.start({
      host: ctx.host,
      argv: callArgv(ctx.config, call),
      cwd: ctx.config.worktree,
      env,
      onFrame: (frame) => {
        for (const event of normaliser.push(frame)) {
          // Nobody is there to answer: with `--approval-mode yolo` none
          // should come, and one that does is refused rather than waited on.
          events.push(event);
          if (event.type === "agent.permission_requested") {
            events.push(...normaliser.answerPermission(event.requestId, { behavior: "deny", message: "Nobody can approve this: the bridge runs unattended." }));
          }
          if (event.type === "agent.tool_use") names.set(event.toolUseId, event.name);
          if (
            call.stopAfter &&
            !stopped &&
            event.type === "agent.tool_result" &&
            !event.isError &&
            names.get(event.toolUseId) === call.stopAfter
          ) {
            stopped = true;
            normaliser.noteInterrupt();
            void rpc?.request({ type: "abort" }).catch(() => undefined);
          }
        }
        if (normaliser.settled) settle();
      },
    });
  } catch (error) {
    return failure(`omp did not start: ${firstLine(describe(error))}`);
  }
  normaliser.bind({ send: (frame) => rpc.send(frame) });

  // The whole exchange is timed, not only the wait for the answer: a
  // process that stops answering commands would otherwise hold the CLI's
  // tool call for as long as the CLI lets it.
  const exchange = async (): Promise<CallToolResult | null> => {
    const before = await stats(rpc);
    const prompt = await rpc.request({ type: "prompt", message: call.prompt });
    if (!prompt.success) {
      await rpc.close();
      return failure(`omp refused the prompt: ${firstLine(prompt.error ?? "no reason given")}`);
    }
    const outcome = await Promise.race([settled.then(() => "settled" as const), rpc.exited.then(() => "exited" as const)]);
    if (outcome === "settled") {
      const after = await stats(rpc);
      events.push(...normaliser.complete({ before, after }));
      await rpc.close();
    } else {
      const exit = await rpc.exited;
      events.push(...normaliser.finish({ ...exit, interrupted: false, stderrTail: rpc.stderrTail }));
    }
    return null;
  };
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<"late">((resolve) => {
    timer = setTimeout(() => resolve("late"), ctx.config.maxSeconds * 1000 + (ctx.graceMs ?? KILL_AFTER_MS));
  });
  try {
    const outcome = await Promise.race([exchange(), late]);
    if (outcome === "late") {
      await rpc.kill();
      return failure(`omp did not finish within ${ctx.config.maxSeconds} s`);
    }
    if (outcome) return outcome;
  } catch (error) {
    await rpc.kill();
    return failure(`omp failed: ${firstLine(describe(error))}`);
  } finally {
    clearTimeout(timer);
  }

  return answerOf(call, events, Math.max(0, now() - started), stopped);
}

/** What the call's events say, as the tool's result. */
function answerOf(call: OmpCall, events: readonly DomainEvent[], durationMs: number, stopped: boolean): CallToolResult {
  const end = events.find((event) => event.type === "agent.turn_completed" || event.type === "agent.turn_failed");
  if (!end || end.type === "agent.turn_failed") {
    return failure(`omp failed: ${firstLine(end?.type === "agent.turn_failed" ? end.error : "the call ended without an answer")}`);
  }
  if (end.stopReason === "cancelled" && !stopped) return failure("omp stopped before it answered");

  const parts: string[] = [];
  if (call.answer.subagents) {
    for (const event of events) {
      if (event.type !== "agent.subagent_finished" || !event.result) continue;
      parts.push(event.status === "completed" ? event.result : `${event.subagentId} ${event.status}: ${event.result}`);
    }
  }
  if (parts.length === 0) {
    const text = lastAssistantText(events);
    if (text) parts.push(text);
  }
  const wanted = new Set(call.answer.toolResults ?? []);
  if (wanted.size > 0) {
    const names = new Map<string, string>();
    for (const event of events) {
      if (event.type === "agent.tool_use") names.set(event.toolUseId, event.name);
      if (event.type === "agent.tool_result" && wanted.has(names.get(event.toolUseId) ?? "")) {
        parts.push(`${names.get(event.toolUseId)}:\n${event.content}`);
      }
    }
  }
  const text = cap(parts.join("\n\n").trim() || "(omp gave no answer)");
  const line = costLine(end.usage.inputTokens, end.usage.outputTokens, end.costUsd, durationMs);
  return { content: [{ type: "text", text: `${text}\n\n${line}` }] };
}

/** The text of the turn's last assistant message: its answer. */
function lastAssistantText(events: readonly DomainEvent[]): string {
  for (let i = events.length - 1; i >= 0; i--) {
    const event = events[i]!;
    if (event.type !== "agent.message") continue;
    const text = event.content
      .map((block) => (block && typeof block === "object" && (block as { type?: unknown }).type === "text" ? String((block as { text?: unknown }).text ?? "") : ""))
      .join("")
      .trim();
    if (text) return text;
  }
  return "";
}

/** `omp: 3.1k in / 0.8k out · $0.004 · 21 s`, so the CLI's transcript records what the call cost. */
export function costLine(input: number, output: number, costUsd: number, durationMs: number): string {
  const tokens = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
  return `omp: ${tokens(input)} in / ${tokens(output)} out · $${Number(costUsd.toFixed(4))} · ${Math.round(durationMs / 1000)} s`;
}

/** At most `RESULT_BYTES` of UTF-8, cut on a character, and saying so. */
export function cap(text: string): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= RESULT_BYTES) return text;
  const marker = "\n[… truncated]";
  let cut = bytes.subarray(0, RESULT_BYTES - Buffer.byteLength(marker)).toString("utf8");
  // A character split at the edge decodes to U+FFFD; drop it.
  if (cut.endsWith("�")) cut = cut.slice(0, -1);
  return `${cut}${marker}`;
}

async function stats(rpc: OmpRpc): Promise<OmpSessionStats | null> {
  const response = await rpc.request<OmpSessionStats>({ type: "get_session_stats" });
  return response.success ? (response.data ?? null) : null;
}

export function failure(reason: string): CallToolResult {
  return { content: [{ type: "text", text: reason }], isError: true };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0] ?? "";
}
