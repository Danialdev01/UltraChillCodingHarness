import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OmpRpc, type OmpRpcOptions } from "./omp-rpc.js";
import type { OmpFrame } from "./omp-rpc-types.js";
import { ManualProcessHost, type ManualChild } from "./testing.js";

/** The `ready` frame the pinned version sends (fixtures/omp-plain.jsonl:1). */
const READY = JSON.parse(
  readFileSync(join(import.meta.dirname, "fixtures", "omp-plain.jsonl"), "utf8").split("\n")[0]!,
).frame as OmpFrame;

const line = (frame: object) => JSON.stringify(frame);

/**
 * A child that is ready at once and accepts v2, as 18.14.1 does; `answer`
 * replies to anything else.
 */
function omp(answer: (frame: Record<string, unknown>, child: ManualChild) => void = () => {}, ready: object = READY) {
  return new ManualProcessHost((child) => {
    child.onWrite = (written) => {
      const frame = JSON.parse(written) as Record<string, unknown>;
      if (frame.type === "negotiate_protocol") {
        child.emit(line({ id: frame.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } }));
        return;
      }
      answer(frame, child);
    };
    child.onSignal = (sig) => {
      if (sig === "SIGTERM" || sig === "SIGKILL") child.exit({ code: null, signal: sig });
    };
    queueMicrotask(() => child.emit(line(ready)));
  });
}

async function start(host: ManualProcessHost, over: Partial<OmpRpcOptions> = {}) {
  const frames: OmpFrame[] = [];
  const logs: string[] = [];
  const rpc = await OmpRpc.start({
    host,
    argv: ["omp", "--mode", "rpc-ui"],
    cwd: "/w",
    env: {},
    onFrame: (frame) => frames.push(frame),
    onLog: (message) => logs.push(message),
    ...over,
  });
  return { rpc, frames, logs, child: host.children[0]! };
}

