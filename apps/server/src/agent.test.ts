import { describe, expect, it } from "vitest";
import type { Database } from "@ucch/db";
import type { Command, DomainEvent } from "@ucch/protocol";
import { AgentTurnReactor, resolveModel, resolveProvider, shouldRecheckStack, type AgentOptions } from "./agent.js";
import type { EventStore } from "./eventstore.js";

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
});

describe("shouldRecheckStack", () => {
  it("looks again after every fifth turn of the project", () => {
    expect([1, 2, 3, 4, 5, 6, 9, 10, 15].filter(shouldRecheckStack)).toEqual([5, 10, 15]);
  });

  it("never on a project with no turns", () => {
    expect(shouldRecheckStack(0)).toBe(false);
  });
});

describe("a queued message that never becomes a turn", () => {
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
    const options = { workspaceRoot: "/nonexistent-ucch-test-root" } as unknown as AgentOptions;
    const errors: unknown[] = [];
    return { agent: new AgentTurnReactor(db, store, options, (error) => errors.push(error)), appended, errors };
  }

  const send: Command = { type: "thread.send", threadId: THREAD, text: "hi" };
  const message: DomainEvent = { type: "user.message", threadId: THREAD, text: "hi" };
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

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
