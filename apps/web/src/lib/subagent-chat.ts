import type { DomainEvent } from "@ucch/protocol";
import type { ChatMessage, ToolPart } from "./chat-messages";

type Row = { event: DomainEvent; receivedAt?: number };

/** A worker's conversation, reconstructed entirely from shared durable events. */
export function subagentConversation(rows: readonly Row[], id: string): ChatMessage[] {
  const messages: ChatMessage[] = [];
  const tools = new Map<string, ToolPart>();
  let answer: ChatMessage | null = null;
  let pending = false;
  let deliveryTurn: string | undefined;
  const assistant = (at?: number) => answer ??= (() => {
    const message: ChatMessage = { role: "assistant", text: "", parts: [], reasoning: "", streaming: true, startedAt: at ?? null, completedAt: null };
    messages.push(message);
    return message;
  })();
  for (const { event, receivedAt } of rows) {
    if (event.type === "user.message" && event.subagentId === id) {
      messages.push({ role: "user", text: event.text, parts: [], reasoning: "", streaming: false, startedAt: receivedAt ?? null, completedAt: null });
      answer = null;
      pending = true;
      deliveryTurn = undefined;
    } else if (event.type === "turn.started" && pending) {
      deliveryTurn = event.turnId;
    } else if (event.type === "agent.subagent_started" && event.subagentId === id) {
      if ((answer as ChatMessage | null)?.parts.length) answer = null;
      const message = assistant(receivedAt);
      message.streaming = true;
      message.provider = event.provider;
    } else if (event.type === "agent.subagent_output" && event.subagentId === id) {
      assistant(receivedAt).parts.push({ kind: "text", text: event.kind === "thinking" ? `<think>${event.text}</think>` : event.text, streaming: false });
    } else if (event.type === "agent.tool_use" && event.subagentId === id) {
      const tool: ToolPart = { kind: "tool", id: event.toolUseId, name: event.name, input: event.input, result: null, isError: false, durationMs: null };
      assistant(receivedAt).parts.push(tool);
      tools.set(tool.id, tool);
    } else if (event.type === "agent.tool_result") {
      const tool = tools.get(event.toolUseId);
      if (tool) { tool.result = event.content; tool.isError = event.isError; tool.durationMs = event.durationMs; }
    } else if (event.type === "agent.subagent_finished" && event.subagentId === id) {
      const message = assistant(receivedAt);
      message.streaming = false;
      message.completedAt = receivedAt ?? null;
      if (event.result && !message.parts.some(part => part.kind === "text" && part.text === event.result)) message.parts.push({ kind: "text", text: event.result, streaming: false });
      if (event.status === "failed") message.error = event.result ?? "The subagent failed.";
      if (event.status === "aborted") message.stopReason = "cancelled";
      pending = false;
    } else if ((event.type === "agent.turn_failed" || event.type === "agent.turn_completed") && pending && event.turnId === deliveryTurn) {
      const message = assistant(receivedAt);
      message.streaming = false;
      message.completedAt = receivedAt ?? null;
      message.error = event.type === "agent.turn_failed" ? event.error : "The run ended without a final response from this subagent. You can retry your message.";
      pending = false;
    }
  }
  return messages;
}

/** Actual parent request for older/encrypted delegations; never guessed task text. */
export function subagentParentRequest(messages: readonly ChatMessage[], callId: string): string | null {
  let request: string | null = null;
  for (const message of messages) {
    if (message.role === "user") request = message.text;
    if (message.parts.some(part => part.kind === "tool" && part.id === callId)) return request;
  }
  return null;
}
