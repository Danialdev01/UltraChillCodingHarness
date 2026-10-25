import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeltaCoalescer, isDelta, type Delta } from "./delta-coalescer.js";

const THREAD = "44444444-4444-4444-4444-444444444444";
const TURN = "66666666-6666-6666-6666-666666666666";
const OTHER_TURN = "77777777-7777-7777-7777-777777777777";

const text = (t: string, turnId = TURN): Delta => ({ type: "agent.text_delta", threadId: THREAD, turnId, text: t });
const thinking = (t: string, turnId = TURN): Delta => ({
  type: "agent.thinking_delta",
  threadId: THREAD,
  turnId,
  text: t,
});

function setup(maxChars?: number) {
  const out: string[] = [];
  const coalescer = new DeltaCoalescer(
    (delta) => out.push(`${delta.type === "agent.text_delta" ? "text" : "thinking"}:${delta.text}`),
    { flushMs: 40, ...(maxChars ? { maxChars } : {}) },
  );
  return { out, coalescer };
}

describe("DeltaCoalescer", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("sends a turn's first delta at once", () => {
    const { out, coalescer } = setup();
    coalescer.push(text("He"));
    expect(out).toEqual(["text:He"]);
  });

  it("merges what follows into one delta per flush interval", () => {
    const { out, coalescer } = setup();
    coalescer.push(text("He"));
    coalescer.push(text("llo"));
    coalescer.push(text(", "));
    expect(out).toEqual(["text:He"]);
    vi.advanceTimersByTime(39);
    expect(out).toEqual(["text:He"]);
    vi.advanceTimersByTime(1);
    expect(out).toEqual(["text:He", "text:llo, "]);
    coalescer.push(text("world"));
    vi.advanceTimersByTime(40);
    expect(out).toEqual(["text:He", "text:llo, ", "text:world"]);
  });

  it("sends a long run without waiting for the timer", () => {
    const { out, coalescer } = setup(8);
    coalescer.push(text("a"));
    coalescer.push(text("bcdef"));
    coalescer.push(text("ghij"));
    expect(out).toEqual(["text:a", "text:bcdefghij"]);
    vi.advanceTimersByTime(100);
    expect(out).toHaveLength(2);
  });

  it("keeps thinking and text in their order", () => {
    const { out, coalescer } = setup();
    coalescer.push(thinking("hmm"));
    coalescer.push(thinking(" so"));
    coalescer.push(text("Yes"));
    coalescer.push(text("."));
    coalescer.push(thinking("then"));
    vi.advanceTimersByTime(40);
    expect(out).toEqual(["thinking:hmm", "thinking: so", "text:Yes.", "thinking:then"]);
  });

  it("starts afresh for another turn", () => {
    const { out, coalescer } = setup();
    coalescer.push(text("a"));
    coalescer.push(text("b"));
    coalescer.push(text("c", OTHER_TURN));
    expect(out).toEqual(["text:a", "text:b", "text:c"]);
  });

  it("flushes on demand, before something durable", () => {
    const { out, coalescer } = setup();
    coalescer.push(text("a"));
    coalescer.push(text("b"));
    coalescer.flush();
    out.push("tool_use");
    vi.advanceTimersByTime(100);
    expect(out).toEqual(["text:a", "text:b", "tool_use"]);
  });

  it("sends the tail and stops the timer when disposed", () => {
    const { out, coalescer } = setup();
    coalescer.push(text("a"));
    coalescer.push(text("tail"));
    coalescer.dispose();
    expect(out).toEqual(["text:a", "text:tail"]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("knows a delta from anything else", () => {
    expect(isDelta(text("x"))).toBe(true);
    expect(isDelta(thinking("x"))).toBe(true);
    expect(isDelta({ type: "turn.started", threadId: THREAD, turnId: TURN })).toBe(false);
  });
});
