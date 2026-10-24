#!/usr/bin/env node
/**
 * A stand-in for OpenRouter, for load tests: the server's native agent loop
 * streams from it exactly as it would from the real thing, at a rate you
 * choose, and nobody is billed.
 *
 *   node scripts/load/mock-openrouter.mjs [--port 4010] [--rate 60]
 *        [--chunk 1] [--length 1500] [--latency 300] [--host 127.0.0.1]
 *
 * Point the server at it with OPENROUTER_BASE_URL=http://<host>:<port>/api/v1
 * (the `/api/v1` is optional; every route answers with or without it).
 *
 *   POST /chat/completions   SSE. After --latency ms, --length tokens in
 *                            events of --chunk tokens each, at --rate tokens
 *                            a second, then a usage chunk and [DONE]. Every
 *                            answer is text: the loop runs one iteration.
 *   GET  /models             the catalogue `contextLengthFor` and
 *                            `supportsImages` read
 *   GET  /auth/key, /credits what the account page's quota card reads
 *   GET  /stats              requests and tokens served, as JSON
 *
 * A request can override the stream with headers -- x-mock-rate,
 * x-mock-chunk, x-mock-length -- which is how one run mixes answer sizes.
 * A client that disconnects stops its stream at once.
 */
import { createServer } from "node:http";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: {
    port: { type: "string", default: process.env.MOCK_OPENROUTER_PORT ?? "4010" },
    host: { type: "string", default: "127.0.0.1" },
    rate: { type: "string", default: "60" },
    chunk: { type: "string", default: "1" },
    length: { type: "string", default: "1500" },
    latency: { type: "string", default: "300" },
  },
});

const positive = (value, name) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} must be a positive number, not ${value}`);
  return n;
};
const defaults = {
  rate: positive(args.rate, "rate"),
  chunk: Math.max(1, Math.round(positive(args.chunk, "chunk"))),
  length: Math.max(1, Math.round(positive(args.length, "length"))),
  latency: Math.max(0, Number(args.latency) || 0),
};

/** Models the harness asks about: its defaults, plus a vision one. */
const MODELS = [
  { id: "anthropic/claude-sonnet-4.5", name: "Claude Sonnet 4.5", context_length: 200000, image: true, reasoning: true },
  { id: "google/gemini-2.5-flash", name: "Gemini 2.5 Flash", context_length: 1048576, image: true, reasoning: true },
  { id: "openai/gpt-4o-mini", name: "GPT-4o mini", context_length: 128000, image: true, reasoning: false },
  { id: "perplexity/sonar", name: "Sonar", context_length: 127000, image: false, reasoning: false },
  { id: "mock/text", name: "Mock text", context_length: 32000, image: false, reasoning: false },
].map((m) => ({
  id: m.id,
  name: m.name,
  context_length: m.context_length,
  supported_parameters: m.reasoning ? ["tools", "reasoning"] : ["tools"],
  architecture: { input_modalities: m.image ? ["text", "image"] : ["text"] },
  pricing: { prompt: "0", completion: "0" },
}));

const WORDS = (
  "the harness streams this answer one token at a time so a load test can see what fifty people " +
  "watching agents work costs the server and the browser alike while nothing is billed anywhere"
).split(" ");

const stats = { requests: 0, completions: 0, active: 0, tokens: 0, aborted: 0 };

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function header(req, name, fallback) {
  const value = Number(req.headers[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text || "{}");
  } catch {
    return {};
  }
}

async function complete(req, res) {
  const body = await readBody(req);
  const rate = header(req, "x-mock-rate", defaults.rate);
  const chunk = Math.round(header(req, "x-mock-chunk", defaults.chunk));
  const length = Math.round(header(req, "x-mock-length", defaults.length));
  const model = typeof body.model === "string" ? body.model : "mock/text";
  const id = `gen-mock-${Date.now()}-${stats.completions}`;
  const created = Math.floor(Date.now() / 1000);
  stats.completions++;
  stats.active++;

  let closed = false;
  res.on("close", () => {
    if (!res.writableFinished) {
      closed = true;
      stats.aborted++;
    }
  });

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-cache",
    connection: "keep-alive",
  });
  // OpenRouter's keepalive comment; the client must skip it.
  res.write(": OPENROUTER PROCESSING\n\n");
  const event = (payload) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, ...payload })}\n\n`);
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  try {
    await sleep(defaults.latency);
    const interval = (1000 * chunk) / rate;
    const started = performance.now();
    let sent = 0;
    while (sent < length && !closed) {
      const n = Math.min(chunk, length - sent);
      let text = "";
      for (let i = 0; i < n; i++) {
        const index = sent + i;
        text += (index > 0 && index % 80 === 0 ? "\n\n" : index > 0 ? " " : "") + WORDS[index % WORDS.length];
      }
      event({ choices: [{ index: 0, delta: { role: "assistant", content: text }, finish_reason: null }] });
      sent += n;
      stats.tokens += n;
      // Paced against the start, not the last write, so a slow tick does
      // not lower the rate for the rest of the answer.
      const due = started + (sent / chunk) * interval;
      const wait = due - performance.now();
      if (wait > 0) await sleep(wait);
    }
    if (closed) return;
    event({ choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
    event({
      choices: [],
      usage: { prompt_tokens: 1000, completion_tokens: length, total_tokens: 1000 + length, cost: 0 },
    });
    res.end("data: [DONE]\n\n");
  } finally {
    stats.active--;
  }
}

const server = createServer((req, res) => {
  stats.requests++;
  const path = (req.url ?? "/").split("?")[0].replace(/^\/api\/v1(?=\/)/, "");
  if (req.method === "POST" && path === "/chat/completions") {
    complete(req, res).catch((error) => {
      if (!res.headersSent) json(res, 500, { error: { message: String(error) } });
      else res.destroy();
    });
    return;
  }
  if (req.method === "GET" && path === "/models") return json(res, 200, { data: MODELS });
  if (req.method === "GET" && path === "/auth/key") {
    return json(res, 200, {
      data: { label: "mock", usage: 0, limit: null, limit_remaining: null, is_free_tier: false },
    });
  }
  if (req.method === "GET" && path === "/credits") return json(res, 200, { data: { total_credits: 100, total_usage: 0 } });
  if (req.method === "GET" && path === "/stats") return json(res, 200, stats);
  json(res, 404, { error: { message: `mock-openrouter: no route for ${req.method} ${path}` } });
});

server.listen(Number(args.port), args.host, () => {
  const { port } = server.address();
  console.log(
    `mock-openrouter on http://${args.host}:${port}/api/v1 -- ${defaults.length} tokens at ${defaults.rate}/s, ${defaults.chunk} per event`,
  );
});

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => {
    // Open streams would hold `close` for as long as they run.
    server.closeAllConnections();
    server.close(() => process.exit(0));
  });
}
