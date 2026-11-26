import { describe, expect, it, vi } from "vitest";
import type { Database } from "@ucch/db";
import type { Command, DomainEvent } from "@ucch/protocol";
import type { Principal } from "./auth.js";
import { conclude, CouncilRunner, parsePosition, type Position } from "./council.js";
import { DeliberationSettings, recoverDeliberations, type DeliberationDeps } from "./deliberations.js";
import { fixMessage, parseReviewBlock, PeerReviewer, renderChanges, reviewedTurn } from "./peer-review.js";
import type { ManagedRequest, RunOutcome } from "./subagents.js";

vi.mock("./engine.js", async (original) => ({ ...(await original<object>()), applyProjection: async () => {} }));

const review = (verdict: string, findings: unknown[] = []) =>
  `Looked.\n\`\`\`ucch-review\n${JSON.stringify({ verdict, summary: "s", findings })}\n\`\`\``;
const position = (recommendation: string, confidence = 0.9, changed = false) =>
  `\`\`\`ucch-position\n${JSON.stringify({ recommendation, confidence, reasons: ["r"], risks: [], changed })}\n\`\`\``;
const finding = { severity: "major", file: "./a.ts", line: 3, title: "Off by one", detail: "It is." };

type Answer = (seat: number, turn: number, text: string, signal: AbortSignal) => RunOutcome | Promise<RunOutcome>;
const done = (text: string, costUsd = 0.1): RunOutcome => ({ kind: "done", text, costUsd });

const HISTORY: DomainEvent[] = [
  { type: "user.message", threadId: "t", text: "add validation" },
  { type: "turn.started", threadId: "t", turnId: "turn1", provider: "claude", model: "claude-opus-5-5" },
  { type: "agent.message", threadId: "t", turnId: "turn1", content: [{ type: "text", text: "done it" }] },
  { type: "agent.turn_completed", threadId: "t", turnId: "turn1", stopReason: "end_turn", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 }, costUsd: 0 },
] as DomainEvent[];

function setup(answer: Answer, options: { refuse?: (seat: number) => string | null; dispatch?: DeliberationDeps["dispatch"]; history?: DomainEvent[]; settings?: object } = {}) {
  const events: DomainEvent[] = [];
  const asked: ManagedRequest[] = [];
  const ended: number[] = [];
  const sent: Command[] = [];
  const texts: string[][] = [];
  const deps: DeliberationDeps = {
    store: {
      append: async (_target: unknown, batch: readonly DomainEvent[]) => (events.push(...batch), []),
      threadHistory: async () => [...(options.history ?? HISTORY), ...events].map((event) => ({ event })),
    } as never,
    runner: {
      startManaged: async (request) => {
        const seat = asked.push(request) - 1;
        const refused = options.refuse?.(seat);
        if (refused) return { error: refused };
        let turn = 0;
        texts[seat] = [];
        return {
          subagentId: `s${seat}`,
          childThreadId: `c${seat}`,
          childHash: `h${seat}`,
          provider: "codex",
          model: `model-${seat}`,
          routing: "x",
          turn: async (text) => {
            texts[seat]!.push(text);
            return answer(seat, turn++, text, request.signal);
          },
          stop: () => {},
          end: async () => void ended.push(seat),
        };
      },
    },
    dispatch: async (principal, command) => {
      sent.push(command);
      return (await options.dispatch?.(principal, command)) ?? ({ ok: true } as never);
    },
    harnesses: async () => [],
    catalogue: async () => [],
    settings: async () => DeliberationSettings.parse(options.settings ?? {}),
    onError: (error) => {
      throw error;
    },
  };
  return { deps, events, asked, ended, sent, texts };
}

const parent = { projectId: "p", threadId: "t", subject: "u", author: { provider: "claude" as const, model: "claude-opus-5-5" } };
const principal = { userId: "u", sessionId: "s", scopes: ["exec"] } as Principal;
const types = (events: DomainEvent[]) => events.map((event) => event.type);
/** Settles only when the run is stopped. */
const untilStopped = (signal: AbortSignal) =>
  new Promise<RunOutcome>((resolve) => {
    const stop = () => resolve({ kind: "cancelled", error: "stopped" });
    if (signal.aborted) stop();
    signal.addEventListener("abort", stop);
  });

