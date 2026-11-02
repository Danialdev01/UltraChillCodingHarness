import { createConnection, type Socket } from "node:net";
import type { BridgeConfig } from "./config.js";

/**
 * What a bridge call passes before it starts `omp` (solution §10.5): the
 * turn's call budget, then an OMP slot from the server's scheduler.
 *
 * The slot is asked for over the server's Unix socket (`bridge-leases.ts`
 * in the server has the protocol): one connection per call, held for as
 * long as the call runs, so a bridge that dies gives its slot back with
 * its connection. The server waits up to 30 s for a slot and then answers
 * "busy"; the bridge waits a little longer than that for the answer, in
 * case the server never gives one.
 *
 * The budget is this process's: the CLI starts one bridge per turn, so
 * `UCCH_BRIDGE_MAX_CALLS` is how many OMP calls a turn may make. A call
 * refused for being busy, or for the budget, does not count against it.
 */
export interface CallGate {
  enter(): Promise<{ release(): void } | { refused: string }>;
}

/** The server's own wait, plus room for its answer to arrive. */
const ANSWER_WAIT_MS = 35_000;

export const BUSY =
  "omp is busy: every OMP slot on this server is taken. Try again in a minute, or carry on without the omp tools for now.";

export function callGate(config: BridgeConfig, options: { answerWaitMs?: number; connect?: (path: string) => Socket } = {}): CallGate {
  let calls = 0;
  const connect = options.connect ?? ((path: string) => createConnection(path));
  return {
    async enter() {
      if (calls >= config.maxCalls) {
        return {
          refused: `this turn has used its ${config.maxCalls} omp calls (UCCH_BRIDGE_MAX_CALLS); carry on without the omp tools`,
        };
      }
      if (!config.schedulerSock) {
        calls++;
        return { release: () => {} };
      }
      const lease = await askForSlot(connect(config.schedulerSock), config.leaseToken ?? "", options.answerWaitMs ?? ANSWER_WAIT_MS);
      if ("refused" in lease) return lease;
      calls++;
      return lease;
    },
  };
}

function askForSlot(socket: Socket, token: string, waitMs: number): Promise<{ release(): void } | { refused: string }> {
  return new Promise((resolve) => {
    let buffer = "";
    let done = false;
    const finish = (outcome: { release(): void } | { refused: string }) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      if ("refused" in outcome) socket.destroy();
      resolve(outcome);
    };
    const timer = setTimeout(() => finish({ refused: BUSY }), waitMs);
    socket.setEncoding("utf8");
    socket.on("connect", () => socket.write(`${JSON.stringify({ type: "lease", token })}\n`));
    socket.on("data", (chunk: string) => {
      buffer += chunk;
      const end = buffer.indexOf("\n");
      if (end < 0) return;
      let answer: { type?: unknown; reason?: unknown };
      try {
        answer = JSON.parse(buffer.slice(0, end)) as typeof answer;
      } catch {
        return finish({ refused: "the UCCH scheduler gave an answer the bridge does not understand" });
      }
      if (answer.type === "granted") return finish({ release: () => socket.destroy() });
      if (answer.type === "busy") return finish({ refused: BUSY });
      finish({ refused: `the UCCH scheduler refused the call: ${typeof answer.reason === "string" ? answer.reason : "no reason given"}` });
    });
    // No server to ask is no slot: the cap is the point, so the call does
    // not run unmetered.
    socket.on("error", (error) => finish({ refused: `could not reach the UCCH scheduler: ${error.message}` }));
    socket.on("close", () => finish({ refused: "the UCCH scheduler closed the connection before it answered" }));
  });
}
