#!/usr/bin/env node
/**
 * Records OMP RPC transcripts as provider fixtures (todo OM0.2).
 *
 * Each scenario in scenarios.mjs runs real `omp --mode rpc-ui` against the
 * scripted model (scripted-model.mjs) in a throwaway HOME, so nothing of the
 * operator's own `~/.omp` is read or written. Every line in either direction
 * is written to `packages/providers/src/fixtures/omp-<name>.jsonl` as
 * `{"dir":"in"|"out","frame":{...}}`. Paths under the throwaway directories
 * become `<home>` / `<cwd>`, so a fixture is the same on every machine.
 *
 *   node scripts/omp/record-rpc.mjs [--only name] [--omp path]
 *   node scripts/omp/record-rpc.mjs --check     re-parse every fixture
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { scenarios } from "./scenarios.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..", "..");
const fixtures = join(root, "packages", "providers", "src", "fixtures");

const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : (argv[i + 1] ?? "");
};

if (argv.includes("--check")) {
  let bad = 0;
  for (const file of readdirSync(fixtures).filter((f) => /^omp-.*\.jsonl$/.test(f))) {
    const lines = readFileSync(join(fixtures, file), "utf8").split("\n").filter(Boolean);
    let terminal = false;
    for (const [n, line] of lines.entries()) {
      try {
        const { dir, frame } = JSON.parse(line);
        if (dir !== "in" && dir !== "out") throw new Error("dir");
        if (dir === "out" && frame.type === "agent_end" && frame.isTerminal !== false) terminal = true;
        if (dir === "out" && frame.type === "response" && frame.success === false) terminal = true;
      } catch (err) {
        console.error(`${file}:${n + 1}: ${err.message}`);
        bad++;
      }
    }
    if (!terminal) {
      console.error(`${file}: no terminal agent_end or failed response`);
      bad++;
    }
    console.log(`${file}: ${lines.length} lines`);
  }
  process.exit(bad ? 1 : 0);
}

const ompBin = flag("omp") ?? "omp";
const only = flag("only");
// OMP unpacks ~120 MB of native modules under $HOME/.omp/natives on first
// start. One shared directory, or every throwaway HOME fills /tmp.
const NATIVES = join(tmpdir(), "omp-natives");

function startModel(script, log) {
  const scriptPath = join(log, "..", "script.json");
  writeFileSync(scriptPath, JSON.stringify(script));
  const child = spawn(process.execPath, [join(here, "scripted-model.mjs"), "--port", "0", "--script", scriptPath, "--log", log], {
    stdio: ["ignore", "pipe", "inherit"],
  });
  return new Promise((resolve, reject) => {
    child.stdout.once("data", (d) => {
      const m = /listening (\d+)/.exec(String(d));
      if (m) resolve({ child, port: Number(m[1]) });
      else reject(new Error(`model: ${d}`));
    });
    child.once("exit", (code) => reject(new Error(`model exited ${code}`)));
  });
}

function redact(text, dirs) {
  let out = text;
  for (const [path, name] of dirs) out = out.split(path).join(name);
  // OMP names a project's session directory after its path, `/` -> `-`.
  for (const [path, name] of dirs) out = out.split(path.replaceAll("/", "-")).join(`-${name}`);
  return out
    .replace(/127\.0\.0\.1:\d+/g, "127.0.0.1:<port>")
    .replace(/(sk-[A-Za-z0-9_-]{8,})/g, "<redacted>");
}

async function record(scenario) {
  const base = mkdtempSync(join(tmpdir(), `omp-rec-${scenario.name}-`));
  const home = join(base, "home");
  const cwd = join(base, "cwd");
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  mkdirSync(cwd, { recursive: true });
  for (const [rel, content] of Object.entries(scenario.files ?? {})) {
    mkdirSync(dirname(join(cwd, rel)), { recursive: true });
    writeFileSync(join(cwd, rel), content);
  }
  const model = await startModel(scenario.script ?? [], join(base, "requests.jsonl"));
  writeFileSync(
    join(home, ".omp", "agent", "models.yml"),
    [
      "providers:",
      "  scripted:",
      `    baseUrl: http://127.0.0.1:${model.port}/v1`,
      "    api: openai-completions",
      "    auth: none",
      "    models:",
      "      - id: scripted",
      `        contextWindow: ${scenario.contextWindow ?? 128000}`,
      "        maxTokens: 4096",
      "",
    ].join("\n"),
  );
  writeFileSync(join(home, ".omp", "agent", "config.yml"), scenario.config ?? "");

  const env = {
    PATH: process.env.PATH,
    HOME: home,
    OMP_SKIP_SETUP: "1",
    TERM: "dumb",
    CI: "1",
    PI_NATIVES_DIR: NATIVES,
    ...(scenario.env ?? {}),
  };
  const args = ["--mode", scenario.mode ?? "rpc-ui", "--no-title", "--model", "scripted/scripted", ...(scenario.args ?? [])];
  const omp = spawn(ompBin, args, { cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  const dirs = [
    [base, "<base>"],
    [home, "<home>"],
    [cwd, "<cwd>"],
  ].sort((a, b) => b[0].length - a[0].length);
  const lines = [];
  const stderr = [];
  omp.stderr.on("data", (d) => stderr.push(String(d)));
  const waiters = [];
  const seen = [];
  const out = createInterface({ input: omp.stdout });
  out.on("line", (line) => {
    if (!line.trim()) return;
    let frame;
    try {
      frame = JSON.parse(line);
    } catch {
      frame = { type: "__unparsed", line };
    }
    lines.push(redact(JSON.stringify({ dir: "out", frame }), dirs));
    // A frame a live waiter takes is consumed; only unclaimed frames stay in
    // `seen` for a later waitFor, so one turn's agent_end never ends the next.
    const w = waiters.find((candidate) => candidate.test(frame));
    if (w) {
      waiters.splice(waiters.indexOf(w), 1);
      w.resolve(frame);
    } else {
      seen.push(frame);
    }
    if (scenario.onFrame) {
      const reply = scenario.onFrame(frame);
      if (reply) send(reply);
    }
  });
  const exited = new Promise((resolve) => omp.once("exit", (code, signal) => resolve({ code, signal })));

  function send(frame) {
    lines.push(redact(JSON.stringify({ dir: "in", frame }), dirs));
    omp.stdin.write(`${JSON.stringify(frame)}\n`);
  }
  function waitFor(test, ms = 30000, label = "") {
    const hit = seen.find(test);
    if (hit) {
      seen.splice(seen.indexOf(hit), 1);
      return Promise.resolve(hit);
    }
    return new Promise((resolve, reject) => {
      const w = { test, resolve };
      waiters.push(w);
      setTimeout(() => reject(new Error(`timeout waiting for ${label}\n${stderr.join("").slice(-2000)}`)), ms);
    });
  }
  const ctx = { send, waitFor, cwd, home, seen };
  let error;
  try {
    await waitFor((f) => f.type === "ready", 30000, "ready");
    await scenario.run(ctx);
  } catch (err) {
    error = err;
  }
  omp.stdin.end();
  const timer = setTimeout(() => omp.kill("SIGKILL"), 10000);
  const status = await exited;
  clearTimeout(timer);
  model.child.kill();
  writeFileSync(join(fixtures, `omp-${scenario.name}.jsonl`), `${lines.join("\n")}\n`);
  // What OMP sent the model: not a fixture, but how a scenario is debugged.
  if (process.env.REQUESTS_DIR) {
    writeFileSync(join(process.env.REQUESTS_DIR, `${scenario.name}.requests.jsonl`), redact(safeRead(join(base, "requests.jsonl")), dirs));
  }
  if (!process.env.KEEP) rmSync(base, { recursive: true, force: true });
  console.log(`${scenario.name}: ${lines.length} lines, exit ${status.code ?? status.signal}${error ? `, ERROR ${error.message}` : ""}`);
  return !error;
}

function safeRead(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

let ok = true;
for (const scenario of scenarios) {
  if (only && scenario.name !== only) continue;
  ok = (await record(scenario)) && ok;
}
process.exit(ok ? 0 : 1);
