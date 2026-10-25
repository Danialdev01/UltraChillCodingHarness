import type { DomainEvent, MessageMode } from "@ucch/protocol";
import { parseAttachments, type MessageAttachment } from "./attachments.js";

/**
 * Folding the event log into what the chat draws.
 *
 * Kept out of the component because it is the only part of the view with
 * real rules in it -- iteration ordering, the delta/message overlap, results
 * finding their calls -- and those are worth testing without a renderer.
 *
 * The client holds no independent model of the world (§6.7), so everything
 * here is derived: reloading mid-turn rebuilds the same screen from the same
 * events, because there is nothing else keeping it.
 */

/** A run of assistant prose. One per model response within a turn. */
export interface TextPart {
  kind: "text";
  text: string;
  /** Still being filled by deltas: no `agent.message` has settled it yet. */
  streaming: boolean;
}

/** One tool call and, once it lands, its result. */
export interface ToolPart {
  kind: "tool";
  id: string;
  name: string;
  input: unknown;
  /** null until `agent.tool_result` arrives -- the call is still running. */
  result: string | null;
  isError: boolean;
  durationMs: number | null;
  /** Paused on a permission prompt: the CLI is waiting, not working. */
  awaitingApproval?: boolean;
}

export type MessagePart = TextPart | ToolPart;

/** A CLI's question, open until a person or the end of the turn answers it. */
export interface PermissionPrompt {
  requestId: string;
  turnId: string;
  toolUseId: string | null;
  toolName: string;
  input: unknown;
  description: string | null;
}

export interface ChatMessage {
  role: "user" | "assistant";
  /** The user's text. An assistant's prose lives in `parts`. */
  text: string;
  /**
   * Files that rode along with a user message.
   *
   * Split back out of the stored text, which carries the ids and any inlined
   * contents the model needs: the reader gets a tag per file and the
   * sentence they actually typed.
   */
  attachments?: MessageAttachment[];
  /** How the message asked to be answered. Absent on an ordinary one. */
  mode?: MessageMode;
  parts: MessagePart[];
  reasoning: string;
  /** True while the turn is open: no `turn_completed` and no `turn_failed`. */
  streaming: boolean;
  /** From `agent.turn_completed`. "cancelled" and "max_iterations" are not failures. */
  stopReason?: string | null;
  error?: string;
  turnId?: string;
  /**
   * When the turn began and ended, as Unix ms -- the two ends of the "cooked
   * for" line under an answer. Either is null when its event was never seen:
   * the log is capped, and a subscription can begin mid-turn.
   */
  startedAt: number | null;
  completedAt: number | null;
  /**
   * Which backend answered, from `turn.started`. Absent on turns written
   * before the field existed, which read as the native loop. Shown as a
   * label -- the one thing the chat says about a provider, so the reader
   * knows what a turn was billed to.
   */
  provider?: string;
}

/** The turn in flight, for the progress line above the composer. */
export interface TurnActivity {
  turnId: string;
  /**
   * When `turn.started` reached this browser, or null if it never did --
   * the frame carries no timestamp of its own, so a turn already running
   * when the page loaded has no start to measure from and the line shows
   * no clock rather than a wrong one.
   */
  startedAt: number | null;
  /** Characters the model has streamed back so far: prose, thinking, and
   * the arguments of every tool call. The basis of the token estimate. */
  chars: number;
  /** The provider is waiting out an API error. Cleared by the next output. */
  retry?: { attempt: number; maxRetries: number };
}

export interface ChatState {
  messages: ChatMessage[];
  /** A turn is in flight, so the composer offers Stop rather than Send. */
  running: boolean;
  /** Null unless a turn is running. */
  active: TurnActivity | null;
  /**
   * Prompts the running turn is blocked on, oldest first. Empty once the
   * turn has ended: a `turn_completed` closes whatever was still open, and a
   * reload must not resurrect a question nobody can answer any more.
   */
  prompts: PermissionPrompt[];
  /**
   * Roughly what the next request's prompt will weigh, or null before any
   * turn has finished.
   *
   * Measured, not estimated: the last completed turn's `prompt_tokens` plus
   * what the model wrote back. The prompt figure already covers the whole
   * conversation to that point -- including the cached prefix, which is why
   * the cache numbers are not added to it -- so this is that conversation
   * plus the reply that has since joined it.
   *
   * Tool results the turn produced are not counted here; they land in the
   * next turn's own prompt, so the number corrects itself one turn later
   * rather than drifting.
   */
  contextTokens: number | null;
}

