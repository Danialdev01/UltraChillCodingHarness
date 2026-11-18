import type { DomainEvent } from "@ucch/protocol";

/** One turn of a thread, as text: what was asked, and what came back. */
export interface Exchange {
  prompt: string;
  reply: string;
}

/**
 * A thread's conversation, from its event log: each `user.message` and the
 * text blocks of the `agent.message`s that answered it. Tool calls,
 * thinking and context are left out; this is the conversation a person read.
 */
export function exchangesOf(history: readonly { event: DomainEvent }[]): Exchange[] {
  const exchanges: { prompt: string; reply: string[] }[] = [];
  for (const { event } of history) {
    if (event.type === "user.message") exchanges.push({ prompt: event.text, reply: [] });
    else if (event.type === "agent.message") {
      const text = (event.content as { type?: unknown; text?: unknown }[])
        .filter((block) => block?.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("\n")
        .trim();
      if (!text) continue;
      if (exchanges.length === 0) exchanges.push({ prompt: "", reply: [] });
      exchanges.at(-1)!.reply.push(text);
    }
  }
  return exchanges.map(({ prompt, reply }) => ({ prompt, reply: reply.join("\n\n") }));
}

/**
 * The last `count` exchanges, newest kept whole first, within `maxChars`
 * altogether: an older one that does not fit is cut from its start, and
 * those before it are dropped.
 */
export function recentExchanges(exchanges: readonly Exchange[], count: number, maxChars: number): Exchange[] {
  let budget = maxChars;
  const take = (text: string) => {
    const kept = text.length > budget ? (budget > 0 ? `…${text.slice(text.length - budget)}` : "") : text;
    budget = Math.max(0, budget - kept.length);
    return kept;
  };
  const kept: Exchange[] = [];
  for (const exchange of exchanges.slice(-count).reverse()) {
    if (budget === 0) break;
    const reply = take(exchange.reply);
    const prompt = take(exchange.prompt);
    kept.push({ prompt, reply });
  }
  return kept.reverse();
}

/**
 * A recap of a conversation for a model that has not seen it: a fresh CLI
 * session continuing a thread whose own session is gone.
 */
export function conversationRecap(exchanges: readonly Exchange[], maxChars = 60_000): string | null {
  const recent = recentExchanges(exchanges, exchanges.length, maxChars);
  if (recent.length === 0) return null;
  const lines = [
    "This conversation started in an earlier session that is no longer available. Here is what was said, oldest first; carry on from it. Files it changed are already in the project.",
  ];
  const skipped = exchanges.length - recent.length;
  if (skipped > 0) lines.push(`(${skipped} earlier ${skipped === 1 ? "exchange is" : "exchanges are"} left out.)`);
  for (const { prompt, reply } of recent) {
    if (prompt) lines.push("", "User:", prompt);
    if (reply) lines.push("", "Assistant:", reply);
  }
  return lines.join("\n");
}