describe("parseReviewBlock", () => {
  it("reads the last block, and gives its findings stable ids", () => {
    const parsed = parseReviewBlock(`${review("approve")}\n${review("incorrect", [finding, { nonsense: 1 }, { ...finding, line: "x", severity: "huge" }])}`);
    expect(parsed).toMatchObject({ verdict: "incorrect", findings: [{ id: "f1", file: "a.ts", line: 3, severity: "major" }, { id: "f2", severity: "minor" }] });
    expect(parsed.findings[1]).not.toHaveProperty("line");
  });
  it.each(["no block at all", "```ucch-review\n{not json\n```"])("keeps what does not parse as text", (text) => {
    expect(parseReviewBlock(text)).toMatchObject({ rawText: true, findings: [], summary: text });
  });
});

describe("reviewedTurn", () => {
  it("is the latest finished answer, and not a stopped one", () => {
    expect(reviewedTurn(HISTORY.map((event) => ({ event })))).toMatchObject({
      turnId: "turn1", request: "add validation", answer: "done it", author: { provider: "claude" },
    });
    const stopped = HISTORY.map((event) => ({ event: event.type === "agent.turn_completed" ? { ...event, stopReason: "cancelled" as const } : event }));
    expect(reviewedTurn(stopped)).toBeNull();
  });
  it("names the files instead of a diff too big to send", () => {
    const file = { path: "a.ts", change: "modified" as const, patch: "x".repeat(50_000), added: 1, removed: 0, truncated: false };
    expect(renderChanges([file], 0)).toContain("too large");
    expect(renderChanges([file], 0)).not.toContain("xxxx");
    expect(renderChanges([{ ...file, patch: "+new" }], 0)).toContain("+new");
  });
});

describe("PeerReviewer", () => {
  const directive = { models: [], fix: false, previous: false };
  const run = (s: ReturnType<typeof setup>, over: object = {}, maxCostUsd = 2, timeoutMs?: number) => {
    const reviewer = new PeerReviewer(s.deps, { maxCostUsd, fixRetryMs: 1, ...(timeoutMs ? { timeoutMs } : {}) });
    return { reviewer, done: reviewer.run({ parent, turnId: "turn1", directive: { ...directive, ...over }, principal }) };
  };

  it("starts, completes and ends, in that order, and sends nothing back", async () => {
    const s = setup(() => done(review("changes_requested", [finding])));
    await run(s).done;
    expect(types(s.events)).toEqual(["agent.peer_review_started", "agent.peer_review_completed", "agent.peer_review_ended"]);
    expect(s.texts[0]![0]).toContain("add validation");
    expect(s.sent).toEqual([]);
    expect(s.ended).toContain(0);
  });

  it("with fix, sends the findings back once, the re-review without fix", async () => {
    let busy = 2;
    const s = setup(() => done(review("incorrect", [finding, { ...finding, severity: "nit", title: "Nitpick" }])), {
      dispatch: async () => (busy-- > 0 ? { ok: false, code: "conflict", message: "busy" } : { ok: true }) as never,
    });
    await run(s, { fix: true }).done;
    expect(s.sent).toHaveLength(3);
    expect(s.sent[2]).toMatchObject({ type: "thread.send", reviewer: { fix: false } });
    expect((s.sent[2] as { text: string }).text).toContain("Off by one");
    expect((s.sent[2] as { text: string }).text).not.toContain("Nitpick");
  });

  it("does not fix an approval", async () => {
    const s = setup(() => done(review("approve")));
    await run(s, { fix: true }).done;
    expect(s.sent).toEqual([]);
  });

  it("over budget, skips the fix and says so", async () => {
    const s = setup(() => done(review("incorrect", [finding]), 9));
    await run(s, { fix: true }).done;
    expect(s.sent).toEqual([]);
    expect(s.events.at(-1)).toMatchObject({ type: "agent.peer_review_ended", status: "completed", fixSkipped: expect.any(String) });
  });

  it("keeps the review of one when another fails", async () => {
    const s = setup((seat) => (seat === 0 ? { kind: "failed", error: "boom" } : done(review("approve"))));
    await run(s, { models: ["a", "b"] }).done;
    expect(types(s.events)).toContain("agent.peer_review_failed");
    expect(s.events.at(-1)).toMatchObject({ status: "completed" });
  });

  it("fails when nothing can be started", async () => {
    const s = setup(() => done(""), { refuse: () => "no such model" });
    await run(s).done;
    expect(s.events).toMatchObject([{ type: "agent.peer_review_started", reviewers: [] }, { type: "agent.peer_review_failed", error: "no such model" }, { status: "failed" }]);
  });

  it("is stopped by a person, or by its time", async () => {
    const s = setup((_seat, _turn, _text, signal) => untilStopped(signal));
    const { reviewer, done: finished } = run(s);
    await vi.waitFor(() => expect(s.texts[0]).toHaveLength(1));
    reviewer.running.cancelThread("t", "user");
    await finished;
    expect(s.events.at(-1)).toMatchObject({ type: "agent.deliberation_cancelled", by: "user" });

    const late = setup((_seat, _turn, _text, signal) => untilStopped(signal));
    await run(late, {}, 2, 10).done;
    expect(late.events.at(-1)).toMatchObject({ by: "timeout" });
  });

  it("reviews a fix against the request it came from", async () => {
    const history = [
      ...HISTORY,
      { type: "agent.peer_review_started", threadId: "t", deliberationId: "d1", targetTurnId: "turn1", reviewers: [], fix: true },
      { type: "user.message", threadId: "t", text: "findings", peerReviewId: "d1" },
      { type: "turn.started", threadId: "t", turnId: "turn2", provider: "claude" },
      { ...HISTORY[3], turnId: "turn2" },
    ] as DomainEvent[];
    const s = setup(() => done(review("approve")), { history });
    await new PeerReviewer(s.deps, { maxCostUsd: 2 }).run({ parent, turnId: "turn2", directive, principal });
    expect(s.events[0]).toMatchObject({ rereviewOf: "d1", targetTurnId: "turn2" });
    expect(s.texts[0]![0]).toContain("add validation");
  });
});