/**
 * Four characters to a token, from `@ucch/protocol`.
 *
 * Re-exported rather than redefined: the server sizes the same conversation
 * when it decides whether to compact, and a meter that disagreed with that
 * decision would read as a rendering glitch rather than as the drift it is.
 * An estimate is the best that can be done live -- usage arrives once, on
 * `agent.turn_completed`, so anything shown during the turn is counted from
 * what has streamed. Whatever displays it says so.
 */
export { estimateTokens } from "@ucch/protocol";

export function toMessages(
  events: readonly { event: DomainEvent; receivedAt?: number }[],
): ChatState {
  const messages: ChatMessage[] = [];
  const turns = new Map<string, ChatMessage>();
  const activity = new Map<string, TurnActivity>();
  let running = false;
  let activeTurn: string | null = null;
  let contextTokens: number | null = null;
  const prompts = new Map<string, PermissionPrompt>();

  /**
   * The bubble for a turn, created on demand.
   *
   * Not only at `turn.started`: the log is capped at the last 500 events and
   * a subscription can begin mid-turn, so any event of a turn may be the
   * first one seen.
   */
  const turn = (turnId: string): ChatMessage => {
    let message = turns.get(turnId);
    if (!message) {
      message = {
        role: "assistant",
        text: "",
        parts: [],
        reasoning: "",
        streaming: true,
        turnId,
        startedAt: null,
        completedAt: null,
      };
      turns.set(turnId, message);
      messages.push(message);
    }
    return message;
  };

  /** The prose block the current model response is streaming into. */
  const openText = (message: ChatMessage): TextPart => {
    const last = message.parts.at(-1);
    if (last?.kind === "text" && last.streaming) return last;
    const part: TextPart = { kind: "text", text: "", streaming: true };
    message.parts.push(part);
    return part;
  };

  /**
   * Adds to a turn's streamed character count.
   *
   * Tolerates a turn whose `turn.started` was never seen: the log is capped
   * and a subscription can begin mid-turn, in which case the count starts
   * from whatever arrived first rather than being dropped.
   */
  const count = (turnId: string, chars: number): void => {
    const current = activity.get(turnId);
    if (current) {
      current.chars += chars;
      // Output again, so the wait is over.
      delete current.retry;
    } else activity.set(turnId, { turnId, startedAt: null, chars });
  };

  const settle = (message: ChatMessage): void => {
    message.streaming = false;
    for (const part of message.parts) if (part.kind === "text") part.streaming = false;
  };

  for (const row of events) {
    const { event } = row;
    switch (event.type) {
      case "user.message": {
        // The attachment block is for the model; the chat shows the sentence
        // that was typed, and a tag per file.
        const { text, attachments } = parseAttachments(event.text);
        messages.push({
          role: "user",
          text,
          ...(attachments.length ? { attachments } : {}),
          ...(event.mode ? { mode: event.mode } : {}),
          parts: [],
          reasoning: "",
          streaming: false,
          startedAt: row.receivedAt ?? null,
          completedAt: null,
        });
        break;
      }

      case "turn.started":
        // The bubble appears the moment the turn is recorded, so the reader
        // sees the work start rather than a pause with nothing in it.
        turn(event.turnId).startedAt = row.receivedAt ?? null;
        if (event.provider) turn(event.turnId).provider = event.provider;
        running = true;
        activeTurn = event.turnId;
        activity.set(event.turnId, {
          turnId: event.turnId,
          startedAt: row.receivedAt ?? null,
          chars: 0,
        });
        break;

      case "agent.text_delta":
        openText(turn(event.turnId)).text += event.text;
        count(event.turnId, event.text.length);
        break;

      case "agent.thinking_delta":
        turn(event.turnId).reasoning += event.text;
        count(event.turnId, event.text.length);
        break;

      case "agent.message": {
        const message = turn(event.turnId);
        const text = event.content
          .map((block) =>
            typeof block === "object" && block !== null && "type" in block &&
            (block as { type: unknown }).type === "text"
              ? String((block as { text?: unknown }).text ?? "")
              : "",
          )
          .join("");

        // One of these lands per iteration, and it closes that iteration's
        // prose: what follows belongs to the next model response, after the
        // tools have run. Appending instead of replacing is what keeps a
        // two-iteration turn from losing its opening line.
        const last = message.parts.at(-1);
        if (last?.kind === "text" && last.streaming) {
          // Deltas already drew this; the stored message is the authority on
          // what they added up to -- unless it is empty, which means the
          // response was tool calls alone and the streamed text, if any, is
          // all there is.
          if (text) last.text = text;
          last.streaming = false;
          if (!last.text) message.parts.pop();
        } else if (text) {
          message.parts.push({ kind: "text", text, streaming: false });
        }

        // Tool calls also ride in `content`, and are deliberately ignored
        // here: `agent.tool_use` carries the same calls as durable events of
        // their own, and drawing both would double every row.
        break;
      }

      case "agent.tool_use":
        // Arguments the model wrote are output too, and a turn that spends a
        // minute writing one large file would otherwise look idle.
        count(event.turnId, JSON.stringify(event.input ?? "").length);
        turn(event.turnId).parts.push({
          kind: "tool",
          id: event.toolUseId,
          name: event.name,
          input: event.input,
          result: null,
          isError: false,
          durationMs: null,
        });
        break;

      case "agent.permission_requested":
        if (event.toolUseId) {
          const call = turn(event.turnId).parts.find(
            (part): part is ToolPart => part.kind === "tool" && part.id === event.toolUseId,
          );
          if (call) call.awaitingApproval = true;
        }
        prompts.set(event.requestId, {
          requestId: event.requestId,
          turnId: event.turnId,
          toolUseId: event.toolUseId,
          toolName: event.toolName,
          input: event.input,
          description: event.description,
        });
        break;

      case "agent.permission_resolved": {
        const toolUseId = prompts.get(event.requestId)?.toolUseId;
        if (toolUseId) {
          const call = turn(event.turnId).parts.find(
            (part): part is ToolPart => part.kind === "tool" && part.id === toolUseId,
          );
          if (call) delete call.awaitingApproval;
        }
        prompts.delete(event.requestId);
        break;
      }

      case "agent.tool_result": {
        const message = turn(event.turnId);
        const call = message.parts.find(
          (part): part is ToolPart => part.kind === "tool" && part.id === event.toolUseId,
        );
        if (call) {
          call.result = event.content;
          call.isError = event.isError;
          call.durationMs = event.durationMs;
        } else {
          // A result whose call was never seen -- the window slid past it.
          // Better a row with an unknown name than a silently dropped result.
          message.parts.push({
            kind: "tool",
            id: event.toolUseId,
            name: "tool",
            input: null,
            result: event.content,
            isError: event.isError,
            durationMs: event.durationMs,
          });
        }
        break;
      }

      case "agent.turn_completed": {
        const message = turn(event.turnId);
        settle(message);
        message.completedAt = row.receivedAt ?? null;
        message.stopReason = event.stopReason;
        running = false;
        prompts.clear();
        contextTokens = event.usage.inputTokens + event.usage.outputTokens;
        break;
      }

      case "agent.turn_failed": {
        const message = turn(event.turnId);
        settle(message);
        message.completedAt = row.receivedAt ?? null;
        message.error = event.error;
        running = false;
        prompts.clear();
        break;
      }

      case "thread.cancel_requested":
        // Not the end of the turn: the loop is still unwinding, and the
        // `turn_completed` that follows carries `stopReason: "cancelled"`.
        break;

      case "turn.dequeued":
        // The message was sent and no turn ever opened for it: stopped while
        // it waited, refused by the agent, or lost to a restart. A bubble of
        // its own, so the message does not read as still waiting.
        messages.push({
          role: "assistant",
          text: "",
          parts: [],
          reasoning: "",
          streaming: false,
          stopReason: "dequeued",
          startedAt: null,
          completedAt: row.receivedAt ?? null,
        });
        break;

      case "agent.retry": {
        const current = activity.get(event.turnId);
        if (current) current.retry = { attempt: event.attempt, maxRetries: event.maxRetries };
        break;
      }
    }
  }

  return {
    messages,
    running,
    active: running && activeTurn ? (activity.get(activeTurn) ?? null) : null,
    prompts: running ? [...prompts.values()] : [],
    contextTokens,
  };
}