/** Splits a frame into v2 slices the way OMP does. */
function chunks(frame: object, size: number, chunkId = "rpc-1") {
  const bytes = Buffer.from(JSON.stringify(frame), "utf8");
  const count = Math.ceil(bytes.length / size);
  return Array.from({ length: count }, (_, index) => ({
    type: "rpc_chunk",
    chunkId,
    index,
    count,
    byteLength: bytes.length,
    data: bytes.subarray(index * size, (index + 1) * size).toString("base64"),
  }));
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("OmpRpc start", () => {
  it("sends nothing before ready, then negotiates protocol v2", async () => {
    let writtenBeforeReady = -1;
    const host = new ManualProcessHost((child) => {
      child.onWrite = (written) => {
        const frame = JSON.parse(written) as Record<string, unknown>;
        child.emit(line({ id: frame.id, type: "response", command: "negotiate_protocol", success: true, data: { protocolVersion: 2 } }));
      };
      setTimeout(() => {
        writtenBeforeReady = child.written.length;
        child.emit(line(READY));
      }, 20);
    });
    const { rpc, child } = await start(host);
    expect(writtenBeforeReady).toBe(0);
    expect(child.frames[0]).toEqual({ type: "negotiate_protocol", protocolVersion: 2, id: "omp-1" });
    expect(rpc.protocolVersion).toBe(2);
    expect(child.spec.argv).toEqual(["omp", "--mode", "rpc-ui"]);
  });

  it("stays on v1 and says so when v2 is refused", async () => {
    const host = new ManualProcessHost((child) => {
      child.onWrite = (written) => {
        const frame = JSON.parse(written) as Record<string, unknown>;
        child.emit(line({ id: frame.id, type: "response", command: "negotiate_protocol", success: false, error: "no" }));
      };
      queueMicrotask(() => child.emit(line(READY)));
    });
    const { rpc, logs } = await start(host);
    expect(rpc.protocolVersion).toBe(1);
    expect(logs.join("\n")).toMatch(/v1/);
  });

  it("does not negotiate with a process that offers only v1", async () => {
    const { rpc, child } = await start(omp(undefined, { type: "ready", protocolVersion: 1, supportedProtocolVersions: [1] }));
    expect(rpc.protocolVersion).toBe(1);
    expect(child.written).toEqual([]);
  });

  it("fails the start with stderr when the process exits before ready", async () => {
    const host = new ManualProcessHost((child) => {
      queueMicrotask(() => {
        child.emit('Model "nonexistent/nope" not found', "stderr");
        child.exit({ code: 1, signal: null });
      });
    });
    await expect(start(host)).rejects.toThrow(/before it was ready[\s\S]*nonexistent\/nope/);
  });

  it("times out a process that never becomes ready, and kills it", async () => {
    const host = new ManualProcessHost((child) => {
      child.emit("still loading", "stderr");
      child.onSignal = (sig) => {
        if (sig === "SIGTERM") child.exit({ code: null, signal: "SIGTERM" });
      };
    });
    await expect(start(host, { readyTimeoutMs: 30 })).rejects.toThrow(/not ready after[\s\S]*still loading/);
    expect(host.children[0]!.signals).toEqual(["SIGTERM"]);
  });
});

describe("OmpRpc requests", () => {
  it("matches responses by id, not by order", async () => {
    const held: Record<string, unknown>[] = [];
    const host = omp((frame, child) => {
      held.push(frame);
      if (held.length === 2) {
        // Answer the second command first.
        for (const f of [held[1]!, held[0]!]) {
          child.emit(line({ id: f.id, type: "response", command: f.type, success: true, data: { for: f.type } }));
        }
      }
    });
    const { rpc } = await start(host);
    const [state, stats] = await Promise.all([rpc.request({ type: "get_state" }), rpc.request({ type: "get_session_stats" })]);
    expect(state.data).toEqual({ for: "get_state" });
    expect(stats.data).toEqual({ for: "get_session_stats" });
  });

  it("resolves a failed command with its error rather than throwing", async () => {
    const host = omp((frame, child) =>
      child.emit(line({ id: frame.id, type: "response", command: "compact", success: false, error: "Already compacted" })),
    );
    const { rpc } = await start(host);
    await expect(rpc.request({ type: "compact" })).resolves.toMatchObject({ success: false, error: "Already compacted" });
  });

  it("logs a parse error loudly and still passes it on", async () => {
    const host = omp((_, child) =>
      child.emit(line({ type: "response", command: "parse", success: false, error: "Unexpected token" })),
    );
    const { rpc, frames, logs } = await start(host);
    rpc.send({ type: "extension_ui_response", id: "x", value: "Approve" });
    await settle();
    expect(logs.some((m) => /could not parse a frame UCCH sent: Unexpected token/.test(m))).toBe(true);
    expect(frames.at(-1)).toMatchObject({ type: "response", command: "parse" });
  });

  it("rejects pending commands when the process exits", async () => {
    const host = omp((_, child) => {
      child.emit("boom", "stderr");
      child.exit({ code: 2, signal: null });
    });
    const { rpc } = await start(host);
    await expect(rpc.request({ type: "get_state" })).rejects.toThrow(/code 2[\s\S]*boom/);
    await expect(rpc.request({ type: "get_state" })).rejects.toThrow(/code 2/);
  });

  it("refuses to send a frame over the process's limit", async () => {
    const { rpc } = await start(omp(undefined, { ...READY, maxFrameBytes: 64 }));
    await expect(rpc.request({ type: "prompt", message: "x".repeat(100) })).rejects.toThrow(/over the 64-byte limit/);
  });
});

describe("OmpRpc frames", () => {
  it("passes events and unknown frames through in order, and skips lines that are not frames", async () => {
    const { frames, child, logs } = await start(omp());
    child.emit(line({ type: "agent_start" }));
    child.emit("not json");
    child.emit(line({ type: "something_new", extra: { a: 1 } }));
    child.emit(line({ type: "agent_end", isTerminal: true }));
    await settle();
    expect(frames.map((f) => f.type)).toEqual(["agent_start", "something_new", "agent_end"]);
    expect(frames[1]).toEqual({ type: "something_new", extra: { a: 1 } });
    expect(logs.some((m) => /not JSON/.test(m))).toBe(true);
  });

  it("reassembles a v2 chunked frame", async () => {
    const { frames, child } = await start(omp());
    const big = { type: "message_update", text: "é".repeat(5000) };
    for (const c of chunks(big, 1000)) child.emit(line(c));
    child.emit(line({ type: "turn_end" }));
    await settle();
    expect(frames).toEqual([big, { type: "turn_end" }]);
  });

  it("reassembles interleaved chunk streams by chunkId", async () => {
    const { frames, child } = await start(omp());
    const a = chunks({ type: "a", v: "x".repeat(300) }, 100, "rpc-1");
    const b = chunks({ type: "b", v: "y".repeat(300) }, 100, "rpc-2");
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
      if (a[i]) child.emit(line(a[i]!));
      if (b[i]) child.emit(line(b[i]!));
    }
    await settle();
    expect(frames.map((f) => f.type).sort()).toEqual(["a", "b"]);
  });

  it.each([
    ["a corrupt slice", (c: ReturnType<typeof chunks>) => [c[0]!, { ...c[1]!, data: "!!!!" }]],
    ["a slice out of order", (c: ReturnType<typeof chunks>) => [c[0]!, c[2]!]],
    ["a changed byteLength", (c: ReturnType<typeof chunks>) => [c[0]!, { ...c[1]!, byteLength: 1 }]],
    ["a stream starting mid-way", (c: ReturnType<typeof chunks>) => [c[1]!]],
  ])("drops the frame with rpc_frame_error on %s", async (_, mangle) => {
    const { frames, child } = await start(omp());
    for (const c of mangle(chunks({ type: "message_update", v: "z".repeat(500) }, 100))) child.emit(line(c));
    child.emit(line({ type: "turn_end" }));
    await settle();
    expect(frames[0]).toMatchObject({ type: "rpc_frame_error", chunkId: "rpc-1", error: expect.any(String) });
    expect(frames.at(-1)).toEqual({ type: "turn_end" });
    expect(frames.some((f) => f.type === "message_update")).toBe(false);
  });

  it("refuses a chunked frame larger than the reassembly limit", async () => {
    const { frames, child } = await start(omp(undefined, { ...READY, maxReassembledFrameBytes: 200 }));
    child.emit(line(chunks({ type: "x", v: "z".repeat(500) }, 100)[0]!));
    await settle();
    expect(frames[0]).toMatchObject({ type: "rpc_frame_error", error: expect.stringMatching(/over the 200-byte limit/) });
  });

  it("keeps stderr out of the frames and its tail for errors", async () => {
    const stderr: string[] = [];
    const { rpc, frames, child } = await start(omp(), { onStderr: (l) => stderr.push(l) });
    child.emit("warning: something", "stderr");
    await settle();
    expect(frames).toEqual([]);
    expect(stderr).toEqual(["warning: something"]);
    expect(rpc.stderrTail).toContain("warning: something");
  });

  it("survives an onFrame that throws", async () => {
    let n = 0;
    const { child, logs } = await start(omp(), {
      onFrame: () => {
        n++;
        throw new Error("consumer bug");
      },
    });
    child.emit(line({ type: "a" }));
    child.emit(line({ type: "b" }));
    await settle();
    expect(n).toBe(2);
    expect(logs.filter((m) => /consumer bug/.test(m))).toHaveLength(2);
  });
});

describe("OmpRpc shutdown", () => {
  it("closes stdin and resolves with exit code 0", async () => {
    const host = omp();
    const { rpc, child } = await start(host);
    const closing = rpc.close();
    expect(child.stdinOpen).toBe(false);
    child.exit({ code: 0, signal: null });
    await expect(closing).resolves.toEqual({ code: 0, signal: null });
  });

  it("escalates kill() to SIGKILL when SIGTERM is ignored", async () => {
    const host = omp();
    const { rpc, child } = await start(host, { killGraceMs: 20 });
    child.onSignal = (sig) => {
      if (sig === "SIGKILL") child.exit({ code: null, signal: "SIGKILL" });
    };
    await rpc.kill();
    expect(child.signals).toEqual(["SIGTERM", "SIGKILL"]);
    await expect(rpc.exited).resolves.toEqual({ code: null, signal: "SIGKILL" });
  });

  it("does not escalate when SIGTERM is enough", async () => {
    const { rpc, child } = await start(omp(), { killGraceMs: 20 });
    await rpc.kill();
    expect(child.signals).toEqual(["SIGTERM"]);
  });
});
