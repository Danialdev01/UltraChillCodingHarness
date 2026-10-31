import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Database } from "@ucch/db";
import type { Command, DomainEvent } from "@ucch/protocol";
import { createProviders, HostProcessHost } from "@ucch/providers";
import {
  AgentTurnReactor,
  ompInstructions,
  resolveModel,
  resolveProvider,
  shouldRecheckStack,
  turnKindOf,
  type AgentOptions,
} from "./agent.js";
import type { Config } from "./config.js";
import { encryptSecret } from "./crypto.js";
import type { EventStore } from "./eventstore.js";
import { ProviderService } from "./providers.js";
import { TurnScheduler } from "./turn-scheduler.js";

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
  for (const step of ["from", "innerJoin", "where"]) chain[step] = () => chain;
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
  function ompReactor(threadRow: Row, personRow: Row, extra: Partial<AgentOptions> = {}) {
    const creds = join(root, "creds");
    const providers = new ProviderService(
      {} as Database,
      { CREDS_ROOT: creds } as Config,
      new HostProcessHost(),
      createProviders({ claudeBin: "claude", codexBin: "codex", ompBin: OMP_BIN }),
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
      [{ stack: null }],
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

  it("fails the turn, spawning nothing, without an OpenRouter key", async () => {
    const { agent, appended, creds } = ompReactor(thread, person);
    agent.react(omp, [message]);
    await until(appended, closed);
    expect(appended.flat().at(-1)).toMatchObject({ type: "agent.turn_failed", error: expect.stringContaining("No OpenRouter API key") });
    await expect(readdir(join(creds, USER, "omp", "sessions"))).rejects.toThrow();
  });
});
