import { existsSync, readFileSync, statSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@ucch/db";
import type { Command, DomainEvent } from "@ucch/protocol";
import {
  ClaudeNormaliser,
  createProviders,
  forbiddenEnvFor,
  forbiddenEnvPresent,
  HostProcessHost,
  ompBridgeGuide,
  OmpProvider,
  type AgentProvider,
  type OmpAskInput,
  type ProviderRunInput,
} from "@ucch/providers";
import {
  AgentTurnReactor,
  claudePromptNeedsPerson,
  ompInstructions,
  resolveModel,
  resolveProvider,
  shouldRecheckStack,
  turnKindOf,
  type AgentOptions,
} from "./agent.js";
import type { Config } from "./config.js";
import { encryptSecret } from "./crypto.js";
import { RETAIN_PROMPT } from "./omp-memory.js";
import { readProjectKnowledge } from "./dev-database.js";
import type { EventStore } from "./eventstore.js";
import { ProviderService } from "./providers.js";
import { TurnScheduler } from "./turn-scheduler.js";
import { registry as metrics } from "./metrics.js";

describe("resolveModel", () => {
  const SERVER = "anthropic/claude-sonnet-5";
  const ACCOUNT = "openai/gpt-5";

  it("uses what the turn asked for, over both defaults", () => {
    expect(resolveModel("x-ai/grok-4", ACCOUNT, SERVER)).toBe("x-ai/grok-4");
  });

  it("falls back to the account's default from Settings", () => {
    // A turn that names no model -- another client, or one the harness starts.
    expect(resolveModel(undefined, ACCOUNT, SERVER)).toBe(ACCOUNT);
  });

  it("falls back to the server's default when the account has chosen none", () => {
    expect(resolveModel(undefined, null, SERVER)).toBe(SERVER);
  });

  it("treats an empty choice as no choice", () => {
    // A cleared field arrives as "", and a turn billed to the model id "" fails
    // at OpenRouter with an error nobody can place.
    expect(resolveModel("", ACCOUNT, SERVER)).toBe(ACCOUNT);
    expect(resolveModel("   ", "", SERVER)).toBe(SERVER);
    expect(resolveModel(undefined, "  ", SERVER)).toBe(SERVER);
  });

  it("trims a model id rather than sending one with spaces on it", () => {
    expect(resolveModel(" openai/gpt-5 ", null, SERVER)).toBe("openai/gpt-5");
  });
});

describe("resolveProvider", () => {
  it("keeps a bound thread on its provider whatever was asked", () => {
    expect(resolveProvider("codex", "claude", "native")).toBe("claude");
    expect(resolveProvider(undefined, "codex", "claude")).toBe("codex");
  });

  it("takes the turn's request over the account default", () => {
    expect(resolveProvider("codex", null, "claude")).toBe("codex");
  });

  it("falls back to the account default, then the native loop", () => {
    expect(resolveProvider(undefined, null, "claude")).toBe("claude");
    expect(resolveProvider(undefined, null, null)).toBe("native");
  });

  it("ignores a value it does not know", () => {
    // A column written by a future version, or a hand-edited row.
    expect(resolveProvider(undefined, "gemini", null)).toBe("native");
  });

  describe("with OMP_ENABLED", () => {
    // bound, requested, account default -> without the flag, with it.
    const table: [string | null, "native" | "claude" | "codex" | "omp" | undefined, string | null, string, string][] = [
      // Unbound: whatever would start on the native loop starts on OMP.
      [null, undefined, null, "native", "omp"],
      [null, "native", null, "native", "omp"],
      [null, undefined, "native", "native", "omp"],
      [null, "native", "claude", "native", "omp"],
      [null, undefined, "gemini", "native", "omp"],
      // Unbound, and something else chosen: the flag changes nothing.
      [null, "claude", null, "claude", "claude"],
      [null, "codex", "native", "codex", "codex"],
      [null, undefined, "claude", "claude", "claude"],
      [null, undefined, "omp", "omp", "omp"],
      [null, "omp", null, "omp", "omp"],
      // Bound: the binding wins, a native thread included.
      ["native", undefined, null, "native", "native"],
      ["native", "native", "omp", "native", "native"],
      ["claude", undefined, "native", "claude", "claude"],
      ["codex", "codex", null, "codex", "codex"],
      ["omp", undefined, "native", "omp", "omp"],
      // A binding it does not know is no binding.
      ["gemini", undefined, null, "native", "omp"],
    ];

    it.each(table)("bound %s, asked %s, default %s: %s, or %s with the flag", (bound, requested, fallback, off, on) => {
      expect(resolveProvider(requested, bound, fallback)).toBe(off);
      expect(resolveProvider(requested, bound, fallback, { ompEnabled: false })).toBe(off);
      expect(resolveProvider(requested, bound, fallback, { ompEnabled: true })).toBe(on);
    });
  });
});

describe("turnKindOf", () => {
  it("counts each provider's turns against its own limit", () => {
    expect(["native", "claude", "codex", "omp"].map((id) => turnKindOf(id as never))).toEqual(["native", "cli", "cli", "omp"]);
  });
});

describe("ompInstructions", () => {
  it("puts the project's knowledge first, then UCCH's rules", () => {
    const text = ompInstructions("/work/p", "# Project\nUses pnpm.\n");
    expect(text.startsWith("# Project\nUses pnpm.\n\n## Working in UCCH\n")).toBe(true);
    expect(text).toContain("You are working in /work/p");
    expect(text).toContain("Never commit or push");
    expect(text.endsWith("\n")).toBe(true);
  });

  it("is UCCH's rules alone when the project has no knowledge", () => {
    expect(ompInstructions("/work/p", null).startsWith("## Working in UCCH\n")).toBe(true);
  });
});

describe("shouldRecheckStack", () => {
  it("looks again after every fifth turn of the project", () => {
    expect([1, 2, 3, 4, 5, 6, 9, 10, 15].filter(shouldRecheckStack)).toEqual([5, 10, 15]);
  });

  it("never on a project with no turns", () => {
    expect(shouldRecheckStack(0)).toBe(false);
  });
});

const USER = "11111111-1111-1111-1111-111111111111";
const PROJECT = "33333333-3333-3333-3333-333333333333";
const THREAD = "44444444-4444-4444-4444-444444444444";
const thread = {
  id: THREAD,
  projectId: PROJECT,
  hash: "abcdef123456",
  branch: null,
  createdByUserId: USER,
  credentialSource: null,
  provider: null,
  providerSessionId: null,
};
const owner = { creator: USER, workspaceId: "w", policy: "member", workspaceKey: null };
const person = { id: USER, openrouterKeyEncrypted: null, defaultModel: null, defaultProvider: null, agentPermissionMode: null };

/**
 * The reactor against a database that answers its selects in order, and
 * a store that records what is appended instead of writing it.
 */
function reactor(...rows: unknown[][]) {
  return reactorWith({}, ...rows);
}

function reactorWith(extra: Partial<AgentOptions>, ...rows: unknown[][]) {
  const appended: DomainEvent[][] = [];
  const next = () => Promise.resolve(rows.shift() ?? []);
  const chain: Record<string, unknown> = {};
  for (const step of ["from", "innerJoin", "where", "orderBy"]) chain[step] = () => chain;
  chain.limit = next;
  chain.then = (resolve: (value: unknown) => void, reject: (error: unknown) => void) => next().then(resolve, reject);
  const db = { select: () => chain } as unknown as Database;
  const store = {
    append: async (_target: unknown, batch: DomainEvent[]) => {
      appended.push(batch);
      return [];
    },
  } as unknown as EventStore;
  const options = { workspaceRoot: "/nonexistent-ucch-test-root", ...extra } as unknown as AgentOptions;
  const errors: unknown[] = [];
  return { agent: new AgentTurnReactor(db, store, options, (error) => errors.push(error)), appended, errors };
}

const send: Command = { type: "thread.send", threadId: THREAD, text: "hi" };
const message: DomainEvent = { type: "user.message", threadId: THREAD, text: "hi" };
const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

describe("a queued message that never becomes a turn", () => {
  it("is released when the agent cannot start it", async () => {
    // The thread is there; its project is not.
    const { agent, appended } = reactor([thread], []);
    agent.react(send, [message]);
    await settle();
    expect(appended).toEqual([[{ type: "turn.dequeued", threadId: THREAD, reason: "error" }]]);
  });

  it("is released, and never opened, when it is cancelled while it waits", async () => {
    const { agent, appended } = reactor([thread], [{ stack: null }], [owner], [person]);
    agent.react(send, [message]);
    // Straight after the send, before the turn has read anything.
    agent.react({ type: "thread.cancel", threadId: THREAD }, []);
    await settle();
    expect(appended).toEqual([[{ type: "turn.dequeued", threadId: THREAD, reason: "cancelled" }]]);
    expect(agent.activeTurns).toBe(0);
  });

  it("leaves nothing to release when the thread itself is gone", async () => {
    const { agent, appended } = reactor([]);
    agent.react(send, [message]);
    await settle();
    expect(appended).toEqual([]);
  });
});

describe("a turn over the server's limits", () => {
  /** A scheduler with its one CLI slot taken by somebody else's turn. */
  async function full() {
    const scheduler = new TurnScheduler({ cliPerUser: 2, cliTotal: 1, nativeTotal: 1 });
    const release = await scheduler.acquire({ ownerId: "someone-else", kind: "cli", threadId: "elsewhere" });
    return { scheduler, release };
  }
  const claude: Command = { type: "thread.send", threadId: THREAD, text: "hi", provider: "claude" };
  const completed = (turnId: string): DomainEvent => ({
    type: "agent.turn_completed",
    threadId: THREAD,
    turnId,
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
    costUsd: 0,
  });

  it("waits, saying how many are ahead, and is never opened if cancelled meanwhile", async () => {
    const { scheduler } = await full();
    const { agent, appended } = reactorWith({ scheduler, cliEnabled: true }, [thread], [{ stack: null }], [owner], [person]);
    agent.react(claude, [message]);
    await settle();
    expect(appended).toEqual([[{ type: "agent.queued", threadId: THREAD, ahead: 0 }]]);
    expect(scheduler.aheadOf(THREAD)).toBe(0);
    agent.react({ type: "thread.cancel", threadId: THREAD }, []);
    await settle();
    expect(appended.slice(1)).toEqual([[{ type: "turn.dequeued", threadId: THREAD, reason: "cancelled" }]]);
    expect(scheduler.stats().waiting.cli).toBe(0);
  });

  it("opens when a slot frees, and gives it back when it ends", async () => {
    const { scheduler, release } = await full();
    const root = await mkdtemp(join(tmpdir(), "ucch-agent-"));
    try {
      const providers = {
        resolve: async () => ({
          ctx: () => ({}),
          provider: {
            run: (input: { turnId: string }) => ({
              events: (async function* () {
                yield completed(input.turnId);
              })(),
              interrupt: async () => {},
              kill: async () => {},
            }),
          },
        }),
      } as unknown as AgentOptions["providers"];
      const { agent, appended } = reactorWith(
        { scheduler, cliEnabled: true, workspaceRoot: root, providers },
        [thread],
        [{ stack: null }],
        [owner],
        [person],
      );
      agent.react(claude, [message]);
      await settle();
      expect(appended.flat().map((event) => event.type)).toEqual(["agent.queued"]);
      release();
      const deadline = Date.now() + 2_000;
      while (!appended.flat().some((event) => event.type === "agent.turn_completed") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      expect(appended.flat().map((event) => event.type)).toEqual(["agent.queued", "turn.started", "agent.turn_completed"]);
      expect(scheduler.stats().running.cli).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("a turn's streamed tokens", () => {
  /** A CLI that streams what it is given, a little at a time, then ends the turn. */
  function streaming(events: DomainEvent[], gapMs: number) {
    return {
      resolve: async () => ({
        ctx: () => ({}),
        provider: {
          run: () => ({
            events: (async function* () {
              for (const event of events) {
                await new Promise((resolve) => setTimeout(resolve, gapMs));
                yield event;
              }
            })(),
            interrupt: async () => {},
            kill: async () => {},
          }),
        },
      }),
    };
  }

  it("go out in runs, the first at once, all before what follows them", async () => {
    const TURN_FROM_CLI = "66666666-6666-6666-6666-666666666666";
    const delta = (text: string): DomainEvent => ({ type: "agent.text_delta", threadId: THREAD, turnId: TURN_FROM_CLI, text });
    const tool: DomainEvent = { type: "agent.tool_use", threadId: THREAD, turnId: TURN_FROM_CLI, toolUseId: "x", name: "Read", input: {} } as unknown as DomainEvent;
    const letters = "abcdefghij".split("").map(delta);
    const completed: DomainEvent = {
      type: "agent.turn_completed",
      threadId: THREAD,
      turnId: TURN_FROM_CLI,
      stopReason: "end_turn",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
      costUsd: 0,
    };
    const root = await mkdtemp(join(tmpdir(), "ucch-agent-"));
    try {
      const { agent, appended } = reactorWith(
        {
          workspaceRoot: root,
          cliEnabled: true,
          streamFlushMs: 1_000,
          providers: streaming([...letters.slice(0, 5), tool, ...letters.slice(5), completed], 2) as unknown as AgentOptions["providers"],
        },
        [thread],
        [{ stack: null }],
        [owner],
        [person],
      );
      agent.react({ type: "thread.send", threadId: THREAD, text: "hi", provider: "claude" }, [message]);
      const deadline = Date.now() + 2_000;
      while (!appended.flat().some((event) => event.type === "agent.turn_completed") && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
      const streamed = appended
        .filter((batch) => batch.some((event) => event.type !== "turn.started"))
        .map((batch) => batch.map((event) => (event.type === "agent.text_delta" ? `text:${event.text}` : event.type)));
      // A flush interval longer than the whole turn: only the turn's first
      // token goes out on its own, and each run goes out when something
      // durable comes after it.
      expect(streamed).toEqual([
        ["text:a"],
        ["text:bcde"],
        ["agent.tool_use"],
        ["text:fghij"],
        ["agent.turn_completed"],
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("an OMP turn", () => {
  /**
   * The real path below the reactor: `ProviderService`, `OmpProvider` and a
   * process on the host -- `fake-omp.mjs`, which speaks OMP's RPC protocol
   * from a recording, so no key and no network are needed. `OMP_BIN` points
   * the test elsewhere.
   */
  const OMP_BIN = resolve(process.env.OMP_BIN ?? join(import.meta.dirname, "../../../scripts/load/fake-omp.mjs"));
  const FIXTURES = join(import.meta.dirname, "../../../packages/providers/src/fixtures");
  const SECRET = "ab".repeat(32);
  const keyed = { ...person, openrouterKeyEncrypted: encryptSecret("sk-or-test", SECRET) };
  const omp: Command = { type: "thread.send", threadId: THREAD, text: "hi", provider: "omp" };
  let root: string;
  const saved = { fixture: process.env.FAKE_OMP_FIXTURE, length: process.env.FAKE_OMP_LENGTH, rate: process.env.FAKE_OMP_RATE };

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ucch-omp-"));
  });
  afterEach(async () => {
    for (const [name, value] of [
      ["FAKE_OMP_FIXTURE", saved.fixture],
      ["FAKE_OMP_LENGTH", saved.length],
      ["FAKE_OMP_RATE", saved.rate],
    ] as const) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  /** Rows as the database returns them: a thread, and the person it is billed to. */
  type Row = Record<string, unknown>;
  function ompReactor(
    threadRow: Row,
    personRow: Row,
    extra: Partial<AgentOptions> = {},
    ompProvider?: AgentProvider,
    projectRow: Row = { stack: null },
  ) {
    const creds = join(root, "creds");
    const real = createProviders({ claudeBin: "claude", codexBin: "codex", ompBin: OMP_BIN });
    const providers = new ProviderService(
      {} as Database,
      { CREDS_ROOT: creds } as Config,
      new HostProcessHost(),
      ompProvider ? { ...real, omp: ompProvider } : real,
    );
    const scheduler = new TurnScheduler({ cliPerUser: 2, cliTotal: 2, nativeTotal: 2, ompTotal: 1 });
    const built = reactorWith(
      {
        workspaceRoot: join(root, "workspaces"),
        secretKey: SECRET,
        defaultModel: "anthropic/claude-sonnet-4.5",
        cliEnabled: true,
        providers,
        scheduler,
        ...extra,
      },
      [threadRow],
      [projectRow],
      [owner],
      [personRow],
    );
    return { ...built, scheduler, creds };
  }

  async function until(appended: DomainEvent[][], done: (event: DomainEvent) => boolean, ms = 10_000) {
    const deadline = Date.now() + ms;
    while (!appended.flat().some(done) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
    expect(appended.flat().some(done)).toBe(true);
  }
  const closed = (event: DomainEvent) => event.type === "agent.turn_completed" || event.type === "agent.turn_failed";
  /**
   * What the turn does once its events have ended -- the overlay deleted
   * when the process has exited, the slot given back in `finally` -- lands
   * just after its last event, not with it.
   */
  async function eventually<T>(read: () => Promise<T> | T, expected: T) {
    const deadline = Date.now() + 2_000;
    let value = await read();
    while (JSON.stringify(value) !== JSON.stringify(expected) && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
      value = await read();
    }
    expect(value).toEqual(expected);
  }

  it("streams on the OpenRouter model, binds its session, and resumes it on the next turn", async () => {
    const first = ompReactor(thread, keyed);
    first.agent.react(omp, [message]);
    await until(first.appended, closed);
    const events = first.appended.flat();
    expect(events.find((e) => e.type === "turn.started")).toMatchObject({
      provider: "omp",
      model: "anthropic/claude-sonnet-4.5",
    });
    const session = events.find((e) => e.type === "agent.session_started");
    expect(session).toMatchObject({ provider: "omp" });
    const sessionId = (session as Extract<DomainEvent, { type: "agent.session_started" }>).sessionId;
    expect(
      events.filter((e) => e.type === "agent.text_delta").map((e) => (e as { text: string }).text).join(""),
    ).toBe("Hello from the scripted model.");
    expect(events.at(-1)).toMatchObject({
      type: "agent.turn_completed",
      stopReason: "end_turn",
      usage: { inputTokens: 1200, outputTokens: 80 },
      costUsd: 0.0012,
    });
    // The meter's live reading, ending on the session as the turn left it.
    expect(events.filter((e) => e.type === "context.usage").at(-1)).toEqual({
      type: "context.usage",
      threadId: THREAD,
      turnId: (events.find((e) => e.type === "turn.started") as { turnId: string }).turnId,
      usedTokens: 1280,
      windowTokens: 200000,
      thresholdTokens: null,
    });
    // The session is the project's, under the subject; the overlay is gone.
    expect(await readdir(join(first.creds, USER, "omp", "sessions", PROJECT))).toHaveLength(1);
    await eventually(() => readdir(join(first.creds, USER, "omp", "run")), []);

    const second = ompReactor({ ...thread, provider: "omp", providerSessionId: sessionId }, keyed);
    second.agent.react(omp, [message]);
    await until(second.appended, closed);
    const resumed = second.appended.flat();
    expect(resumed.find((e) => e.type === "agent.session_started")).toMatchObject({ sessionId });
    // The session's totals now cover two turns; the turn is billed its own.
    expect(resumed.at(-1)).toMatchObject({ type: "agent.turn_completed", usage: { inputTokens: 1200 }, costUsd: 0.0012 });
    // The context, unlike the bill, is the whole session's.
    expect(resumed.filter((e) => e.type === "context.usage").at(-1)).toMatchObject({ usedTokens: 2560 });
    expect(await readdir(join(second.creds, USER, "omp", "sessions", PROJECT))).toHaveLength(1);
  });

  it("waits for an OMP slot, not a CLI one, and gives it back", async () => {
    const { agent, appended, scheduler } = ompReactor(thread, keyed);
    const taken = await scheduler.acquire({ ownerId: "someone-else", kind: "omp", threadId: "elsewhere" });
    agent.react(omp, [message]);
    await until(appended, (e) => e.type === "agent.queued");
    expect(scheduler.stats().running).toEqual({ cli: 0, native: 0, omp: 1 });
    taken();
    await until(appended, closed);
    expect(appended.flat().at(-1)).toMatchObject({ type: "agent.turn_completed" });
    await eventually(() => scheduler.stats().running.omp, 0);
  });

  it("carries a background task to its answer before the turn ends (OM5.3), and counts it (OM5.4)", async () => {
    // The scout runs after the prompt_result; the turn is over only at the
    // terminal agent_end, after the task's result and the answer to it.
    process.env.FAKE_OMP_FIXTURE = join(FIXTURES, "omp-subagent.jsonl");
    const series = 'omp_subagents_total{provider="omp",status="completed"}';
    const counted = async () => Number((await metrics.render()).split("\n").find((line) => line.startsWith(`${series} `))?.split(" ")[1] ?? 0);
    const before = await counted();
    const { agent, appended } = ompReactor(thread, keyed);
    agent.react(omp, [message]);
    await until(appended, closed);
    const types = appended.flat().map((e) => e.type);
    expect(types.filter((t) => t === "agent.subagent_started")).toHaveLength(1);
    expect(types.filter((t) => t === "agent.subagent_finished")).toHaveLength(1);
    expect(types.indexOf("agent.subagent_started")).toBeLessThan(types.indexOf("agent.subagent_finished"));
    expect(types.indexOf("agent.subagent_finished")).toBeLessThan(types.indexOf("agent.turn_completed"));
    expect(appended.flat().find((e) => e.type === "agent.subagent_finished")).toMatchObject({ status: "completed" });
    expect(appended.flat().at(-1)).toMatchObject({ type: "agent.turn_completed" });
    expect(await counted()).toBe(before + 1);
  });

  it("asks in the chat under Strict, and delivers the answers", async () => {
    process.env.FAKE_OMP_FIXTURE = join(FIXTURES, "omp-confirm.jsonl");
    const { agent, appended } = ompReactor(thread, { ...keyed, agentPermissionMode: "strict" });
    agent.react(omp, [message]);
    for (const behavior of ["allow", "deny"] as const) {
      const asked = appended.flat().filter((e) => e.type === "agent.permission_requested").length;
      await until(appended, () => appended.flat().filter((e) => e.type === "agent.permission_requested").length > asked);
      const request = appended.flat().filter((e) => e.type === "agent.permission_requested").at(-1) as Extract<
        DomainEvent,
        { type: "agent.permission_requested" }
      >;
      expect(request).toMatchObject({ toolName: "bash" });
      agent.react({ type: "thread.permission_reply", threadId: THREAD, requestId: request.requestId, behavior }, []);
    }
    await until(appended, closed);
    const events = appended.flat();
    expect(events.filter((e) => e.type === "agent.permission_resolved").map((e) => (e as { behavior: string }).behavior)).toEqual([
      "allow",
      "deny",
    ]);
    expect(events.at(-1)).toMatchObject({ type: "agent.turn_completed" });
  });

  it("answers a safe command itself under Normal, as for Claude Code", async () => {
    process.env.FAKE_OMP_FIXTURE = join(FIXTURES, "omp-confirm.jsonl");
    const { agent, appended } = ompReactor(thread, keyed);
    agent.react(omp, [message]);
    await until(appended, closed);
    const events = appended.flat();
    expect(events.some((e) => e.type === "agent.permission_requested" || e.type === "agent.permission_resolved")).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: "agent.turn_completed" });
  });

  it("stops on the stop button, closing the turn as cancelled", async () => {
    process.env.FAKE_OMP_LENGTH = "5000";
    process.env.FAKE_OMP_RATE = "200";
    const { agent, appended, creds } = ompReactor(thread, keyed);
    agent.react(omp, [message]);
    await until(appended, (e) => e.type === "agent.text_delta");
    agent.react({ type: "thread.cancel", threadId: THREAD }, []);
    await until(appended, closed);
    expect(appended.flat().at(-1)).toMatchObject({ type: "agent.turn_completed", stopReason: "cancelled" });
    await eventually(() => readdir(join(creds, USER, "omp", "run")), []);
  });

  it("is where a Custom turn goes once OMP_ENABLED is on", async () => {
    const { agent, appended } = ompReactor(thread, keyed, { ompEnabled: true });
    agent.react({ type: "thread.send", threadId: THREAD, text: "hi", provider: "native" }, [message]);
    await until(appended, closed);
    const events = appended.flat();
    expect(events.find((e) => e.type === "turn.started")).toMatchObject({ provider: "omp" });
    expect(events.find((e) => e.type === "agent.session_started")).toMatchObject({ provider: "omp" });
    expect(events.at(-1)).toMatchObject({ type: "agent.turn_completed" });
  });

  describe("host tools", () => {
    /**
     * The recorded xd:// call, made to `current_time` instead of the
     * recording's `ucch_echo`: the way a real model reaches a host tool.
     */
    async function currentTimeFixture(): Promise<string> {
      const recorded = await readFile(join(FIXTURES, "omp-host-tool-xd.jsonl"), "utf8");
      const path = join(root, "omp-current-time.jsonl");
      await writeFile(
        path,
        recorded
          .replaceAll("ucch_echo", "current_time")
          .replaceAll('{"text":"ping"}', '{"timezone":"UTC"}')
          .replaceAll('{\\"text\\":\\"ping\\"}', '{\\"timezone\\":\\"UTC\\"}'),
      );
      return path;
    }

    it("runs a call through runTool, and the chat shows OMP's row with the tool's own result", async () => {
      process.env.FAKE_OMP_FIXTURE = await currentTimeFixture();
      const { agent, appended } = ompReactor(thread, keyed);
      agent.react(omp, [message]);
      await until(appended, closed);
      const events = appended.flat();
      expect(events.filter((e) => e.type === "agent.tool_use")).toEqual([
        expect.objectContaining({ toolUseId: "call_1", name: "current_time", input: { timezone: "UTC" } }),
      ]);
      const result = events.find((e) => e.type === "agent.tool_result") as Extract<DomainEvent, { type: "agent.tool_result" }>;
      expect(result).toMatchObject({ toolUseId: "call_1", isError: false });
      expect(result.content).toMatch(/ISO 8601 \(UTC\): \d{4}-\d{2}-\d{2}T/);
      expect(events.at(-1)).toMatchObject({ type: "agent.turn_completed" });
    });

    it("refuses a call to a tool the turn was not offered", async () => {
      process.env.FAKE_OMP_FIXTURE = join(FIXTURES, "omp-host-tool-xd.jsonl");
      const { agent, appended } = ompReactor(thread, keyed);
      agent.react(omp, [message]);
      await until(appended, closed);
      expect(appended.flat().find((e) => e.type === "agent.tool_result")).toMatchObject({
        isError: true,
        content: 'There is no host tool called "ucch_echo".',
      });
    });
  });

  it("logs the exact prompt it appends, the knowledge inside it, and no AGENTS.md", async () => {
    const workspace = join(root, "workspaces", PROJECT);
    await mkdir(join(workspace, ".ucch"), { recursive: true });
    await writeFile(join(workspace, ".ucch", "INFO.md"), "# Info\nUses pnpm.\n");
    await writeFile(join(workspace, "AGENTS.md"), "Agents file.\n");
    const { agent, appended } = ompReactor(thread, keyed);
    agent.react(omp, [message]);
    await until(appended, closed);
    const injected = appended.flat().filter((e) => e.type === "context.injected");
    expect(injected).toHaveLength(1);
    const [prompt] = injected as Extract<DomainEvent, { type: "context.injected" }>[];
    expect(prompt!.source).toBe("system_prompt");
    expect(prompt!.content).toBe(ompInstructions(workspace, await readProjectKnowledge(workspace)));
    expect(prompt!.content).toContain("Uses pnpm.");
    expect(prompt!.content).toContain("## Working in UCCH");
    expect(prompt!.content).not.toContain("Agents file.");
  });

  it("lets workers run isolated only when the workspace turned it on (OM5.5)", async () => {
    // An OMP that runs nothing, keeping the overlay the turn wrote for it.
    const overlays: string[] = [];
    const provider: AgentProvider = {
      id: "omp",
      label: "Custom",
      models: [],
      probe: async () => ({ installed: true, authenticated: true, authMode: "api-key" }),
      run: (input) => {
        overlays.push(readFileSync(input.omp!.overlayPath, "utf8"));
        return {
          events: (async function* () {
            yield {
              type: "agent.turn_completed",
              threadId: input.threadId,
              turnId: input.turnId,
              stopReason: "end_turn",
              usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
              costUsd: 0,
            } satisfies DomainEvent;
          })(),
          interrupt: async () => {},
          kill: async () => {},
        };
      },
    };
    const isolation = (overlay: string) => /\n  isolation:\n    enabled: (\w+)\n/.exec(overlay)?.[1];
    for (const agentSettings of [undefined, { isolatedFanOut: { enabled: true } }]) {
      const { agent, appended } = ompReactor(thread, keyed, {}, provider, { stack: null, agent: agentSettings });
      agent.react(omp, [message]);
      await until(appended, closed);
    }
    expect(overlays.map(isolation)).toEqual(["false", "true"]);
  });

  it("keeps mnemopi memory only when the workspace turned it on, in one bank per project (OM7.1)", async () => {
    const overlays: string[] = [];
    const provider: AgentProvider = {
      id: "omp",
      label: "Custom",
      models: [],
      probe: async () => ({ installed: true, authenticated: true, authMode: "api-key" }),
      run: (input) => {
        overlays.push(readFileSync(input.omp!.overlayPath, "utf8"));
        return {
          events: (async function* () {
            yield {
              type: "agent.turn_completed",
              threadId: input.threadId,
              turnId: input.turnId,
              stopReason: "end_turn",
              usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
              costUsd: 0,
            } satisfies DomainEvent;
          })(),
          interrupt: async () => {},
          kill: async () => {},
        };
      },
    };
    let creds = "";
    for (const agentSettings of [undefined, { memory: { enabled: true, llmMode: "none" } }]) {
      const built = ompReactor(thread, keyed, {}, provider, { stack: null, agent: agentSettings });
      creds = built.creds;
      built.agent.react(omp, [message]);
      await until(built.appended, closed);
    }
    expect(overlays[0]).toContain('memory:\n  backend: "off"\n');
    expect(overlays[0]).not.toContain("mnemopi:");
    expect(overlays[1]).toContain('memory:\n  backend: "mnemopi"\n');
    expect(overlays[1]).toContain('  scoping: "global"\n');
    expect(overlays[1]).toContain('  llmMode: "none"\n');
    expect(overlays[1]).toContain("  autoRecall: true\n  autoRetain: true\n");
    const dbPath = /\n  dbPath: "?([^"\n]+)"?\n/.exec(overlays[1]!)?.[1];
    expect(dbPath).toMatch(new RegExp(`^${creds}/.+/omp/memories/${PROJECT}/mnemopi\\.db$`));
    expect(statSync(dirname(dbPath!)).mode & 0o777).toBe(0o700);
  });

  describe("in research and documentation mode", () => {
    /**
     * An OMP provider that runs nothing: it keeps what the turn handed it --
     * the input, the overlay as written, the environment -- lets the test act
     * as OMP (calling host tools), and then completes the turn.
     */
    function capturing(act: (input: ProviderRunInput) => Promise<void> = async () => {}) {
      const seen: { input?: ProviderRunInput; overlay?: string; env?: Record<string, string> } = {};
      const provider: AgentProvider = {
        id: "omp",
        label: "Custom",
        models: [],
        probe: async () => ({ installed: true, authenticated: true, authMode: "api-key" }),
        run: (input) => {
          seen.input = input;
          seen.overlay = readFileSync(input.omp!.overlayPath, "utf8");
          seen.env = input.ctx.env;
          return {
            events: (async function* () {
              await act(input);
              yield {
                type: "agent.turn_completed",
                threadId: input.threadId,
                turnId: input.turnId,
                stopReason: "end_turn",
                usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
                costUsd: 0,
              } satisfies DomainEvent;
            })(),
            interrupt: async () => {},
            kill: async () => {},
          };
        },
      };
      return { provider, seen };
    }
    const sendIn = (mode: "research" | "documentation"): [Command, DomainEvent[]] => [
      omp,
      [{ type: "user.message", threadId: THREAD, text: "hi", mode }],
    ];

    it("researches on OMP itself: the research tools, no file changes, no phase on the native loop", async () => {
      let aborted = false;
      let result: { content: string; isError: boolean } | undefined;
      const reader = {
        read: (request: { signal: AbortSignal }) =>
          new Promise<never>((_, reject) => {
            request.signal.addEventListener("abort", () => {
              aborted = true;
              reject(new Error("aborted"));
            });
          }),
      };
      const { provider, seen } = capturing(async (input) => {
        // OMP cancels a fetch still running, as it does on the stop button.
        const cancel = new AbortController();
        const call = input.onHostToolCall!(
          { id: "h1", toolCallId: "call_1", toolName: "research_read", arguments: { url: "https://93.184.215.14/", escalate: null } },
          cancel.signal,
        );
        await new Promise((r) => setTimeout(r, 20));
        cancel.abort();
        result = await call;
      });
      const { agent, appended } = ompReactor(
        thread,
        keyed,
        { research: { searchModel: "perplexity/sonar", reader }, registry: {} },
        provider,
      );
      agent.react(...sendIn("research"));
      await until(appended, closed);
      const events = appended.flat();
      expect(events.at(-1)).toMatchObject({ type: "agent.turn_completed" });
      // The message is the person's own: no brief, because no phase ran.
      expect(seen.input!.prompt).toBe("hi");
      expect(events.some((e) => e.type === "context.injected" && e.source === "research")).toBe(false);
      expect(seen.input!.hostTools!.map((tool) => tool.name)).toEqual([
        "current_time",
        "research_search",
        "research_read",
        "research_browse",
      ]);
      expect(seen.input!.instructions).toContain("## Research turn");
      expect(seen.env!.UCCH_OMP_PRESET).toBe("research");
      for (const line of ['  write: "deny"', '  edit: "deny"', '  research_read: "allow"', '  bash: "prompt"']) {
        expect(seen.overlay).toContain(`\n  ${line}\n`);
      }
      // Cancel reached the fetch, and the call came back failed.
      expect(aborted).toBe(true);
      expect(result).toMatchObject({ isError: true });
    });

    it("writes documents on OMP: the document tools, writes kept to docs/, and the render's events", async () => {
      const kit = join(root, "kit");
      await mkdir(join(kit, "scripts"), { recursive: true });
      const workspace = join(root, "workspaces", PROJECT);
      await mkdir(join(workspace, "docs"), { recursive: true });
      await writeFile(join(workspace, "docs", "notes.md"), "---\ntitle: T\n---\n# A\n");
      await writeFile(
        join(kit, "scripts", "doc_render.py"),
        `echo '{"path":"${workspace}/docs/notes.pdf","format":"pdf","type":"memo","pages":2,"warnings":[],"figure_errors":[]}'\n`,
      );
      await chmod(join(kit, "scripts", "doc_render.py"), 0o755);
      let result: { content: string; isError: boolean } | undefined;
      const { provider, seen } = capturing(async (input) => {
        result = await input.onHostToolCall!(
          {
            id: "h1",
            toolCallId: "call_1",
            toolName: "doc_render",
            arguments: { source: "docs/notes.md", format: "pdf", out: null, fallback: null },
          },
          new AbortController().signal,
        );
      });
      const { agent, appended } = ompReactor(
        thread,
        keyed,
        { documents: { kitDir: kit, python: "/bin/sh", visionModel: "test/vision" }, registry: {} },
        provider,
      );
      agent.react(...sendIn("documentation"));
      await until(appended, closed);
      const events = appended.flat();
      expect(seen.input!.hostTools!.map((tool) => tool.name)).toContain("doc_render");
      expect(seen.input!.instructions).toContain("## Documentation turn");
      expect(seen.input!.instructions).toContain("must be under docs/");
      // The guard hook confines writes to docs/ from this.
      expect(seen.env!.UCCH_OMP_PRESET).toBe("documentation");
      // No CLI documentation prompt: the tools are OMP's to call.
      expect(seen.input!.prompt).toBe("hi");
      expect(result).toMatchObject({ isError: false, content: expect.stringContaining("Rendered docs/notes.pdf (2 pages)") });
      // What a native turn's render emits, landing on the thread the same way.
      expect(events).toContainEqual(expect.objectContaining({ type: "file.changed", projectId: PROJECT, path: "docs/notes.pdf" }));
    });
  });

  it("logs a compaction mid-turn with its method and size, inside the turn", async () => {
    // The replay of a turn that compacts (scripts/load/fake-omp-compaction.sh).
    const wrapper = join(import.meta.dirname, "../../../scripts/load/fake-omp-compaction.sh");
    const { agent, appended } = ompReactor(thread, keyed, {}, new OmpProvider(wrapper));
    agent.react(omp, [message]);
    await until(appended, closed);
    const events = appended.flat();
    const started = events.find((e) => e.type === "turn.started") as { turnId: string };
    expect(events.find((e) => e.type === "context.injected" && e.source === "compaction")).toEqual({
      type: "context.injected",
      threadId: THREAD,
      turnId: started.turnId,
      source: "compaction",
      content: expect.stringContaining("Summary: the session so far."),
      compaction: { method: "soft", tokensBefore: 7383, tokensAfter: 7363 },
    });
    // The meter's readings: up with the model's calls, down after the compaction.
    const readings = events.filter((e) => e.type === "context.usage").map((e) => (e as { usedTokens: number }).usedTokens);
    const dividerAt = events.findIndex((e) => e.type === "context.injected" && e.source === "compaction");
    const after = events.slice(dividerAt).find((e) => e.type === "context.usage") as { usedTokens: number } | undefined;
    expect(readings.length).toBeGreaterThan(1);
    expect(after!.usedTokens).toBeLessThan(Math.max(...readings));
    expect(events.at(-1)).toMatchObject({ type: "agent.turn_completed" });
  });

  describe("compact and handoff between turns", () => {
    /** The reactor as `#compact` reads: the thread, whom to bill, the model the session last ran on. */
    function compactReactor(threadRow: Row, personRow: Row) {
      const creds = join(root, "creds");
      const providers = new ProviderService(
        {} as Database,
        { CREDS_ROOT: creds } as Config,
        new HostProcessHost(),
        createProviders({ claudeBin: "claude", codexBin: "codex", ompBin: OMP_BIN }),
      );
      const scheduler = new TurnScheduler({ cliPerUser: 2, cliTotal: 2, nativeTotal: 2, ompTotal: 1 });
      const built = reactorWith(
        { workspaceRoot: join(root, "workspaces"), secretKey: SECRET, defaultModel: "anthropic/claude-sonnet-4.5", cliEnabled: true, providers, scheduler },
        [threadRow],
        [owner],
        [personRow],
        [{ model: "anthropic/claude-sonnet-4.5" }],
      );
      return { ...built, scheduler, creds };
    }
    const finished = (event: DomainEvent) => event.type === "thread.compaction_finished";

    async function boundThread() {
      const first = ompReactor(thread, keyed);
      first.agent.react(omp, [message]);
      await until(first.appended, closed);
      const session = first.appended.flat().find((e) => e.type === "agent.session_started") as { sessionId: string };
      return { ...thread, provider: "omp", providerSessionId: session.sessionId };
    }

    it.each(["compact", "handoff"] as const)("%s: folds the session, draws the divider with no turn, and frees the thread", async (method) => {
      const bound = await boundThread();
      const { agent, appended, scheduler, creds } = compactReactor(bound, keyed);
      agent.react({ type: method === "compact" ? "thread.compact" : "thread.handoff", threadId: THREAD, focus: "the fix" }, [
        { type: "thread.compaction_requested", threadId: THREAD, method, focus: "the fix" },
      ]);
      await until(appended, finished);
      const events = appended.flat();
      const divider = events.find((e) => e.type === "context.injected");
      expect(divider).toEqual({
        type: "context.injected",
        threadId: THREAD,
        source: "compaction",
        content: method === "compact" ? "Summary: the session so far. Kept: the fix." : "## Goal\nCarry on the work.\n## Next\nthe fix",
        // fake-omp's context: one turn's 1280 tokens, cut to a quarter.
        compaction: { method: method === "compact" ? "soft" : "handoff", tokensBefore: 1280, tokensAfter: 320 },
      });
      expect(events.find((e) => e.type === "context.usage")).toEqual({
        type: "context.usage",
        threadId: THREAD,
        usedTokens: 320,
        windowTokens: 200000,
        thresholdTokens: null,
      });
      expect(events.at(-1)).toEqual({ type: "thread.compaction_finished", threadId: THREAD, method });
      expect(events.some((e) => e.type === "turn.started")).toBe(false);
      // The slot is given back, and the overlay is gone.
      await eventually(() => scheduler.stats().running.omp, 0);
      await eventually(() => readdir(join(creds, USER, "omp", "run")), []);
    });

    it("frees the thread with the reason when there is nothing to fold", async () => {
      const { agent, appended } = compactReactor({ ...thread, provider: "omp", providerSessionId: null }, keyed);
      agent.react({ type: "thread.compact", threadId: THREAD }, [{ type: "thread.compaction_requested", threadId: THREAD, method: "compact" }]);
      await until(appended, finished);
      expect(appended.flat()).toEqual([
        { type: "thread.compaction_finished", threadId: THREAD, method: "compact", error: "this thread has no OMP session to compact yet" },
      ]);
    });

    it("frees the thread, saying so, when it is stopped", async () => {
      const bound = await boundThread();
      const { agent, appended } = compactReactor(bound, keyed);
      agent.react({ type: "thread.compact", threadId: THREAD }, [{ type: "thread.compaction_requested", threadId: THREAD, method: "compact" }]);
      agent.react({ type: "thread.cancel", threadId: THREAD }, []);
      await until(appended, finished);
      expect(appended.flat().at(-1)).toEqual({ type: "thread.compaction_finished", threadId: THREAD, method: "compact", error: "Stopped." });
    });
  });

  describe("a handoff to another provider (solution §5.4)", () => {
    const NEW_THREAD = "99999999-9999-4999-8999-999999999999";
    const NEW_HASH = "n3wsess10n00";
    const principal = { userId: USER, sessionId: "s", scopes: ["read", "write", "exec"] as ("read" | "write" | "exec")[] };
    const handedOff = (event: DomainEvent) => event.type === "thread.handed_off" && event.threadId === THREAD;
    const ended = (event: DomainEvent) => handedOff(event) || event.type === "thread.handoff_failed";

    /** The source's log, in its provider's vocabulary: what every provider's normaliser emits. */
    function history(provider: string): DomainEvent[] {
      const turnId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      return [
        { type: "user.message", threadId: THREAD, text: `Fix the parser bug (on ${provider}).` },
        { type: "turn.started", threadId: THREAD, turnId, provider: provider as "claude" },
        { type: "agent.tool_use", threadId: THREAD, turnId, toolUseId: "t1", name: "edit_file", input: { path: "src/parser.ts" } },
        { type: "agent.tool_result", threadId: THREAD, turnId, toolUseId: "t1", content: "ok", isError: false, durationMs: 3 },
        { type: "file.changed", projectId: PROJECT, path: "src/parser.ts", change: "modified" },
        { type: "agent.message", threadId: THREAD, turnId, content: [{ type: "text", text: "Fixed the off-by-one." }] },
      ];
    }

    /**
     * The reactor as `#handoffTo` reads -- the thread, whom to bill -- with
     * the thread's log in the store and the engine's answers to the new
     * thread and its message recorded.
     */
    async function handoffReactor(threadRow: Row, log: DomainEvent[], options: { refuseSend?: string } = {}) {
      // The project's checkout, which the brief's process runs in.
      await mkdir(join(root, "workspaces", PROJECT), { recursive: true });
      const creds = join(root, "creds");
      const providers = new ProviderService(
        {} as Database,
        { CREDS_ROOT: creds } as Config,
        new HostProcessHost(),
        createProviders({ claudeBin: "claude", codexBin: "codex", ompBin: OMP_BIN }),
      );
      const scheduler = new TurnScheduler({ cliPerUser: 2, cliTotal: 2, nativeTotal: 2, ompTotal: 1 });
      const dispatched: Command[] = [];
      const appendedTo: { threadId: string | null; batch: DomainEvent[] }[] = [];
      const rows: unknown[][] = [[threadRow], [owner], [keyed]];
      const next = () => Promise.resolve(rows.shift() ?? []);
      const chain: Record<string, unknown> = {};
      for (const step of ["from", "innerJoin", "where", "orderBy"]) chain[step] = () => chain;
      chain.limit = next;
      chain.then = (resolve: (value: unknown) => void, reject: (error: unknown) => void) => next().then(resolve, reject);
      const store = {
        append: async (target: { threadId: string | null }, batch: DomainEvent[]) => {
          appendedTo.push({ threadId: target.threadId, batch });
          return [];
        },
        threadHistory: async () => log.map((event, i) => ({ id: String(i), threadId: THREAD, projectId: PROJECT, seq: i, createdAt: "", event })),
      } as unknown as EventStore;
      const errors: unknown[] = [];
      const agent = new AgentTurnReactor(
        { select: () => chain } as unknown as Database,
        store,
        {
          workspaceRoot: join(root, "workspaces"),
          secretKey: SECRET,
          defaultModel: "anthropic/claude-sonnet-4.5",
          searchModel: "google/gemini-flash",
          cliEnabled: true,
          providers,
          scheduler,
          dispatch: async (_principal: unknown, command: Command) => {
            dispatched.push(command);
            if (command.type === "thread.create") {
              return {
                ok: true,
                events: [
                  {
                    id: "1",
                    threadId: NEW_THREAD,
                    projectId: PROJECT,
                    seq: 0,
                    createdAt: "",
                    event: { type: "thread.created", threadId: NEW_THREAD, projectId: PROJECT, title: "t", hash: NEW_HASH, worktreeOf: THREAD },
                  },
                ],
              };
            }
            if (options.refuseSend) return { ok: false, code: "conflict", message: options.refuseSend };
            return { ok: true, events: [] };
          },
        } as unknown as AgentOptions,
        (error) => errors.push(error),
      );
      return { agent, dispatched, appendedTo, scheduler, creds, errors };
    }

    it.each([
      ["claude", "codex"],
      ["codex", "omp"],
      ["omp", "claude"],
    ] as const)("%s -> %s: writes the brief on OMP, opens the new thread in the same folder, and sends it the brief", async (from, to) => {
      const log = join(root, "print.jsonl");
      const saved = process.env.FAKE_OMP_PRINT_LOG;
      process.env.FAKE_OMP_PRINT_LOG = log;
      try {
        // The folder the work is in, which the handoff must leave as it was.
        const tree = join(root, "workspaces", PROJECT);
        await mkdir(join(tree, "src"), { recursive: true });
        await writeFile(join(tree, "src", "parser.ts"), "export const fixed = true;\n");
        const before = await readdir(tree, { recursive: true });

        const source = { ...thread, title: "Fix the parser", provider: from, providerSessionId: "sess-1" };
        const { agent, dispatched, appendedTo, scheduler, creds, errors } = await handoffReactor(source, history(from));
        agent.react(
          { type: "thread.handoff_to", threadId: THREAD, targetProvider: to, focus: "the tests" },
          [{ type: "thread.handoff_requested", threadId: THREAD, targetProvider: to, focus: "the tests" }],
          principal,
        );
        const flat = () => appendedTo.flatMap((entry) => entry.batch);
        const deadline = Date.now() + 10_000;
        while (!flat().some(ended) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        expect(errors).toEqual([]);

        // The brief, from the masked transcript, on the compaction model's smol role, with no tools and no session.
        const [asked] = readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line) as { argv: string[]; stdin: string });
        expect(asked!.argv).toEqual(expect.arrayContaining(["-p", "--no-session", "--no-tools", "--model", "@smol"]));
        expect(asked!.stdin).toContain(`Fix the parser bug (on ${from}).`);
        expect(asked!.stdin).toContain("## Files changed\n- src/parser.ts (modified)");
        const brief = `## Goal\nFix the parser bug (on ${from}).\n## Done\nRead ${asked!.stdin.length} characters of transcript.\n## Next\nthe tests`;

        // A new thread in this one's folder, then the brief as its first message, on the target.
        expect(dispatched).toEqual([
          { type: "thread.create", projectId: PROJECT, title: "Continued: Fix the parser", worktreeOf: THREAD },
          { type: "thread.send", threadId: NEW_THREAD, text: `<handoff-brief>\n${brief}\n</handoff-brief>\n\nContinue from here.`, provider: to },
        ]);
        const link = { type: "thread.handed_off", fromThreadId: THREAD, fromHash: "abcdef123456", toThreadId: NEW_THREAD, toHash: NEW_HASH, targetProvider: to, brief };
        // Linked from both ends: the new thread first, before its message is sent.
        expect(appendedTo).toEqual([
          { threadId: NEW_THREAD, batch: [{ ...link, threadId: NEW_THREAD }] },
          { threadId: THREAD, batch: [{ ...link, threadId: THREAD }] },
        ]);

        // The files are as they were, and nothing is left behind.
        expect(await readdir(tree, { recursive: true })).toEqual(before);
        expect(await readFile(join(tree, "src", "parser.ts"), "utf8")).toBe("export const fixed = true;\n");
        await eventually(() => scheduler.stats().running.omp, 0);
        await eventually(() => readdir(join(creds, USER, "omp", "run")), []);
      } finally {
        if (saved === undefined) delete process.env.FAKE_OMP_PRINT_LOG;
        else process.env.FAKE_OMP_PRINT_LOG = saved;
      }
    });

    it("asks the new thread the message a limit stopped, and says why on both links", async () => {
      const { agent, dispatched, appendedTo, errors } = await handoffReactor({ ...thread, title: "t", provider: "claude" }, history("claude"));
      const requested = { type: "thread.handoff_requested", threadId: THREAD, targetProvider: "codex", message: "Add the retry test", reason: "limit" } as const;
      agent.react({ type: "thread.handoff_to", threadId: THREAD, targetProvider: "codex", message: "Add the retry test", reason: "limit" }, [requested], principal);
      const deadline = Date.now() + 10_000;
      while (!appendedTo.flatMap((entry) => entry.batch).some(ended) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(errors).toEqual([]);
      const sent = dispatched.find((command) => command.type === "thread.send");
      expect(sent).toMatchObject({ provider: "codex", text: expect.stringMatching(/<\/handoff-brief>\n\nAdd the retry test$/) });
      expect(appendedTo.map((entry) => entry.batch[0])).toEqual([
        expect.objectContaining({ type: "thread.handed_off", threadId: NEW_THREAD, reason: "limit" }),
        expect.objectContaining({ type: "thread.handed_off", threadId: THREAD, reason: "limit" }),
      ]);
    });

    it("frees the thread with OMP's error, starting nothing", async () => {
      const saved = process.env.FAKE_OMP_PRINT_FAIL;
      process.env.FAKE_OMP_PRINT_FAIL = "No API key found for openrouter.";
      try {
        const { agent, dispatched, appendedTo } = await handoffReactor({ ...thread, title: "t", provider: "claude" }, history("claude"));
        agent.react({ type: "thread.handoff_to", threadId: THREAD, targetProvider: "omp" }, [
          { type: "thread.handoff_requested", threadId: THREAD, targetProvider: "omp" },
        ], principal);
        const deadline = Date.now() + 10_000;
        while (!appendedTo.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        expect(dispatched).toEqual([]);
        expect(appendedTo).toEqual([
          { threadId: THREAD, batch: [{ type: "thread.handoff_failed", threadId: THREAD, error: "error: No API key found for openrouter." }] },
        ]);
      } finally {
        if (saved === undefined) delete process.env.FAKE_OMP_PRINT_FAIL;
        else process.env.FAKE_OMP_PRINT_FAIL = saved;
      }
    });

    it("says why when the new thread's message is refused", async () => {
      const { agent, appendedTo } = await handoffReactor({ ...thread, title: "t", provider: "codex" }, history("codex"), { refuseSend: "the CLI is not signed in" });
      agent.react({ type: "thread.handoff_to", threadId: THREAD, targetProvider: "claude" }, [
        { type: "thread.handoff_requested", threadId: THREAD, targetProvider: "claude" },
      ], principal);
      const deadline = Date.now() + 10_000;
      while (!appendedTo.some((e) => e.threadId === THREAD) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(appendedTo.find((e) => e.threadId === THREAD)!.batch).toEqual([
        { type: "thread.handoff_failed", threadId: THREAD, error: "the new thread could not start: the CLI is not signed in" },
      ]);
    });

    it("frees the thread, saying so, when it is stopped before the brief is written", async () => {
      const { agent, dispatched, appendedTo } = await handoffReactor({ ...thread, title: "t", provider: "omp" }, history("omp"));
      agent.react({ type: "thread.handoff_to", threadId: THREAD, targetProvider: "claude" }, [
        { type: "thread.handoff_requested", threadId: THREAD, targetProvider: "claude" },
      ], principal);
      agent.react({ type: "thread.cancel", threadId: THREAD }, []);
      const deadline = Date.now() + 10_000;
      while (!appendedTo.length && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
      expect(dispatched).toEqual([]);
      expect(appendedTo).toEqual([{ threadId: THREAD, batch: [{ type: "thread.handoff_failed", threadId: THREAD, error: "Stopped." }] }]);
    });
  });

  it("fails the turn, spawning nothing, without an OpenRouter key", async () => {
    const { agent, appended, creds } = ompReactor(thread, person);
    agent.react(omp, [message]);
    await until(appended, closed);
    expect(appended.flat().at(-1)).toMatchObject({ type: "agent.turn_failed", error: expect.stringContaining("No OpenRouter API key") });
    await expect(readdir(join(creds, USER, "omp", "sessions"))).rejects.toThrow();
  });
});

describe("automatic handoff on a usage limit (OM4.6)", () => {
  const principal = { userId: USER, sessionId: "s", scopes: ["read", "write", "exec"] as ("read" | "write" | "exec")[] };
  const FIXTURES = join(import.meta.dirname, "../../../packages/providers/src/fixtures");
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ucch-limit-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** Claude Code as the recorded limit fixture plays it, through the real normaliser. */
  const limitedClaude: AgentProvider = {
    id: "claude",
    label: "Claude Code",
    models: [],
    probe: async () => ({ installed: true, authenticated: true, authMode: "subscription" }),
    run: (input) => ({
      events: (async function* () {
        const normaliser = new ClaudeNormaliser({ ...input, workspace: input.ctx.cwd });
        for (const line of readFileSync(join(FIXTURES, "claude-limit.jsonl"), "utf8").split("\n")) yield* normaliser.push(line);
        yield* normaliser.finish({ code: 0, signal: null, interrupted: false, stderrTail: "" });
      })(),
      interrupt: async () => {},
      kill: async () => {},
    }),
  };

  /**
   * A Claude Code turn on a bound thread. The database answers by what is
   * asked: the workspace's agent settings for the handoff's read, otherwise
   * the turn's own rows in order.
   */
  function limitReactor(agentSettings: unknown, log: DomainEvent[] = []) {
    const rows: unknown[][] = [[{ ...thread, provider: "claude", providerSessionId: "s1" }], [{ stack: null }], [owner], [person]];
    const select = (fields?: Record<string, unknown>) => {
      const next = () => Promise.resolve(fields && "agent" in fields ? [{ agent: agentSettings }] : (rows.shift() ?? []));
      const chain: Record<string, unknown> = {};
      for (const step of ["from", "innerJoin", "where", "orderBy"]) chain[step] = () => chain;
      chain.limit = next;
      chain.then = (resolve: (value: unknown) => void, reject: (error: unknown) => void) => next().then(resolve, reject);
      return chain;
    };
    const appended: DomainEvent[][] = [];
    const store = {
      append: async (_target: unknown, batch: DomainEvent[]) => {
        appended.push(batch);
        return [];
      },
      threadHistory: async () => log.map((event, i) => ({ id: String(i), threadId: THREAD, projectId: PROJECT, seq: i, createdAt: "", event })),
    } as unknown as EventStore;
    const dispatched: Command[] = [];
    const errors: unknown[] = [];
    const providers = {
      resolve: async () => ({ provider: limitedClaude, ctx: (cwd: string) => ({ cwd, env: {}, host: new HostProcessHost() }) }),
    } as unknown as ProviderService;
    const agent = new AgentTurnReactor(
      { select } as unknown as Database,
      store,
      {
        workspaceRoot: join(root, "workspaces"),
        defaultModel: "anthropic/claude-sonnet-4.5",
        cliEnabled: true,
        providers,
        dispatch: async (_principal: unknown, command: Command) => {
          dispatched.push(command);
          return { ok: true, events: [] };
        },
      } as unknown as AgentOptions,
      (error) => errors.push(error),
    );
    return { agent, appended, dispatched, errors };
  }

  const on = { autoHandoff: { enabled: true, fallbackProvider: "codex" } };
  const ask = { type: "thread.send", threadId: THREAD, text: "Add the retry test", provider: "claude" } as const;
  const asked: DomainEvent = { type: "user.message", threadId: THREAD, text: "Add the retry test" };

  async function settled(run: ReturnType<typeof limitReactor>) {
    const deadline = Date.now() + 5_000;
    while (!run.appended.flat().some((e) => e.type === "agent.turn_failed") && Date.now() < deadline) await settle();
    await settle();
  }

  it("hands the recorded limit off once, to the fallback, with the message that failed", async () => {
    const run = limitReactor(on);
    run.agent.react(ask, [asked], principal);
    await settled(run);
    expect(run.appended.flat().find((e) => e.type === "agent.turn_failed")).toMatchObject({ limit: true });
    expect(run.dispatched).toEqual([
      { type: "thread.handoff_to", threadId: THREAD, targetProvider: "codex", message: "Add the retry test", reason: "limit" },
    ]);
    expect(run.errors).toEqual([]);
  });

  it("does not loop: a thread a limit handoff started, or one that made one, fails as it would", async () => {
    const link = {
      type: "thread.handed_off",
      fromThreadId: "99999999-9999-4999-8999-999999999999",
      fromHash: "abcdef654321",
      toThreadId: THREAD,
      toHash: "abcdef123456",
      targetProvider: "claude",
      brief: "b",
      reason: "limit",
    } as const;
    for (const log of [[{ ...link, threadId: THREAD }], [{ ...link, threadId: THREAD, fromThreadId: THREAD, toThreadId: link.fromThreadId }]]) {
      const run = limitReactor(on, log);
      run.agent.react(ask, [asked], principal);
      await settled(run);
      expect(run.appended.flat().some((e) => e.type === "agent.turn_failed")).toBe(true);
      expect(run.dispatched).toEqual([]);
    }
  });

  it("does nothing with the setting off, with no fallback, or with the limited provider as the fallback", async () => {
    for (const settings of [
      {},
      { autoHandoff: { enabled: false, fallbackProvider: "codex" } },
      { autoHandoff: { enabled: true, fallbackProvider: null } },
      { autoHandoff: { enabled: true, fallbackProvider: "claude" } },
    ]) {
      const run = limitReactor(settings);
      run.agent.react(ask, [asked], principal);
      await settled(run);
      expect(run.dispatched).toEqual([]);
    }
  });
});

describe("the OMP bridge on a Claude Code turn (OM6.4)", () => {
  const SECRET = "ab".repeat(32);
  const keyed = { ...person, openrouterKeyEncrypted: encryptSecret("sk-or-bridge", SECRET), defaultModel: "openai/gpt-5" };
  const ask: Command = { type: "thread.send", threadId: THREAD, text: "hi", provider: "claude" };
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ucch-bridge-"));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  /** What the turn handed Claude Code, read while the CLI "runs". */
  interface Seen {
    input: ProviderRunInput;
    config: { mcpServers: { omp: { command: string; args: string[]; env: Record<string, string> } } } | null;
    mode: number | null;
    overlay: string | null;
  }

  /** A Claude Code that runs nothing, through the real `ProviderService` (no token in the database). */
  function bridgeReactor(
    personRow: Record<string, unknown>,
    agentSettings: unknown,
    withBridge = true,
    id: "claude" | "codex" = "claude",
    threadRow: Record<string, unknown> = thread,
    extra: { omp?: AgentProvider; messages?: unknown[][] } = {},
  ) {
    const seen: Seen[] = [];
    const claude: AgentProvider = {
      id,
      label: id,
      models: [],
      probe: async () => ({ installed: true, authenticated: true, authMode: "subscription" }),
      run: (input) => {
        // Codex's argv names a file with the environment in it; read it as the bridge would.
        const path = input.mcpConfigPath ?? input.codexMcp?.env.UCCH_BRIDGE_ENV_FILE;
        const read = path ? (JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>) : null;
        const config = !read
          ? null
          : input.codexMcp
            ? { mcpServers: { omp: { command: input.codexMcp.command, args: [...input.codexMcp.args], env: read as Record<string, string> } } }
            : (read as unknown as Seen["config"]);
        const overlay = config?.mcpServers.omp.env.UCCH_OMP_OVERLAY;
        seen.push({
          input,
          config,
          mode: path ? statSync(path).mode & 0o777 : null,
          overlay: overlay ? readFileSync(overlay, "utf8") : null,
        });
        return {
          events: (async function* () {
            for (const content of extra.messages ?? []) {
              yield { type: "agent.message", threadId: input.threadId, turnId: input.turnId, content } satisfies DomainEvent;
            }
            yield {
              type: "agent.turn_completed",
              threadId: input.threadId,
              turnId: input.turnId,
              stopReason: "end_turn",
              usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 },
              costUsd: 0,
            } satisfies DomainEvent;
          })(),
          interrupt: async () => {},
          kill: async () => {},
        };
      },
    };
    class NoToken extends ProviderService {
      override async claudeToken(): Promise<string | null> {
        return null;
      }
    }
    const real = createProviders({ claudeBin: "claude", codexBin: "codex", ompBin: "omp" });
    const providers = new NoToken({} as Database, { CREDS_ROOT: join(root, "creds") } as Config, new HostProcessHost(), {
      ...real,
      ...(extra.omp ? { omp: extra.omp } : {}),
      [id]: claude,
    });
    const tokens = new Map<string, { ownerId: string; threadId: string }>();
    const registered: string[] = [];
    const leases = {
      register(holder: { ownerId: string; threadId: string }) {
        const token = `tok-${registered.length}`;
        registered.push(token);
        tokens.set(token, holder);
        return { token, revoke: () => void tokens.delete(token) };
      },
    };
    const built = reactorWith(
      {
        workspaceRoot: join(root, "workspaces"),
        secretKey: SECRET,
        defaultModel: "anthropic/claude-sonnet-4.5",
        cliEnabled: true,
        providers,
        ...(withBridge ? { ompBridge: { bin: "/opt/ucch/omp-bridge.mjs", ompBin: "/usr/bin/omp", socket: "/c/omp-scheduler.sock", maxSeconds: 240, leases } } : {}),
      },
      [threadRow],
      [{ stack: null, agent: agentSettings }],
      [owner],
      [personRow],
    );
    return { ...built, seen, tokens, registered };
  }

  async function turn(run: ReturnType<typeof bridgeReactor>, command: Command = ask) {
    run.agent.react(command, [message]);
    const deadline = Date.now() + 5_000;
    const done = (e: DomainEvent) => e.type === "agent.turn_completed" || e.type === "agent.turn_failed";
    while (!run.appended.flat().some(done) && Date.now() < deadline) await settle();
    await settle();
    expect(run.appended.flat().find(done)?.type).toBe("agent.turn_completed");
    expect(run.errors).toEqual([]);
  }

  it("hands Claude Code an MCP config with the bridge's environment, and keeps the key out of the CLI's own", async () => {
    const run = bridgeReactor(keyed, { ompBridge: { enabled: true } });
    await turn(run);
    const [{ input, config, mode, overlay }] = run.seen as [Seen];
    expect(input.mcpConfigPath).toBe(join(root, "creds", USER, "claude", "run", `${input.turnId}.mcp.json`));
    expect(mode).toBe(0o600);
    const server = config!.mcpServers.omp;
    expect(server.command).toBe(process.execPath);
    expect(server.args).toEqual(["/opt/ucch/omp-bridge.mjs"]);
    expect(server.env).toEqual({
      UCCH_OMP_BIN: "/usr/bin/omp",
      UCCH_OMP_AGENT_DIR: join(root, "creds", USER, "omp", "agent"),
      UCCH_OMP_OVERLAY: join(root, "creds", USER, "omp", "run", `bridge-${input.turnId}.yml`),
      OPENROUTER_API_KEY: "sk-or-bridge",
      UCCH_WORKTREE: input.ctx.cwd,
      UCCH_SCHEDULER_SOCK: "/c/omp-scheduler.sock",
      UCCH_BRIDGE_TOKEN: "tok-0",
      UCCH_BRIDGE_MAX_SECONDS: "240",
    });
    // Billing: the CLI's environment has no key of any kind; the bridge's has the OpenRouter key alone.
    expect(forbiddenEnvPresent(input.ctx.env)).toBeNull();
    expect(Object.keys(input.ctx.env).filter((name) => /_API_KEY$|_OAUTH_TOKEN$/.test(name))).toEqual([]);
    expect(forbiddenEnvFor("omp", server.env)).toBeNull();
    // The overlay: headless approvals, the account's OpenRouter model on every role, no debugger.
    expect(overlay).toContain('  default: "openrouter/openai/gpt-5"\n');
    expect(overlay).toContain('  smol: "openrouter/openai/gpt-5"\n');
    expect(overlay).toContain("  maxConcurrency: 2\n");
    expect(overlay).toContain('    bash: "allow"\n');
    expect(overlay).toContain('    debug: "deny"\n');
    // Gone with the turn: both files, and the token.
    expect(existsSync(input.mcpConfigPath!)).toBe(false);
    expect(existsSync(server.env.UCCH_OMP_OVERLAY!)).toBe(false);
    expect(run.registered).toEqual(["tok-0"]);
    expect(run.tokens.size).toBe(0);
  });

  it("gives the bridge the project's memory when the workspace keeps it (OM7.2)", async () => {
    const run = bridgeReactor(keyed, { ompBridge: { enabled: true }, memory: { enabled: true } });
    await turn(run);
    const [{ config, overlay }] = run.seen as [Seen];
    expect(config!.mcpServers.omp.env.UCCH_OMP_MEMORY).toBe("1");
    expect(overlay).toContain('memory:\n  backend: "mnemopi"\n');
    expect(overlay).toContain(`  dbPath: "${join(root, "creds", USER, "omp", "memories", PROJECT, "mnemopi.db")}"\n`);
    // A call is not a turn: the bank only through omp_recall and omp_retain.
    expect(overlay).toContain("  autoRecall: false\n  autoRetain: false\n");
    const off = bridgeReactor(keyed, { ompBridge: { enabled: true } });
    await turn(off);
    expect(off.seen[0]!.config!.mcpServers.omp.env.UCCH_OMP_MEMORY).toBeUndefined();
    expect(off.seen[0]!.overlay).toContain('memory:\n  backend: "off"\n');
  });

  describe("end-of-turn retention (OM7.2)", () => {
    /** An OMP that only answers `ask`, keeping what it was asked with and the overlay as written. */
    function asker() {
      const asked: { input: OmpAskInput; overlay: string }[] = [];
      const omp = {
        id: "omp",
        label: "Custom",
        models: [],
        probe: async () => ({ installed: true, authenticated: true, authMode: "api-key" }),
        run: () => {
          throw new Error("not a turn");
        },
        ask: async (input: OmpAskInput) => {
          asked.push({ input, overlay: readFileSync(input.omp.overlayPath, "utf8") });
          return "Kept 1 fact.";
        },
      } as AgentProvider & { ask(input: OmpAskInput): Promise<string> };
      return { omp, asked };
    }
    const messages = [
      [{ type: "text", text: "Looking at the deploy config." }, { type: "tool_use", id: "t1", name: "Bash", input: { command: "cat fly.toml" } }],
      [{ type: "tool_result", tool_use_id: "t1", content: "SECRET_TOKEN=abc" }],
      [{ type: "text", text: "Decision: deploys go to region ams, because fra has no GPUs." }],
    ];
    const memoryOn = { enabled: true, llmMode: "smol", retainCliTurns: true };

    async function retained(asked: unknown[]) {
      const deadline = Date.now() + 3_000;
      while (asked.length === 0 && Date.now() < deadline) await settle();
    }

    it("reads the final answer alone into the project's bank, on smol with only retain", async () => {
      for (const id of ["claude", "codex"] as const) {
        const { omp, asked } = asker();
        const run = bridgeReactor(keyed, { memory: memoryOn }, false, id, thread, { omp, messages });
        await turn(run, { ...ask, provider: id });
        await retained(asked);
        expect(asked, id).toHaveLength(1);
        const [{ input, overlay }] = asked as [(typeof asked)[number]];
        expect(input.tools).toEqual(["retain"]);
        expect(input.model).toBe("@smol");
        expect(input.prompt).toBe(RETAIN_PROMPT);
        expect(input.stdin).toBe("<answer>\nDecision: deploys go to region ams, because fra has no GPUs.\n</answer>\n");
        expect(input.stdin).not.toContain("SECRET_TOKEN");
        expect(overlay).toContain(`  dbPath: "${join(root, "creds", USER, "omp", "memories", PROJECT, "mnemopi.db")}"\n`);
        expect(overlay).toContain('  smol: "openrouter/openai/gpt-5"\n');
        // Only what the model keeps: the run itself is never retained whole.
        expect(overlay).toContain("  autoRecall: false\n  autoRetain: false\n");
        // The key reaches OMP through its environment only.
        expect(input.ctx.env.OPENROUTER_API_KEY).toBe("sk-or-bridge");
      }
    });

    it("retains nothing with the toggle off, with memory off, without a key, or with no answer", async () => {
      for (const [personRow, agentSettings, msgs] of [
        [keyed, { memory: { ...memoryOn, retainCliTurns: false } }, messages],
        [keyed, { memory: { ...memoryOn, enabled: false } }, messages],
        [person, { memory: memoryOn }, messages],
        [keyed, { memory: memoryOn }, [messages[0]!.slice(1)]],
      ] as const) {
        const { omp, asked } = asker();
        const run = bridgeReactor(personRow, agentSettings, false, "claude", thread, { omp, messages: msgs as unknown[][] });
        await turn(run);
        await new Promise((r) => setTimeout(r, 50));
        expect(asked).toEqual([]);
      }
    });
  });

  it("hands Codex the server by -c flags that name a 0600 file, with the key in the file and not in argv", async () => {
    const run = bridgeReactor(keyed, { ompBridge: { enabled: true } }, true, "codex");
    await turn(run, { ...ask, provider: "codex" });
    const [{ input, config, mode }] = run.seen as [Seen];
    expect(input.mcpConfigPath).toBeUndefined();
    const file = join(root, "creds", USER, "codex", "run", `${input.turnId}.bridge.json`);
    // What Codex's argv carries (`codexMcpArgs`): paths, and a timeout past the bridge's own.
    expect(input.codexMcp).toEqual({
      command: process.execPath,
      args: ["/opt/ucch/omp-bridge.mjs"],
      env: { UCCH_BRIDGE_ENV_FILE: file },
      toolTimeoutSec: 240 + 70,
      toolsApproval: "approve",
    });
    expect(JSON.stringify(input.codexMcp)).not.toContain("sk-or-bridge");
    expect(mode).toBe(0o600);
    expect(config!.mcpServers.omp.env).toMatchObject({ OPENROUTER_API_KEY: "sk-or-bridge", UCCH_BRIDGE_TOKEN: "tok-0", UCCH_WORKTREE: input.ctx.cwd });
    expect(forbiddenEnvPresent(input.ctx.env)).toBeNull();
    expect(Object.keys(input.ctx.env).filter((name) => /_API_KEY$|_OAUTH_TOKEN$/.test(name))).toEqual([]);
    expect(existsSync(file)).toBe(false);
    expect(run.tokens.size).toBe(0);
  });

  /** What the log says the CLI was handed about the bridge. */
  const guides = (run: ReturnType<typeof bridgeReactor>) =>
    run.appended.flat().filter((e) => e.type === "context.injected" && e.source === "omp_bridge");

  it("hands the CLI the bridge's guide with its instructions, and logs it, only with the bridge (OM6.6)", async () => {
    const guide = ompBridgeGuide();
    expect(guide).toMatch(/^## OMP tools/);
    for (const id of ["claude", "codex"] as const) {
      const on = bridgeReactor(keyed, { ompBridge: { enabled: true } }, true, id);
      await turn(on, { ...ask, provider: id });
      expect(on.seen[0]!.input.instructions).toBe(guide);
      expect(guides(on)).toEqual([{ type: "context.injected", threadId: THREAD, source: "omp_bridge", content: guide }]);
    }
    for (const off of [bridgeReactor(keyed, { ompBridge: { enabled: false } }), bridgeReactor(person, { ompBridge: { enabled: true } })]) {
      await turn(off);
      expect(off.seen[0]!.input.instructions).toBeUndefined();
      expect(guides(off)).toEqual([]);
    }
  });

  it("does not claim the guide for a resumed Codex session, which is not handed instructions", async () => {
    const resumed = bridgeReactor(keyed, { ompBridge: { enabled: true } }, true, "codex", { ...thread, provider: "codex", providerSessionId: "th-1" });
    await turn(resumed, { ...ask, provider: "codex" });
    expect(resumed.seen[0]!.input.codexMcp).toBeDefined();
    expect(guides(resumed)).toEqual([]);
  });

  it("offers nothing with the setting off, with no bridge on the server, or with no key to bill", async () => {
    for (const run of [
      bridgeReactor(keyed, undefined),
      bridgeReactor(keyed, { ompBridge: { enabled: false } }),
      bridgeReactor(keyed, { ompBridge: { enabled: true } }, false),
      bridgeReactor(person, { ompBridge: { enabled: true } }),
    ]) {
      await turn(run);
      expect(run.seen[0]!.input.mcpConfigPath).toBeUndefined();
      expect(run.seen[0]!.input.codexMcp).toBeUndefined();
      expect(run.registered).toEqual([]);
    }
  });
});

describe("claudePromptNeedsPerson for the OMP bridge's tools", () => {
  const reads = ["omp_symbols", "omp_recall", "omp_review", "omp_task"];
  const rest = ["omp_rename", "omp_codemod", "omp_debug", "omp_retain", "omp_handoff_brief", "omp_ping"];
  it("asks under Strict, asks for all but the read-only ones under Normal, and never after Allow All", () => {
    for (const tool of [...reads, ...rest]) {
      const name = `mcp__omp__${tool}`;
      expect(claudePromptNeedsPerson("strict", name, {}), name).toBe(true);
      expect(claudePromptNeedsPerson("normal", name, {}), name).toBe(!reads.includes(tool));
      expect(claudePromptNeedsPerson("allow_all", name, {}), name).toBe(false);
    }
  });

  it("leaves Claude Code's own tools as they were", () => {
    expect(claudePromptNeedsPerson("normal", "Bash", { command: "ls" })).toBe(false);
    expect(claudePromptNeedsPerson("normal", "Bash", { command: "rm -rf /" })).toBe(true);
    expect(claudePromptNeedsPerson("normal", "Edit", {})).toBe(true);
    expect(claudePromptNeedsPerson("normal", "WebFetch", {})).toBe(false);
  });
});
