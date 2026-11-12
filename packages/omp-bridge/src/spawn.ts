import { createConnection, type Socket } from "node:net";
import type { BridgeConfig } from "./config.js";

/**
 * A `ucch_agent` subagent, asked of the server over the scheduler socket
 * (`bridge-leases.ts` has the protocol):
 *
 *   bridge -> {"type":"spawn","token":"…","description":"…","task":"…","model":"…"}\n
 *   server -> {"type":"result","text":"…"}\n   the subagent's final answer
 *          or {"type":"error","reason":"…"}\n
 *          or {"type":"refused","reason":"…"}\n
 *
 * The server runs the subagent as a session of its own on whichever harness
 * the model routes to, and answers when that session's turn is over -- which
 * can be many minutes. The connection is the subagent's life: closing it (the
 * CLI killed, the call cancelled) stops it.
 */
export interface SpawnRequest {
  description: string;
  task: string;
  model?: string | undefined;
  background?: boolean | undefined;
}

export type SpawnOutcome = { text: string } | { error: string };

/** The longest a subagent is waited for; the CLI's own MCP timeout matches it. */
export const SPAWN_WAIT_MS = 60 * 60 * 1000;

export function spawnSubagent(
  config: Pick<BridgeConfig, "schedulerSock" | "leaseToken">,
  request: SpawnRequest,
  options: { connect?: (path: string) => Socket; waitMs?: number; signal?: AbortSignal } = {},
): Promise<SpawnOutcome> {
  if (!config.schedulerSock || !config.leaseToken) {
    return Promise.resolve({ error: "ucch_agent needs the UCCH server: this bridge was not started for a UCCH turn" });
  }
  const socket = (options.connect ?? ((path: string) => createConnection(path)))(config.schedulerSock);
  const token = config.leaseToken;
  return new Promise((resolve) => {
    let buffer = "";
    let done = false;
    const finish = (outcome: SpawnOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      socket.destroy();
      resolve(outcome);
    };
    const onAbort = () => finish({ error: "the subagent was stopped" });
    options.signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(
      () => finish({ error: "the subagent did not finish within an hour; it was stopped" }),
      options.waitMs ?? SPAWN_WAIT_MS,
    );
    socket.setEncoding("utf8");
    socket.on("connect", () => {
      socket.write(
        `${JSON.stringify({
          type: "spawn",
          token,
          description: request.description,
          task: request.task,
          ...(request.background ? { background: true } : {}),
          ...(request.model ? { model: request.model } : {}),
        })}\n`,
      );
    });
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let answer: { type?: unknown; text?: unknown; reason?: unknown };
      try {
        answer = JSON.parse(buffer.slice(0, end)) as typeof answer;
      } catch {
        return finish({ error: "the UCCH server gave an answer the bridge does not understand" });
      }
      if (answer.type === "result") return finish({ text: typeof answer.text === "string" ? answer.text : "" });
      const reason = typeof answer.reason === "string" ? answer.reason : "no reason given";
      finish({ error: answer.type === "refused" ? `the UCCH server refused the subagent: ${reason}` : reason });
    });
    socket.on("error", (error) => finish({ error: `could not reach the UCCH server: ${error.message}` }));
    socket.on("close", () => finish({ error: "the UCCH server closed the connection before the subagent finished" }));
  });
}

/** A short authenticated collaboration RPC, sharing the turn-bound bridge transport. */
export function callCollaboration(config: Pick<BridgeConfig, "schedulerSock" | "leaseToken">, name: string, args: Record<string, unknown>): Promise<SpawnOutcome> {
  if (!config.schedulerSock || !config.leaseToken) return Promise.resolve({ error: "project messaging needs a UCCH turn" });
  return new Promise((resolve) => {
    const socket = createConnection(config.schedulerSock!);
    let buffer = "";
    let settled = false;
    const finish = (result: SpawnOutcome) => {
      if (settled) return;
      settled = true; clearTimeout(timer); socket.destroy(); resolve(result);
    };
    const timer = setTimeout(() => finish({ error: "collaboration request timed out" }), 30_000);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ type: "collaboration", token: config.leaseToken, name, args })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > 2_000_000) return finish({ error: "collaboration response too large" });
      if (!buffer.includes("\n")) return;
      try {
        const result = JSON.parse(buffer.slice(0, buffer.indexOf("\n")));
        finish(result.type === "result" ? { text: String(result.text ?? "") } : { error: String(result.reason ?? "request refused") });
      } catch { finish({ error: "invalid collaboration response" }); }
    });
    socket.on("error", () => finish({ error: "could not reach the UCCH server" }));
    socket.on("close", () => finish({ error: "UCCH connection closed" }));
  });
}