/**
 * The chat with the turns still streaming drawn over it.
 *
 * `base` is `toMessages` over everything settled -- the log, and what
 * finished turns streamed -- and is folded again only when that changes.
 * Each live turn is folded on its own, from its own events and what it has
 * streamed so far, and its message replaces the one in `base`: a bubble is
 * built only from its own turn's events, so this is the message the whole
 * fold would have made. Every other message keeps its identity, so only the
 * streaming one draws again.
 *
 * The turn's activity -- characters streamed, a retry being waited out --
 * comes from the same fold, for the turn the progress line is about.
 */
export function overlayLive(
  base: ChatState,
  live: readonly { turnId: string; rows: readonly { event: DomainEvent; receivedAt?: number }[] }[],
): ChatState {
  if (live.length === 0) return base;
  let messages = base.messages;
  let active = base.active;
  for (const { turnId, rows } of live) {
    const folded = toMessages(rows);
    const message = folded.messages.find((m) => m.turnId === turnId);
    if (!message) continue;
    const at = messages.findIndex((m) => m.turnId === turnId);
    messages = at >= 0 ? [...messages.slice(0, at), message, ...messages.slice(at + 1)] : [...messages, message];
    if (base.active?.turnId === turnId && folded.active) active = folded.active;
  }
  return { ...base, messages, active };
}

