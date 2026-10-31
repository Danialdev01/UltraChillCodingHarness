#!/usr/bin/env node
/**
 * How much memory an OMP process holds, and how long it takes to start
 * (todo OM0.6, solution §13).
 *
 * Real `omp --mode rpc` against the scripted model, so the numbers are OMP's
 * own and cost nothing. Four cases, each run N times:
 *
 *   idle     ready, then nothing
 *   busy     one turn that reads 20 files of this repository
 *   scouts   one turn with 4 scout subagents running at once
 *   lsp      a diagnostics call that starts typescript-language-server on
 *            this repository (needs it on PATH, or --lsp-bin <dir>)
 *
 * The language servers left behind once omp exits ("daemon" in the report)
 * are sampled after every case, with how long they linger.
 *
 * RSS and PSS are summed over the omp process and everything under it, read
 * from /proc every 100 ms; the peak is reported. PSS splits shared pages
 * between the processes that map them, so it is the fairer figure for many
 * copies of one binary. Language servers OMP hands to its daemon broker are
 * not omp's children; they are found by name and reported separately.
 *
 *   node scripts/omp/measure-rss.mjs [--runs 5] [--out file.json] [--lsp-bin dir]
 */
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";

const here = dirname(fileURLToPath(import.meta.url));
const repo = join(here, "..", "..");
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const RUNS = Number(flag("runs") ?? 5);
const NATIVES = join(tmpdir(), "omp-natives");
const LSP_NAMES = /typescript-language-server|tsserver|typingsInstaller/;

function proc() {
  const all = new Map();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
      const cmd = readFileSync(`/proc/${name}/cmdline`, "utf8").replaceAll("\0", " ");
      all.set(Number(name), { ppid, cmd });
    } catch {
      /* gone */
    }
  }
  return all;
}

function memoryOf(pid) {
  try {
    const rollup = readFileSync(`/proc/${pid}/smaps_rollup`, "utf8");
    const kb = (key) => Number(new RegExp(`^${key}:\\s+(\\d+)`, "m").exec(rollup)?.[1] ?? 0);
    return { rss: kb("Rss"), pss: kb("Pss") };
  } catch {
    return { rss: 0, pss: 0 };
  }
}

function descendants(root, all) {
  const out = [root];
  for (let i = 0; i < out.length; i++) for (const [pid, p] of all) if (p.ppid === out[i]) out.push(pid);
  return out;
}

/** Memory of omp's tree, and of language servers anywhere, in MB. */
function sample(rootPid) {
  const all = proc();
  const tree = new Set(rootPid ? descendants(rootPid, all) : []);
  const lsp = [...all].filter(([pid, p]) => LSP_NAMES.test(p.cmd) && !tree.has(pid)).map(([pid]) => pid);
  const sum = (pids) =>
    pids.map(memoryOf).reduce((a, m) => ({ rss: a.rss + m.rss, pss: a.pss + m.pss }), { rss: 0, pss: 0 });
  const mb = (m) => ({ rss: Math.round(m.rss / 1024), pss: Math.round(m.pss / 1024) });
  const treeLsp = [...tree].filter((pid) => LSP_NAMES.test(all.get(pid)?.cmd ?? ""));
  return { omp: mb(sum([...tree])), lsp: mb(sum([...lsp, ...treeLsp])), processes: tree.size };
}

/** Every scripted model started, killed if the script dies part-way. */
const models = new Set();
process.on("exit", () => {
  for (const child of models) child.kill();
});

async function startModel(script) {
  const base = mkdtempSync(join(tmpdir(), "omp-measure-m-"));
  writeFileSync(join(base, "s.json"), JSON.stringify(script));
  const child = spawn(process.execPath, [join(here, "scripted-model.mjs"), "--port", "0", "--script", join(base, "s.json")], {
    stdio: ["ignore", "pipe", "ignore"],
  });
  models.add(child);
  const port = await new Promise((resolve) => child.stdout.once("data", (d) => resolve(Number(/listening (\d+)/.exec(String(d))[1]))));
  return { child, port, base };
}

