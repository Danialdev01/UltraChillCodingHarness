#!/usr/bin/env node
/**
 * A scripted OpenAI Chat Completions server for recording OMP fixtures.
 *
 * OMP is real; only the model is fake. Pointing a custom `openai-completions`
 * provider at this server (see record-rpc.mjs) makes every RPC frame OMP
 * writes genuine while the model's side -- which text, which tool call --
 * is fixed by a script, so a fixture re-records identically on every OMP
 * version bump and costs nothing.
 *
 * A script is a JSON array of replies, consumed in order by requests that
 * carry tools (the agent's own turns, and OMP's handoff brief, which is asked
 * for with the tools still attached). Requests without tools are OMP's other
 * side calls (titles, compaction summaries) and get `sideReply`.
 *
 *   { "text": "..." }                                  a plain answer
 *   { "toolCalls": [{ "name": "read", "arguments": { ... } }] }
 *   { "text": "...", "toolCalls": [...] }              both
 *   { "when": "substring", ...reply }                  only once some message contains it
 *   { "httpError": 400, "message": "..." }             an API error instead of a reply
 *   { "delayMs": 3000, ...reply }                      answer only after a pause
 *
 * Usage: node scripted-model.mjs --port 0 --script s.json --log requests.jsonl
 * Prints `listening <port>` on stdout once bound.
 */
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) args.set(process.argv[i].replace(/^--/, ""), process.argv[i + 1]);

const script = args.has("script") ? JSON.parse(readFileSync(args.get("script"), "utf8")) : [];
const sideReply = args.get("side-reply") ?? "Summary: the session so far.";
const logPath = args.get("log");
let next = 0;
let toolCallSeq = 0;

function textOf(message) {
  if (typeof message.content === "string") return message.content;
  if (Array.isArray(message.content)) return message.content.map((p) => p.text ?? "").join("");
  return "";
}

function pick(body) {
  const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
  if (!hasTools) return { text: sideReply };
  const haystack = (body.messages ?? []).map(textOf).join("\n");
  while (next < script.length) {
    const reply = script[next];
    if (reply.when && !haystack.includes(reply.when)) return { text: "(waiting)" };
    next++;
    return reply;
  }
  return { text: "Done." };
}

function chunk(res, model, delta, finish = null) {
  const frame = {
    id: "chatcmpl-scripted",
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finish }],
  };
  res.write(`data: ${JSON.stringify(frame)}\n\n`);
}

const server = createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", () => {
    if (req.method === "GET" && req.url?.endsWith("/models")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ data: [{ id: "scripted", object: "model" }] }));
      return;
    }
    let body = {};
    try {
      body = JSON.parse(raw || "{}");
    } catch {
      res.writeHead(400).end();
      return;
    }
    const reply = pick(body);
    setTimeout(() => respond(req, res, body, reply), reply.delayMs ?? 0);
  });
});

function respond(req, res, body, reply) {
  if (reply.httpError) {
    if (logPath) appendFileSync(logPath, `${JSON.stringify({ url: req.url, reply })}\n`);
    res.writeHead(reply.httpError, { "content-type": "application/json" });
    res.end(JSON.stringify({ error: { message: reply.message ?? "scripted error", type: "invalid_request_error" } }));
    return;
  }
  if (logPath) {
    appendFileSync(
      logPath,
      `${JSON.stringify({
        url: req.url,
        stream: body.stream,
        tools: (body.tools ?? []).map((t) => t.function?.name ?? t.name),
        schemas: process.env.LOG_SCHEMAS ? body.tools : undefined,
        // Cut for readable logs; LOG_FULL keeps the whole system prompt, which
        // is where a probe looks for what OMP loaded.
        messages: (body.messages ?? []).map((m) => ({
          role: m.role,
          text: process.env.LOG_FULL ? textOf(m) : textOf(m).slice(0, 4000),
          tool_calls: m.tool_calls,
        })),
        reply,
      })}\n`,
    );
  }
  const model = body.model ?? "scripted";
  const usage = { prompt_tokens: 100, completion_tokens: 10, total_tokens: 110 };
  if (body.stream === false) {
    const message = { role: "assistant", content: reply.text ?? null };
    if (reply.toolCalls) {
      message.tool_calls = reply.toolCalls.map((c) => ({
        id: `call_${++toolCallSeq}`,
        type: "function",
        function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) },
      }));
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(
      JSON.stringify({
        id: "chatcmpl-scripted",
        object: "chat.completion",
        model,
        choices: [{ index: 0, message, finish_reason: reply.toolCalls ? "tool_calls" : "stop" }],
        usage,
      }),
    );
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  chunk(res, model, { role: "assistant" });
  if (reply.text) for (const piece of reply.text.match(/.{1,12}/gs) ?? []) chunk(res, model, { content: piece });
  (reply.toolCalls ?? []).forEach((c, index) => {
    chunk(res, model, {
      tool_calls: [
        { index, id: `call_${++toolCallSeq}`, type: "function", function: { name: c.name, arguments: JSON.stringify(c.arguments ?? {}) } },
      ],
    });
  });
  chunk(res, model, {}, reply.toolCalls ? "tool_calls" : "stop");
  res.write(`data: ${JSON.stringify({ id: "chatcmpl-scripted", object: "chat.completion.chunk", created: 0, model, choices: [], usage })}\n\n`);
  res.end("data: [DONE]\n\n");
}

server.listen(Number(args.get("port") ?? 0), "127.0.0.1", () => {
  process.stdout.write(`listening ${server.address().port}\n`);
});