/**
 * How a turn ended, when that is worth saying.
 *
 * "cancelled" and "max_iterations" arrive as `turn_completed` rather than
 * `turn_failed` -- neither is a failure, and neither should be dressed as
 * one -- but both leave an answer that stops early, and a reader who is not
 * told why will read it as the model losing interest.
 */
export function describeStop(stopReason: string | null | undefined): string | null {
  if (stopReason === "cancelled") return "Stopped at your request.";
  // A `turn.dequeued`: there is no answer at all, early or otherwise.
  if (stopReason === "dequeued") return "Stopped before it started.";
  if (stopReason === "max_iterations") {
    return "Stopped after reaching the maximum number of steps for one turn.";
  }
  if (stopReason === "length") return "Stopped at the model's output limit.";
  return null;
}

/** A one-line gloss of a call's arguments, for the collapsed row. */
export function summariseInput(input: unknown): string {
  if (typeof input === "string") return truncate(input);
  if (typeof input !== "object" || input === null) return "";

  const record = input as Record<string, unknown>;
  // The argument a reader wants to see first, by name, before falling back to
  // whatever the tool happens to call it.
  for (const key of ["path", "command", "pattern", "query", "url", "host", "old_string"]) {
    const value = record[key];
    if (typeof value === "string" && value) return truncate(value);
  }
  for (const value of Object.values(record)) {
    if (typeof value === "string" && value) return truncate(value);
  }
  return "";
}