async function runCase(name, { script, cwd, prompt, config = "", env = {} }) {
  const model = await startModel(script);
  const home = join(model.base, "home");
  mkdirSync(join(home, ".omp", "agent"), { recursive: true });
  writeFileSync(
    join(home, ".omp", "agent", "models.yml"),
    `providers:\n  scripted:\n    baseUrl: http://127.0.0.1:${model.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: scripted\n`,
  );
  writeFileSync(join(home, ".omp", "agent", "config.yml"), config);
  const t0 = performance.now();
  const omp = spawn("omp", ["--mode", "rpc", "--no-title", "--no-session", "--model", "scripted/scripted"], {
    cwd: cwd ?? model.base,
    env: { PATH: env.PATH ?? process.env.PATH, HOME: home, OMP_SKIP_SETUP: "1", TERM: "dumb", CI: "1", PI_NATIVES_DIR: NATIVES },
    stdio: ["pipe", "pipe", "ignore"],
  });
  const frames = [];
  let wake = () => {};
  createInterface({ input: omp.stdout }).on("line", (line) => {
    try {
      frames.push(JSON.parse(line));
    } catch {
      return;
    }
    wake();
  });
  const until = (test, ms) =>
    new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${name}: timeout`)), ms);
      const check = () => {
        if (frames.some(test)) {
          clearTimeout(timer);
          resolve();
        }
      };
      wake = check;
      check();
    });
  let peak = { omp: { rss: 0, pss: 0 }, lsp: { rss: 0, pss: 0 }, processes: 0 };
  const take = () => {
    const s = sample(omp.pid);
    peak = {
      omp: { rss: Math.max(peak.omp.rss, s.omp.rss), pss: Math.max(peak.omp.pss, s.omp.pss) },
      lsp: { rss: Math.max(peak.lsp.rss, s.lsp.rss), pss: Math.max(peak.lsp.pss, s.lsp.pss) },
      processes: Math.max(peak.processes, s.processes),
    };
  };
  const timer = setInterval(take, 100);
  await until((f) => f.type === "ready", 30000);
  const readyMs = Math.round(performance.now() - t0);
  if (prompt) {
    omp.stdin.write(`${JSON.stringify({ id: "m1", type: "prompt", message: prompt })}\n`);
    await until((f) => f.type === "agent_end" && f.isTerminal !== false, 120000);
  } else {
    await new Promise((r) => setTimeout(r, 2000));
  }
  take();
  clearInterval(timer);
  omp.stdin.end();
  await new Promise((r) => omp.once("exit", r));
  // What outlives omp: the shared language-server daemon, if any, and for
  // how long. Polled until it is gone, up to two minutes.
  const exitedAt = performance.now();
  await new Promise((r) => setTimeout(r, 1500));
  const after = sample(null);
  let lingerMs = 0;
  while (sample(null).lsp.rss > 0 && performance.now() - exitedAt < 120_000) {
    await new Promise((r) => setTimeout(r, 500));
    lingerMs = Math.round(performance.now() - exitedAt);
  }
  model.child.kill();
  rmSync(model.base, { recursive: true, force: true });
  return { readyMs, peak, afterExit: after.lsp, lingerMs };
}

const files = readdirSync(join(repo, "packages", "providers", "src"))
  .filter((f) => f.endsWith(".ts"))
  .slice(0, 20)
  .map((f) => `packages/providers/src/${f}`);
const lspBin = flag("lsp-bin");
const cases = {
  idle: () => ({ script: [] }),
  busy: () => ({
    cwd: repo,
    prompt: "Read these files.",
    script: [{ toolCalls: files.map((path) => ({ name: "read", arguments: { i: "read", path } })) }, { text: "Read them." }],
  }),
  scouts: () => ({
    prompt: "Fan out.",
    script: [
      {
        toolCalls: [
          {
            name: "task",
            arguments: {
              i: "fan out",
              context: "measure",
              tasks: [1, 2, 3, 4].map((n) => ({ name: `Scout${n}`, agent: "scout", task: `Probe ${n}.`, solutionSpace: "Read-only." })),
            },
          },
        ],
      },
      ...[1, 2, 3, 4].map((n) => ({ when: `Probe ${n}.`, delayMs: 3000, text: `done ${n}` })),
      { text: "All done." },
    ],
  }),
  lsp: () => ({
    cwd: repo,
    prompt: "Diagnose run.ts.",
    env: lspBin ? { PATH: `${lspBin}:${process.env.PATH}` } : {},
    config: "lsp:\n  enabled: true\n  shared: true\n",
    script: [
      {
        toolCalls: [
          {
            name: "write",
            arguments: {
              i: "diagnostics",
              path: "xd://lsp",
              content: JSON.stringify({ action: "diagnostics", file: "packages/providers/src/run.ts", timeout: 90 }),
            },
          },
        ],
      },
      { text: "Diagnosed." },
    ],
  }),
};

const results = {};
for (const [name, make] of Object.entries(cases)) {
  results[name] = [];
  for (let i = 0; i < RUNS; i++) {
    const r = await runCase(name, make());
    results[name].push(r);
    console.error(`${name} #${i + 1}: ready ${r.readyMs} ms, omp ${r.peak.omp.rss} MB RSS / ${r.peak.omp.pss} MB PSS, lsp ${r.peak.lsp.rss} MB, after exit ${r.afterExit.rss} MB for ${r.lingerMs} ms`);
  }
}

const median = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
const summary = Object.fromEntries(
  Object.entries(results).map(([name, runs]) => [
    name,
    {
      readyMsMedian: median(runs.map((r) => r.readyMs)),
      rssMbMedian: median(runs.map((r) => r.peak.omp.rss)),
      pssMbMedian: median(runs.map((r) => r.peak.omp.pss)),
      rssMbMax: Math.max(...runs.map((r) => r.peak.omp.rss)),
      lspRssMbMedian: median(runs.map((r) => r.peak.lsp.rss)),
      lspAfterExitRssMbMedian: median(runs.map((r) => r.afterExit.rss)),
      lspLingerMsMedian: median(runs.map((r) => r.lingerMs)),
      processesMax: Math.max(...runs.map((r) => r.peak.processes)),
    },
  ]),
);
const out = {
  label: `omp-rss-${new Date().toISOString().slice(0, 10)}`,
  at: new Date().toISOString(),
  omp: (await new Promise((resolve) => {
    const c = spawn("omp", ["--version"], { env: { PATH: process.env.PATH, PI_NATIVES_DIR: NATIVES, HOME: tmpdir() } });
    let s = "";
    c.stdout.on("data", (d) => (s += d));
    c.on("exit", () => resolve(s.trim()));
  })),
  runs: RUNS,
  summary,
  results,
};
const json = `${JSON.stringify(out, null, 2)}\n`;
if (flag("out")) writeFileSync(flag("out"), json);
else process.stdout.write(json);
