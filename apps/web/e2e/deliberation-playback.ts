import type { Page, WebSocketRoute } from "@playwright/test";
import { isTransient, type DomainEvent } from "../../../packages/protocol/src/index";

/**
 * The Reviewer and Council specs' socket (plan4 §4.5): the app, auth and
 * navigation are real; only the test thread's subscription is played back,
 * from events the spec writes, and the commands its cards send are caught
 * here and answered with an ack, so no model runs. A reload subscribes
 * again and is replayed the whole log, as the server would.
 */
export async function deliberationPlayback(page: Page, threadId: string) {
  const history: { seq: number; at: string; event: DomainEvent }[] = [];
  const dispatched: any[] = [];
  let connection: WebSocketRoute | undefined;
  let subscription = "";
  let subscriptions = 0;
  const CAUGHT = new Set(["thread.send", "thread.peer_review", "thread.peer_review_fix", "thread.deliberation_cancel"]);
  await page.routeWebSocket(/\/ws\?/, (socket) => {
    const server = socket.connectToServer();
    socket.onMessage((data) => {
      const frame = JSON.parse(String(data));
      if (frame.kind === "subscribe" && frame.topic.name === "thread" && frame.topic.threadId === threadId) {
        connection = socket;
        subscription = frame.id;
        subscriptions++;
        socket.send(JSON.stringify({ kind: "replay", subscriptionId: frame.id, events: history.filter((row) => row.seq > (frame.sinceSeq ?? -1)), done: true }));
        socket.send(JSON.stringify({ kind: "ack", id: frame.id, events: [] }));
      } else if (frame.kind === "dispatch" && CAUGHT.has(frame.command.type) && frame.command.threadId === threadId) {
        dispatched.push(frame.command);
        socket.send(JSON.stringify({ kind: "ack", id: frame.id, events: [] }));
      } else server.send(data);
    });
  });
  const publish = (events: DomainEvent[]) => {
    for (const event of events) {
      const at = new Date().toISOString();
      const seq = isTransient(event.type) ? null : history.length;
      if (seq !== null) history.push({ seq, at, event });
      connection?.send(JSON.stringify({ kind: "push", subscriptionId: subscription, seq, at, event }));
    }
  };
  return { publish, dispatched, subscriptions: () => subscriptions };
}

export const ZERO = { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0 };