export function formatDuration(ms: number | null): string | null {
  if (ms === null) return null;
  if (ms < 1000) return `${ms}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}

function truncate(value: string, max = 80): string {
  const flat = value.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** A slice of a text part: what the model thought, or what it said. */
export interface TextSegment {
  kind: "think" | "answer";
  text: string;
}

/**
 * Splits prose at the `<think>` tags some models write inline.
 *
 * A model served through OpenRouter without native reasoning support puts
 * its thinking in the text itself, fenced as `<think>…</think>`. A `<think>`
 * runs to its `</think>` when there is one.
 *
 * Often there is not. Some providers strip the closing tag -- and the
 * whitespace around it -- on the way out, so what is stored reads
 * "…a concise but thorough answer.This is **BrainPanel** — a…": the thought
 * and the answer glued at a full stop with no space after it, which is
 * something prose never contains otherwise. That seam is the only delimiter
 * left, so an unclosed block ends at the first sentence end followed
 * directly by a capital letter or Markdown opener; with no seam at all it
 * runs to the end of the part. While the part streams that is exactly right,
 * and once settled the reader can still open the dropdown to read whatever
 * stayed folded. A part with no tag at all is one answer segment, whitespace
 * and all.
 *
 * Case-insensitive, and tolerant of a space inside the tag, because the tags
 * are model output rather than markup anyone validated.
 */
export function splitThinking(text: string): TextSegment[] {
  const segments: TextSegment[] = [];
  const open = /<\s*think\s*>/gi;
  const close = /<\s*\/\s*think\s*>/gi;
  let cursor = 0;

  for (;;) {
    open.lastIndex = cursor;
    const start = open.exec(text);
    if (!start) break;

    if (start.index > cursor) segments.push({ kind: "answer", text: text.slice(cursor, start.index) });

    const from = start.index + start[0].length;
    close.lastIndex = from;
    const end = close.exec(text);
    let thoughtEnd: number;
    let next: number;
    if (end) {
      thoughtEnd = end.index;
      next = end.index + end[0].length;
    } else {
      const seam = findSeam(text, from);
      thoughtEnd = next = seam ?? text.length;
    }
    const thought = text.slice(from, thoughtEnd);
    if (thought.trim()) segments.push({ kind: "think", text: thought });
    cursor = next;
  }

  if (cursor < text.length) segments.push({ kind: "answer", text: text.slice(cursor) });
  // Only whitespace separated two thoughts, or the tag closed on nothing:
  // there is no answer in that, and drawing it would leave an empty bubble.
  return segments.filter((s) => s.kind === "think" || s.text.trim() || segments.length === 1);
}

/**
 * Where a stripped `</think>` used to be: the index just after the first
 * sentence end that a capital letter, a heading, bold, a list or code
 * follows with nothing in between. Null when the text has no such seam.
 */
function findSeam(text: string, from: number): number | null {
  const seam = /[.!?](?=[A-Z#*`\-])/g;
  seam.lastIndex = from;
  const match = seam.exec(text);
  return match ? match.index + 1 : null;
}

/**
 * A turn's cooking time and finish, for the line under its answer.
 *
 * "Cooked for 8m 49s · done 6:42 PM". Either half is dropped when the event
 * behind it was not seen, and the whole line when neither was.
 */
export function describeTiming(
  message: Pick<ChatMessage, "startedAt" | "completedAt">,
  locale?: string,
): string | null {
  const { startedAt, completedAt } = message;
  const parts: string[] = [];
  if (startedAt !== null && completedAt !== null && completedAt >= startedAt) {
    parts.push(`Cooked for ${formatCookTime(completedAt - startedAt)}`);
  }
  if (completedAt !== null) {
    const time = new Date(completedAt).toLocaleTimeString(locale, {
      hour: "numeric",
      minute: "2-digit",
    });
    parts.push(`done ${time}`);
  }
  return parts.length ? parts.join(" · ") : null;
}

/**
 * When a prompt was sent, for the line under it: "6:42 PM" today, and with
 * the date once it is not -- a conversation picked up next week should say
 * so. Null when the event carried no time. `now` is injectable for tests.
 */
export function describeSent(
  sentAt: number | null,
  locale?: string,
  now: Date = new Date(),
): string | null {
  if (sentAt === null) return null;
  const at = new Date(sentAt);
  const time = at.toLocaleTimeString(locale, { hour: "numeric", minute: "2-digit" });
  const sameDay =
    at.getFullYear() === now.getFullYear() &&
    at.getMonth() === now.getMonth() &&
    at.getDate() === now.getDate();
  if (sameDay) return time;
  const date = at.toLocaleDateString(locale, {
    month: "short",
    day: "numeric",
    ...(at.getFullYear() === now.getFullYear() ? {} : { year: "numeric" }),
  });
  return `${date}, ${time}`;
}

/** `8m 49s`, `49s`, `1h 2m` -- whole units, largest two. */
export function formatCookTime(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${s}s`;
  return `${s}s`;
}
