import { randomUUID } from "node:crypto";
import type { ApprovalDecision, ApprovalRequest, Executor } from "@ucch/agent";
import type { DomainEvent, TokenUsage } from "@ucch/protocol";
import { DeltaCoalescer, isDelta } from "./delta-coalescer.js";

/**
 * The tools the agent beside the terminals gets: a shell and the file
 * tools, run on the host by an `SshExecutor`. No `list_dir` (it needs `rg`,
 * which a server rarely has; `ls` does the job), and nothing that assumes a
 * project -- no widgets, no uploads, no web.
 */
export const REMOTE_TOOLSET = ["bash", "read_file", "write_file", "edit_file", "delete_file"] as const;

/** How long a conversation nobody writes to is kept. */
const CHAT_IDLE_MS = 2 * 60 * 60_000;
/** Conversations one person keeps at once; the oldest goes first. */
const MAX_CHATS_PER_USER = 20;
/** Events one conversation keeps; past that, the oldest exchanges go. */
const MAX_CHAT_EVENTS = 4000;

/** What the reactor needs to run one turn, supplied by the server's wiring. */
export interface RemoteTurnRunner {
  (input: {
    userId: string;
    workspaceId: string;
    chatId: string;
    turnId: string;
    model?: string;
    history: readonly DomainEvent[];
    executor: Executor;
    systemPrompt: string;
    toolset: readonly string[];
    approve: (request: ApprovalRequest) => Promise<ApprovalDecision>;
    append: (events: readonly DomainEvent[]) => Promise<void>;
    publish: (event: DomainEvent) => void;
    signal: AbortSignal;
  }): Promise<{ text: string; model: string; usage: TokenUsage; costUsd: number }>;
}

interface Chat {
  id: string;
  userId: string;
  hostId: string;
  workspaceId: string;
  /** The durable part of the conversation, oldest first: what the model and a reload see. */
  log: DomainEvent[];
  running: AbortController | null;
  prompts: Map<string, (decision: ApprovalDecision) => void>;
  /** "Allow for this conversation" was answered once. */
  allowAll: boolean;
  usedAt: number;
}

/** Why a message could not start a turn; the route says it as a 409 or 404. */
export class RemoteChatBusy extends Error {}
export class RemoteChatNotFound extends Error {}

/** What the agent is told about where it is. */
export function remoteSystemPrompt(host: { name: string; username: string; host: string; port: number; home: string }): string {
  return [
    `You are working on a remote server over SSH, as a system administrator would, beside the person's own terminal.`,
    `The server is "${host.name}": ${host.username}@${host.host}${host.port === 22 ? "" : ` port ${host.port}`}. You are logged in as ${host.username}, and your home directory there is ${host.home}.`,
    `Your tools act on that server, not on any project: bash runs a command there (each call is a fresh non-interactive shell starting in ${host.home}, so cd within the same command), and read_file, write_file, edit_file and delete_file work on its files by absolute path or a path relative to the home directory.`,
    `Every command and every change you make is shown to the person to approve before it runs, and they may refuse. Prefer read-only commands to find things out first. Never run something destructive or disruptive -- deleting data, restarting services, changing firewall rules, upgrading packages -- unless the person asked for it, and say what it will do before you do it.`,
    `Interactive programs (editors, pagers, top, prompts waiting for input) will hang: use their batch forms (top -bn1, systemctl --no-pager, git --no-pager, apt-get -y only when asked).`,
    `When the person quotes terminal output, it is from their own shell on this server. Be concise and concrete: say what you found and what you did, and give commands they can run themselves when that is the better answer.`,
  ].join("\n\n");
}

/**
 * The Terminal section's agent: one conversation per chat panel, each bound
 * to one SSH host, running the native loop with an `SshExecutor`.
 *
 * Conversations live in memory, not the event log -- they belong to no
 * project -- and are dropped after a couple of quiet hours or on restart.
 * Every event goes to the person's own topic wrapped as
 * `remote_chat.event`, which the panel folds like a thread's; a reload asks
 * for the log again (`history`).
 *
 * Every command and every file change is asked about, whatever the account's
 * permission mode says for projects: this is someone's server, not a
 * sandbox. "Allow for this conversation" is the only way past that, and
 * only for the one conversation.
 */
