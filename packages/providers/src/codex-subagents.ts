import { createHash } from "node:crypto";
import { StringDecoder } from "node:string_decoder";
import { createReadStream, statSync } from "node:fs";
import { createInterface } from "node:readline";
import { open, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import type { DomainEvent } from "@ucch/protocol";
import type { AgentRun, ProviderRunInput } from "./types.js";
import { codexRollout } from "./codex-images.js";

type State = { status?: string; message?: string | null };
type Collaboration = {
  id?: string; tool?: string; prompt?: string; model?: string;
  receiver_thread_ids?: string[];
  agents_states?: Record<string, State>;
};
type Child = {
  call: string; agent: string; description: string | null; model: string | null;
  started: number; generationAt: number; closedAt: number; tools: number; toolsKnown: boolean;
  finished: boolean; lastProgress: number; lastMessage?: string; taskTurn?: string;
  outcome?: "completed" | "failed" | "aborted"; reportedDuration?: number; reportedTools?: number;
};
type Call = { name: string; args: Record<string, unknown>; at: number };
const object = (value: unknown): Record<string, any> => value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
const string = (value: unknown): string | undefined => typeof value === "string" ? value : undefined;
function decode(value: unknown): Record<string, any> {
  try { return object(typeof value === "string" ? JSON.parse(value) : value); } catch { return {}; }
}
function toolInput(value: unknown): unknown {
  if (typeof value !== "string") return value ?? null;
  try { return JSON.parse(value); } catch { return value; }
}
function state(value: unknown): State {
  if (typeof value === "string") return { status: value };
  const obj = object(value);
  if (typeof obj.status === "string") return { status: obj.status, message: string(obj.message) };
  const entry = Object.entries(obj)[0];
  return entry ? { status: entry[0], message: string(entry[1]) } : {};
}

/** Native workers share Claude/OMP's domain events; provider details stay here. */
export class CodexSubagents {
  readonly since: number;
  readonly children = new Map<string, Child>();
  readonly spawnCalls = new Map<string, string | undefined>();
  readonly sessions = new Map<string, string>();
  #aliases = new Map<string, string>();
  #calls = new Map<string, Call>();
  #seen = new Map<string, Set<string>>();
  #parentSession = "";
  #parentTurn = "";
  constructor(private readonly ctx: { threadId: string; turnId: string; now?: () => number }) { this.since = this.#now(); }
  #ids() { return { threadId: this.ctx.threadId, turnId: this.ctx.turnId }; }
  #now() { return (this.ctx.now ?? Date.now)(); }
  #at(record: Record<string, unknown>) {
    const at = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : NaN;
    return Number.isFinite(at) ? at : this.#now();
  }
  setParentSession(id: string) { this.#parentSession = id; }
  #id(id: string) { return this.#aliases.get(id) ?? id; }
  #path(path: string) { return `${this.#parentSession}:${path}`; }
  #target(target: unknown): string | undefined {
    if (typeof target !== "string") return undefined;
    return this.#aliases.get(target) ?? this.#aliases.get(`/root/${target}`) ?? (this.children.has(target) ? target : undefined);
  }
  #started(id: string, child: Child): DomainEvent {
    return { type: "agent.subagent_started", ...this.#ids(), subagentId: id, parentToolUseId: child.call,
      agent: child.agent, provider: "codex", description: child.description, model: child.model };
  }
  #restart(id: string, at: number): DomainEvent[] {
    const child = this.children.get(id);
    if (!child || at <= child.generationAt) return [];
    child.finished = false;
    child.started = child.generationAt = at;
    child.closedAt = 0;
    child.tools = 0;
    child.toolsKnown = false;
    child.lastProgress = -Infinity;
    child.lastMessage = undefined;
    child.taskTurn = undefined;
    child.outcome = undefined;
    child.reportedDuration = child.reportedTools = undefined;
    return [this.#started(id, child)];
  }
  #status(id: string, value: State, at: number, allowRestart = false): DomainEvent[] {
    const child = this.children.get(id);
    if (!child || at < child.generationAt) return [];
    const events: DomainEvent[] = [];
    // A later status snapshot can be the first indication of another task.
    if (allowRestart && child.finished && ["running", "pending_init"].includes(value.status ?? "") && at > child.closedAt) events.push(...this.#restart(id, at));
    if (value.message) events.push(...this.output(id, "text", value.message));
    const terminal = value.status === "completed" ? "completed"
      : ["errored", "failed", "not_found"].includes(value.status ?? "") ? "failed"
      : ["shutdown", "interrupted"].includes(value.status ?? "") ? "aborted" : null;
    if (terminal) events.push(...this.finish(id, terminal, value.message ?? null, at));
    return events;
  }

  observe(item: Collaboration): DomainEvent[] {
    const events: DomainEvent[] = [];
    if (item.tool === "spawn_agent" && item.id) this.spawnCalls.set(item.id, item.prompt);
    const states = object(item.agents_states);
    const ids = new Set([...(Array.isArray(item.receiver_thread_ids) ? item.receiver_thread_ids : []), ...Object.keys(states)]);
    for (const providerId of ids) {
      if (typeof providerId !== "string" || !providerId) continue;
      const id = this.#id(providerId);
      let child = this.children.get(id);
      if (!child) {
        const call = item.tool === "spawn_agent" && item.id ? item.id : `codex-agent-${id}`;
        child = { call, agent: "Codex", description: item.prompt ?? null, model: item.model ?? null,
          started: this.#now(), generationAt: this.since, closedAt: 0, tools: 0, toolsKnown: false, finished: false, lastProgress: -Infinity };
        this.children.set(id, child);
        this.sessions.set(id, providerId);
        if (call !== item.id) events.push({ type: "agent.tool_use", ...this.#ids(), toolUseId: call, name: "Agent", input: { description: item.prompt ?? "Codex subagent" } });
        events.push(this.#started(id, child));
      }
      const value = state(states[providerId]);
      if (child.finished && ["send_input", "resume_agent"].includes(item.tool ?? "") && ["running", "pending_init"].includes(value?.status ?? "")) {
        events.push(...this.#restart(id, Math.max(this.#now(), child.generationAt + 1)));
      }
      if (value) events.push(...this.#status(id, value, Math.max(this.#now(), child.generationAt)));
    }
    return events;
  }

  #record(stream: string, raw: string): Record<string, any> | null {
    let record;
    try { record = object(JSON.parse(raw)); } catch { return null; }
    const key = typeof record.ordinal === "number" ? String(record.ordinal) : createHash("sha256").update(raw).digest("hex");
    const seen = this.#seen.get(stream) ?? new Set<string>();
    this.#seen.set(stream, seen);
    if (seen.has(key)) return null;
    seen.add(key);
    return record;
  }

  /** Exec 0.167 omits native v2 calls/replies; the exact parent's rollout retains them. */
  parentRollout(raw: string): DomainEvent[] {
    const record = this.#record("parent", raw);
    if (!record) return [];
    const payload = object(record.payload);
    const at = this.#at(record);
    if (record.type === "session_meta") {
      this.setParentSession(string(payload.id) ?? string(payload.session_id) ?? this.#parentSession);
      return [];
    }
    if (record.type === "response_item") {
      if (payload.type === "function_call" && payload.namespace === "collaboration" && typeof payload.call_id === "string") {
        this.#calls.set(payload.call_id, { name: payload.name, args: decode(payload.arguments), at });
      }
      if (payload.type === "function_call_output" && typeof payload.call_id === "string") {
        const call = this.#calls.get(payload.call_id);
        if (!call) return [];
        this.#calls.delete(payload.call_id);
        const result = decode(payload.output);
        if (payload.is_error === true || result.error) return [];
        if (call.name === "spawn_agent" && typeof result.task_name === "string") {
          const path = result.task_name;
          const id = this.#target(path) ?? this.#path(path);
          this.#aliases.set(path, id);
          this.#aliases.set(path.split("/").pop()!, id);
          if (this.children.has(id)) return [];
          const child: Child = { call: payload.call_id, agent: path.split("/").pop() || path,
            // v2's message may be encrypted. Never display or try to decode it.
            description: string(call.args.description) ?? string(call.args.prompt) ??
              (typeof call.args.message === "string" && !call.args.message.startsWith("gAAAA") ? call.args.message : null), model: string(call.args.model) ?? null,
            started: call.at, generationAt: call.at, closedAt: 0, tools: 0, toolsKnown: false, finished: false, lastProgress: -Infinity };
          this.children.set(id, child);
          return [
            { type: "agent.tool_use", ...this.#ids(), toolUseId: child.call, name: "Agent", input: { agent: child.agent, description: child.description } },
            this.#started(id, child),
            { type: "agent.tool_result", ...this.#ids(), toolUseId: child.call, content: JSON.stringify({ task_name: path }), isError: false, durationMs: Math.max(0, Math.round(at - call.at)) },
          ];
        }
        if (call.name === "list_agents" && Array.isArray(result.agents)) {
          return result.agents.flatMap((entry: unknown) => {
            const agent = object(entry);
            const id = this.#target(agent.agent_name);
            return id ? this.#status(id, state(agent.agent_status), at, true) : [];
          });
        }
        const id = this.#target(call.args.target);
        if (id && call.name === "interrupt_agent") return this.finish(id, "aborted", "Agent interrupted.", at);
        if (id && call.name === "followup_task") return this.#restart(id, call.at);
        // wait_agent's result only reports mailbox activity, never task success.
      }
      if (payload.type === "agent_message" && typeof payload.author === "string") {
        const id = this.#target(payload.author);
        if (!id || !Array.isArray(payload.content) || at < this.children.get(id)!.generationAt) return [];
        const events: DomainEvent[] = [];
        for (const block of payload.content) {
          const text = string(object(block).text);
          if (!text) continue;
          // The captured envelope distinguishes a final reply from a coordination message.
          const match = /^Message Type: (FINAL_ANSWER|MESSAGE)\nTask name: [^\n]+\nSender: ([^\n]+)\nPayload:\n([\s\S]*)$/.exec(text);
          if (!match || match[2] !== payload.author) continue;
          events.push(...this.output(id, "text", match[3]!));
          if (match[1] === "FINAL_ANSWER") events.push(...this.finish(id, "completed", match[3]!, at));
        }
        return events;
      }
      return [];
    }
    if (record.type !== "event_msg") return [];
    if (payload.type === "task_started") this.#parentTurn = string(payload.turn_id) ?? "";
    if (payload.type === "collab_agent_spawn_end" && typeof payload.new_thread_id === "string") {
      const call = string(payload.call_id) ?? [...this.spawnCalls].find(([call, prompt]) => prompt === payload.prompt && ![...this.children.values()].some(child => child.call === call))?.[0];
      return this.observe({ id: call, tool: "spawn_agent", prompt: payload.prompt, model: payload.model,
        receiver_thread_ids: [payload.new_thread_id], agents_states: { [payload.new_thread_id]: state(payload.status) } });
    }
    if (payload.type === "collab_waiting_end") {
      return this.observe({ tool: "wait", agents_states: Object.fromEntries(Object.entries(object(payload.statuses)).map(([id, value]) => [id, state(value)])) });
    }
    if (["collab_close_end", "collab_agent_interaction_end", "collab_resume_end"].includes(payload.type) && typeof payload.receiver_thread_id === "string") {
      return this.observe({ tool: payload.type === "collab_resume_end" ? "resume_agent" : "wait", agents_states: { [payload.receiver_thread_id]: state(payload.status) } });
    }
    return [];
  }

  /** Link only metadata proven to belong to this parent and a successfully spawned path. */
  bindSession(meta: unknown): string | undefined {
    const value = object(meta);
    const spawn = object(object(object(value.source).subagent).thread_spawn);
    if ((value.parent_thread_id ?? spawn.parent_thread_id) !== this.#parentSession) return undefined;
    const path = string(value.agent_path) ?? string(spawn.agent_path);
    const session = string(value.id) ?? string(value.session_id);
    const id = path ? this.#target(path) : undefined;
    if (!id || !session) return undefined;
    this.#aliases.set(session, id);
    this.sessions.set(id, session);
    return id;
  }

  progress(id: string, text: string): DomainEvent[] {
    const child = this.children.get(id);
    if (!child || child.finished || !text.trim() || this.#now() - child.lastProgress < 1000) return [];
    child.lastProgress = this.#now();
    return [{ type: "agent.subagent_progress", ...this.#ids(), subagentId: id, summary: text.trim().split("\n")[0]!.slice(0, 300),
      ...(child.toolsKnown ? { toolCalls: child.tools } : {}), ...(child.model ? { model: child.model } : {}), durationMs: Math.max(0, Math.round(this.#now() - child.started)) }];
  }

  output(id: string, kind: "text" | "thinking", text: string): DomainEvent[] {
    const child = this.children.get(id);
    if (!child || !text.trim() || kind === "text" && child.lastMessage === text) return [];
    if (kind === "text") child.lastMessage = text;
    return [{ type: "agent.subagent_output", ...this.#ids(), subagentId: id, kind, text: text.slice(0, 20_000) }, ...this.progress(id, text)];
  }

  finish(id: string, status: "completed" | "failed" | "aborted", result: string | null, at = this.#now(), durationMs?: number): DomainEvent[] {
    const child = this.children.get(id);
    if (!child || at < child.generationAt) return [];
    // A parent reply can arrive before we drain the child's own completion.
    // Enrich the same outcome with provider timing/tool counts, never reopen it.
    if (child.finished && !(child.outcome === status && durationMs !== undefined &&
      (child.reportedDuration !== durationMs || child.toolsKnown && child.reportedTools !== child.tools))) return [];
    child.finished = true;
    child.outcome = status;
    child.closedAt = Math.max(child.closedAt, at);
    child.reportedDuration = durationMs ?? Math.max(0, Math.round(at - child.started));
    child.reportedTools = child.toolsKnown ? child.tools : undefined;
    return [{ type: "agent.subagent_finished", ...this.#ids(), subagentId: id, status, result: (result ?? child.lastMessage)?.slice(0, 8000) ?? null,
      ...(child.toolsKnown ? { toolCalls: child.tools } : {}), ...(child.model ? { model: child.model } : {}), durationMs: Math.max(0, Math.round(durationMs ?? at - child.started)) }];
  }

  /** Ignore the inherited parent transcript; accept only a worker's attributed task. */
  rollout(id: string, raw: string): DomainEvent[] {
    const record = this.#record(id, raw);
    const child = this.children.get(id);
    if (!record || !child) return [];
    const payload = object(record.payload);
    if (record.type === "session_meta") { this.bindSession(payload); return []; }
    const at = this.#at(record);
    if (at < child.generationAt) return [];
    if (record.type === "event_msg" && payload.type === "task_started") {
      const attribution = object(payload.turn_attribution);
      // v2 forks copy the parent's turn and a synthetic abort before the worker's turn.
      if (attribution.parent_turn_id === null || this.#parentTurn &&
        (payload.turn_id === this.#parentTurn || attribution.parent_turn_id !== undefined && attribution.parent_turn_id !== this.#parentTurn)) return [];
      if (typeof payload.turn_id !== "string") return [];
      const events = child.finished && at > child.closedAt ? this.#restart(id, at) : [];
      child.taskTurn = payload.turn_id;
      child.toolsKnown = true;
      if (!child.finished) child.started = at;
      return events;
    }
    // Untimestamped legacy fixtures/rollouts predate attributed task boundaries.
    if (!child.taskTurn && (this.#parentTurn || record.timestamp)) return [];
    if (record.type === "event_msg") {
      if (payload.turn_id && child.taskTurn && payload.turn_id !== child.taskTurn) return [];
      if (payload.type === "task_complete") return this.finish(id, "completed", string(payload.last_agent_message) ?? null, at,
        typeof payload.duration_ms === "number" ? payload.duration_ms : undefined);
      if (payload.type === "turn_aborted") return this.finish(id, "aborted", string(payload.reason) ?? "Agent interrupted.", at);
    }
    if (record.type === "turn_context" && payload.turn_id === child.taskTurn && typeof payload.model === "string" && child.model !== payload.model) {
      child.model = payload.model;
      return [{ type: "agent.subagent_progress", ...this.#ids(), subagentId: id, summary: child.lastMessage?.split("\n")[0]?.slice(0, 300) ?? "", model: child.model! }];
    }
    if (record.type !== "response_item") return [];
    const attributedTurn = object(payload.internal_chat_message_metadata_passthrough).turn_id;
    if (attributedTurn && child.taskTurn && attributedTurn !== child.taskTurn) return [];
    if (payload.type === "message" && payload.role === "assistant" && Array.isArray(payload.content)) {
      return payload.content.flatMap((block: unknown) => typeof object(block).text === "string" ? this.output(id, "text", object(block).text) : []);
    }
    if (payload.type === "reasoning" && Array.isArray(payload.summary)) return payload.summary.flatMap((block: unknown) => typeof object(block).text === "string" ? this.output(id, "thinking", object(block).text) : []);
    if (["function_call", "custom_tool_call"].includes(payload.type) && typeof payload.call_id === "string") {
      child.tools++;
      child.toolsKnown = true;
      return [{ type: "agent.tool_use", ...this.#ids(), subagentId: id, toolUseId: `${id}:${payload.call_id}`, name: string(payload.name) ?? "tool",
        input: toolInput(payload.input ?? payload.arguments) }, ...this.progress(id, string(payload.name) ?? "tool")];
    }
    if (["function_call_output", "custom_tool_call_output"].includes(payload.type) && typeof payload.call_id === "string") {
      const content = typeof payload.output === "string" ? payload.output : JSON.stringify(payload.output ?? "");
      return [{ type: "agent.tool_result", ...this.#ids(), toolUseId: `${id}:${payload.call_id}`, content: content.slice(0, 20_000), isError: payload.is_error === true,
        durationMs: typeof payload.duration_ms === "number" ? Math.max(0, Math.round(payload.duration_ms)) : 0 }];
    }
    return [];
  }

  /** Restore identity only. Old tasks stay dormant until this turn resumes them. */
  restored() {
    for (const child of this.children.values()) {
      child.finished = true;
      child.generationAt = child.closedAt = this.since;
      child.taskTurn = undefined;
      child.lastMessage = undefined;
      child.toolsKnown = false;
    }
    this.#calls.clear();
    this.#seen.clear();
  }

  dispose() {
    this.#seen.clear(); this.#calls.clear(); this.#aliases.clear(); this.spawnCalls.clear(); this.sessions.clear(); this.children.clear();
  }
}

/** Read only a rollout's metadata, never unrelated conversations. */
async function metadata(path: string): Promise<unknown> {
  let handle;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(64 * 1024);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const line = buffer.subarray(0, bytesRead).toString("utf8").split("\n")[0]!;
    const record = JSON.parse(line);
    return record.type === "session_meta" ? record.payload : undefined;
  } catch { return undefined; }
  finally { await handle?.close(); }
}
async function rolloutFiles(home: string, depth = 3): Promise<string[]> {
  const files: string[] = [];
  try {
    for (const entry of await readdir(home, { withFileTypes: true })) {
      const path = join(home, entry.name);
      if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(path);
      else if (entry.isDirectory() && depth > 0) files.push(...await rolloutFiles(path, depth - 1));
    }
  } catch { /* Older/ephemeral Codex may have no session directory. */ }
  return files;
}

/** Tail only this parent's workers under this account's Codex home. */
export function withCodexSubagents(input: ProviderRunInput, run: AgentRun, agents: CodexSubagents, sessionId: () => string | null = () => input.resumeToken ?? null): AgentRun {
  const previous = codexRollout(input.ctx.env.CODEX_HOME, input.resumeToken);
  let previousOffset = 0;
  try { if (previous) previousOffset = statSync(previous).size; } catch {}
  return { ...run, events: { async *[Symbol.asyncIterator]() {
    const offsets = new Map<string, { path: string; offset: number; partial: string; decoder: StringDecoder }>();
    const inspected = new Map<string, unknown>();
    let backlog = false;
    const read = async (id: string, path: string, parent: boolean): Promise<DomainEvent[]> => {
      const events: DomainEvent[] = [];
      let cursor = offsets.get(id);
      cursor ??= { path, offset: parent && path === previous ? previousOffset : 0, partial: "", decoder: new StringDecoder("utf8") };
      offsets.set(id, cursor);
      let handle;
      try {
        const info = await stat(path);
        if (info.size < cursor.offset) { cursor.offset = 0; cursor.partial = ""; cursor.decoder = new StringDecoder("utf8"); }
        if (info.size === cursor.offset) return [];
        handle = await open(path, "r");
        const buffer = Buffer.alloc(Math.min(info.size - cursor.offset, 1024 * 1024));
        const { bytesRead } = await handle.read(buffer, 0, buffer.length, cursor.offset);
        cursor.offset += bytesRead;
        if (cursor.offset < info.size) backlog = true;
        const lines = (cursor.partial + cursor.decoder.write(buffer.subarray(0, bytesRead))).split("\n");
        cursor.partial = lines.pop()!;
        // A corrupt/unfinished record must not grow an unbounded buffer.
        if (cursor.partial.length > 4 * 1024 * 1024) cursor.partial = "";
        for (const line of lines) events.push(...(parent ? agents.parentRollout(line) : agents.rollout(id, line)));
      } catch { /* Rollout creation/rotation can race a poll. Retry next tick. */ }
      finally { await handle?.close(); }
      return events;
    };
    const poll = async (): Promise<DomainEvent[]> => {
      backlog = false;
      const events: DomainEvent[] = [];
      const parent = sessionId();
      if (parent) {
        agents.setParentSession(parent);
        const path = offsets.get(parent)?.path ?? codexRollout(input.ctx.env.CODEX_HOME, parent);
        if (path) events.push(...await read(parent, path, true));
      }
      if ([...agents.children.keys()].some(id => !agents.sessions.has(id)) && input.ctx.env.CODEX_HOME) {
        for (const path of await rolloutFiles(join(input.ctx.env.CODEX_HOME, "sessions"))) {
          const meta = inspected.get(path) ?? await metadata(path);
          if (meta) inspected.set(path, meta);
          const id = agents.bindSession(meta);
          if (id && !offsets.has(id)) offsets.set(id, { path, offset: 0, partial: "", decoder: new StringDecoder("utf8") });
        }
      }
      for (const [id, session] of agents.sessions) {
        const path = offsets.get(id)?.path ?? codexRollout(input.ctx.env.CODEX_HOME, session);
        if (path) events.push(...await read(id, path, false));
      }
      return events;
    };
    const iterator = run.events[Symbol.asyncIterator]();
    let pending = iterator.next();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const terminal: DomainEvent[] = [];
    try {
      if (previous && previousOffset > 0) {
        const history = createInterface({ input: createReadStream(previous, { start: 0, end: previousOffset - 1 }), crlfDelay: Infinity });
        try { for await (const line of history) agents.parentRollout(line); }
        catch { /* Identity recovery is optional when a rollout was removed. */ }
        finally { history.close(); agents.restored(); }
      }
      let nextPoll = Date.now() + 300;
      while (true) {
        const next = await Promise.race([pending, new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), Math.max(0, nextPoll - Date.now())); })]);
        clearTimeout(timer);
        if (next === null) {
          for (const event of await poll()) yield event;
          nextPoll = Date.now() + 300;
          continue;
        }
        if (next.done) break;
        if (next.value.type === "agent.turn_completed" || next.value.type === "agent.turn_failed") terminal.push(next.value);
        else yield next.value;
        pending = iterator.next();
        // Busy exec output must not starve native rollout visibility.
        if (Date.now() >= nextPoll) {
          for (const event of await poll()) yield event;
          nextPoll = Date.now() + 300;
        }
      }
      for (let pass = 0; pass < 32; pass++) {
        for (const event of await poll()) yield event;
        if (!backlog) break;
      }
      // The exec process/observer has ended. This says observation was interrupted,
      // not that the child succeeded, failed, or its reusable session was closed.
      for (const [id] of agents.children) for (const event of agents.finish(id, "aborted", "Codex execution ended before the child's outcome was observed.")) yield event;
      for (const event of terminal) yield event;
    } catch (error) {
      for (const [id] of agents.children) for (const event of agents.finish(id, "aborted", "Codex event stream ended unexpectedly before the child's outcome was observed.")) yield event;
      throw error;
    } finally {
      clearTimeout(timer);
      offsets.clear(); inspected.clear(); agents.dispose();
      await iterator.return?.();
    }
  } } };
}