describe("fixMessage", () => {
  const result = { reviews: { s0: { status: "completed", ...parseReviewBlock(review("incorrect", [finding, { ...finding, title: "Two" }])) } } };
  it("sends only what was picked", () => {
    const text = fixMessage(result, { ids: ["s0:f2"], nits: true })!;
    expect(text).toContain("Two");
    expect(text).not.toContain("Off by one");
    expect(fixMessage(result, { ids: ["other:f1"], nits: true })).toBeNull();
  });
});

describe("council", () => {
  const directive = { models: [], size: 3, rounds: 2, implement: false };
  const meet = (s: ReturnType<typeof setup>, over: object = {}, options: { maxCostUsd?: number; timeoutMs?: number; signal?: AbortSignal } = {}) =>
    new CouncilRunner(s.deps, { maxCostUsd: options.maxCostUsd ?? 5, ...(options.timeoutMs ? { timeoutMs: options.timeoutMs } : {}) }).run({
      parent, turnId: "held", directive: { ...directive, ...over }, question: "Redis?", signal: options.signal ?? new AbortController().signal,
    });

  it("stops early when all agree and are sure", async () => {
    const s = setup(() => done(position("Use Redis")));
    const out = await meet(s);
    expect(s.events.at(-1)).toMatchObject({ type: "agent.council_concluded", consensus: "unanimous", roundsRun: 0 });
    expect(out).toMatchObject({ kind: "brief", text: expect.stringContaining("Do not change files") });
    expect(s.events[0]).toMatchObject({ turnId: "held", members: [{ seat: "A" }, { seat: "B" }, { seat: "C" }] });
  });

  it("argues anonymously, and stops when nobody moves", async () => {
    const s = setup((seat) => done(position(seat === 0 ? "Use Redis" : "Stay on Postgres", 0.6)));
    const out = await meet(s);
    const last = s.events.at(-1);
    expect(last).toMatchObject({ consensus: "majority", recommendation: "Stay on Postgres", roundsRun: 1, dissent: [{ seat: "A" }] });
    expect(s.texts[0]![1]).toContain("Member B");
    expect(s.texts[0]![1]).not.toContain("model-1");
    expect(out).toMatchObject({ text: expect.stringContaining("model-1") });
  });

  it("marks a member that changed its mind", async () => {
    const s = setup((seat, turn) => done(position(seat === 0 && turn === 0 ? "Use Redis" : "Stay on Postgres", 0.9)));
    await meet(s);
    expect(s.events).toContainEqual(expect.objectContaining({ type: "agent.council_position", round: 1, seat: "A", changed: true }));
    expect(s.events.at(-1)).toMatchObject({ consensus: "unanimous" });
  });

  it("goes on without a member that fails, and says it is partial", async () => {
    const s = setup((seat) => (seat === 2 ? { kind: "failed", error: "limit" } : done(position("Use Redis"))));
    await meet(s);
    expect(types(s.events)).toContain("agent.council_dropped");
    expect(s.events.at(-1)).toMatchObject({ type: "agent.council_concluded", partial: true });
  });

  it("with fewer than two positions fails, and the turn still answers", async () => {
    const s = setup((seat) => (seat === 0 ? done(position("Use Redis")) : { kind: "failed", error: "limit" }));
    const out = await meet(s);
    expect(s.events.at(-1)).toMatchObject({ type: "agent.council_failed", partial: true });
    expect(out).toMatchObject({ kind: "brief", text: expect.stringContaining("could not meet") });
  });

  it("concludes early when the budget or the time is spent", async () => {
    const dear = setup((seat) => done(position(`Option ${seat}`, 0.3), 3));
    await meet(dear);
    expect(dear.events.at(-1)).toMatchObject({ type: "agent.council_concluded", stopped: "budget", consensus: "split" });
    const slow = setup((seat, turn, _text, signal) => (turn === 0 ? done(position(`Option ${seat}`, 0.3)) : untilStopped(signal)));
    await meet(slow, {}, { timeoutMs: 30 });
    expect(slow.events.at(-1)).toMatchObject({ type: "agent.council_concluded", stopped: "timeout" });
  });

  it("is cancelled with the turn it holds", async () => {
    const controller = new AbortController();
    const s = setup((_seat, _turn, _text, signal) => untilStopped(signal));
    const out = meet(s, {}, { signal: controller.signal });
    await vi.waitFor(() => expect(s.texts[2]).toHaveLength(1));
    controller.abort();
    expect(await out).toEqual({ kind: "cancelled" });
    expect(s.events.at(-1)).toMatchObject({ type: "agent.deliberation_cancelled", by: "parent" });
    expect(new Set(s.ended)).toEqual(new Set([0, 1, 2]));
  });

  it("with implement, tells the moderator to carry it out", async () => {
    const s = setup(() => done(position("Use Redis")));
    expect(await meet(s, { implement: true })).toMatchObject({ text: expect.stringContaining("carry out") });
  });

  it("ties go to the surer", () => {
    const at = (recommendation: string, confidence: number): Position => ({ recommendation, confidence, reasons: [], risks: [], changed: false });
    expect(conclude(new Map([["A", at("x", 0.4)], ["B", at("y", 0.9)]]))).toMatchObject({ consensus: "split", recommendation: "y" });
  });

  it("takes an answer with no block at its words", () => {
    expect(parsePosition("Use Redis.")).toMatchObject({ recommendation: "Use Redis.", confidence: 0.5 });
    expect(parsePosition("  ")).toBeNull();
  });
});

describe("recoverDeliberations", () => {
  it("closes what was running", async () => {
    const appended: DomainEvent[] = [];
    const db = { select: () => ({ from: () => ({ where: async () => [{ id: "d", threadId: "t", projectId: "p" }] }) }) } as unknown as Database;
    const store = { append: async (_t: unknown, batch: readonly DomainEvent[]) => (appended.push(...batch), []) } as never;
    expect(await recoverDeliberations(db, store)).toBe(1);
    expect(appended).toEqual([{ type: "agent.deliberation_cancelled", threadId: "t", deliberationId: "d", by: "restart" }]);
  });
});