export class RemoteChatReactor {
  readonly #chats = new Map<string, Chat>();

  constructor(
    private readonly run: RemoteTurnRunner,
    private readonly publishToUser: (userId: string, event: DomainEvent) => void,
    private readonly onError: (error: unknown) => void = () => {},
  ) {}

  /** The durable log of a conversation, for a panel that reloaded. */
  history(chatId: string, userId: string): { hostId: string; events: DomainEvent[]; running: boolean } | null {
    const chat = this.#chats.get(chatId);
    if (!chat || chat.userId !== userId) return null;
    return { hostId: chat.hostId, events: chat.log, running: chat.running !== null };
  }

  /**
   * Starts a turn. Resolves once it has started (not finished): the reply
   * streams on the user's topic. Throws `RemoteChatBusy` while one runs.
   */
  send(input: {
    chatId: string;
    userId: string;
    hostId: string;
    workspaceId: string;
    text: string;
    selection?: string;
    model?: string;
    executor: () => Promise<{ executor: Executor; systemPrompt: string }>;
  }): void {
    this.#prune();
    let chat = this.#chats.get(input.chatId);
    if (chat && (chat.userId !== input.userId || chat.hostId !== input.hostId)) {
      // Another person's id, or this one moved to another host: a fresh conversation.
      if (chat.userId !== input.userId) throw new RemoteChatNotFound("not your conversation");
      if (chat.running) throw new RemoteChatBusy("the agent is still working; stop it first");
      chat = undefined;
      this.#chats.delete(input.chatId);
    }
    if (chat?.running) throw new RemoteChatBusy("the agent is still working; stop it or wait for it");
    if (!chat) {
      chat = {
        id: input.chatId,
        userId: input.userId,
        hostId: input.hostId,
        workspaceId: input.workspaceId,
        log: [],
        running: null,
        prompts: new Map(),
        allowAll: false,
        usedAt: Date.now(),
      };
      this.#chats.set(input.chatId, chat);
      this.#limitPerUser(input.userId);
    }
    chat.usedAt = Date.now();
    const controller = new AbortController();
    chat.running = controller;
    void this.#turn(chat, input, controller).finally(() => {
      if (chat.running === controller) chat.running = null;
    });
  }

  /** Answers the agent's question. False when there is no such open question. */
  reply(chatId: string, userId: string, requestId: string, behavior: "allow" | "deny", scope: "once" | "session"): boolean {
    const chat = this.#chats.get(chatId);
    if (!chat || chat.userId !== userId) return false;
    const resolve = chat.prompts.get(requestId);
    if (!resolve) return false;
    if (behavior === "allow" && scope === "session") chat.allowAll = true;
    resolve(behavior === "allow" ? { behavior: "allow" } : { behavior: "deny", message: "The person declined this." });
    return true;
  }

  /** Stops the running turn, if any. */
  stop(chatId: string, userId: string): boolean {
    const chat = this.#chats.get(chatId);
    if (!chat || chat.userId !== userId || !chat.running) return false;
    chat.running.abort();
    return true;
  }

  /** Forgets every conversation on a host that was deleted. */
  dropHost(hostId: string): void {
    for (const [id, chat] of this.#chats) {
      if (chat.hostId !== hostId) continue;
      chat.running?.abort();
      this.#chats.delete(id);
    }
  }

  stopAll(): void {
    for (const chat of this.#chats.values()) chat.running?.abort();
  }

  async #turn(
    chat: Chat,
    input: { text: string; selection?: string; model?: string; executor: () => Promise<{ executor: Executor; systemPrompt: string }> },
    controller: AbortController,
  ): Promise<void> {
    const turnId = randomUUID();
    const threadId = chat.id;
    const emit = (event: DomainEvent) => this.publishToUser(chat.userId, { type: "remote_chat.event", chatId: chat.id, event: event as unknown as Record<string, unknown> });
    const record = (events: readonly DomainEvent[]) => {
      for (const event of events) {
        chat.log.push(event);
        emit(event);
      }
      if (chat.log.length > MAX_CHAT_EVENTS) chat.log.splice(0, chat.log.length - MAX_CHAT_EVENTS);
    };
    const coalescer = new DeltaCoalescer((delta) => emit(delta), { flushMs: 40 });

    const text = input.selection
      ? `${input.text}\n\nFrom my terminal:\n\`\`\`\n${input.selection}\n\`\`\``
      : input.text;
    record([
      { type: "user.message", threadId, text },
      { type: "turn.started", threadId, turnId, provider: "native" },
    ]);

    try {
      const { executor, systemPrompt } = await input.executor();
      const outcome = await this.run({
        userId: chat.userId,
        workspaceId: chat.workspaceId,
        chatId: chat.id,
        turnId,
        ...(input.model ? { model: input.model } : {}),
        history: chat.log,
        executor,
        systemPrompt,
        toolset: REMOTE_TOOLSET,
        approve: (request) => this.#approve(chat, turnId, request, controller.signal, record),
        append: async (events) => {
          coalescer.flush();
          record(events);
        },
        publish: (event) => {
          if (isDelta(event)) coalescer.push(event);
          else emit(event);
        },
        signal: controller.signal,
      });
      coalescer.dispose();

      // The loop appends its own completion; a cancelled one may not have.
      if (!chat.log.some((event) => "turnId" in event && event.turnId === turnId && (event.type === "agent.turn_completed" || event.type === "agent.turn_failed"))) {
        record([{ type: "agent.turn_completed", threadId, turnId, stopReason: controller.signal.aborted ? "cancelled" : null, usage: outcome.usage, costUsd: outcome.costUsd }]);
      }
    } catch (error) {
      coalescer.dispose();
      const message = controller.signal.aborted ? "Stopped." : error instanceof Error ? error.message : String(error);
      if (!controller.signal.aborted) this.onError(error);
      record([{ type: "agent.turn_failed", threadId, turnId, error: message.slice(0, 2000) }]);
    } finally {
      for (const resolve of chat.prompts.values()) resolve({ behavior: "deny", message: "The turn ended." });
      chat.prompts.clear();
      chat.usedAt = Date.now();
    }
  }

  async #approve(
    chat: Chat,
    turnId: string,
    request: ApprovalRequest,
    signal: AbortSignal,
    record: (events: readonly DomainEvent[]) => void,
  ): Promise<ApprovalDecision> {
    if (chat.allowAll) return { behavior: "allow" };
    if (signal.aborted) return { behavior: "deny", message: "The turn was cancelled." };
    const requestId = randomUUID();
    const decision = new Promise<ApprovalDecision>((resolve) => {
      const onAbort = () => resolve({ behavior: "deny", message: "The turn was cancelled." });
      signal.addEventListener("abort", onAbort, { once: true });
      chat.prompts.set(requestId, (reply) => {
        signal.removeEventListener("abort", onAbort);
        resolve(reply);
      });
    });
    record([
      {
        type: "agent.permission_requested",
        threadId: chat.id,
        turnId,
        requestId,
        toolUseId: request.toolUseId,
        toolName: request.toolName,
        input: request.input,
        description: null,
      },
    ]);
    try {
      const reply = await decision;
      record([{ type: "agent.permission_resolved", threadId: chat.id, turnId, requestId, behavior: reply.behavior }]);
      return reply;
    } finally {
      chat.prompts.delete(requestId);
    }
  }

  #prune(): void {
    const now = Date.now();
    for (const [id, chat] of this.#chats) {
      if (!chat.running && now - chat.usedAt > CHAT_IDLE_MS) this.#chats.delete(id);
    }
  }

  #limitPerUser(userId: string): void {
    const mine = [...this.#chats.values()].filter((chat) => chat.userId === userId && !chat.running);
    mine.sort((a, b) => a.usedAt - b.usedAt);
    while (mine.length > MAX_CHATS_PER_USER) this.#chats.delete(mine.shift()!.id);
  }
}

