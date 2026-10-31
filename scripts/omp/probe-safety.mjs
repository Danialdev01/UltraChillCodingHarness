#!/usr/bin/env node
/**
 * Does a cloned repository configure OMP? (todo OM0.4, solution §0.3)
 *
 * Plants every project-scope source OMP is documented to read into a scratch
 * repository, each wired to leave a marker if it is loaded, then runs one
 * scripted turn under a series of launch configurations and prints which
 * plants took effect. Re-run on every OMP version bump (todo OM8.6).
 *
 *   node scripts/omp/probe-safety.mjs [--omp path] [--json out.json] [--only plant]
 */
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const flag = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i === -1 ? undefined : argv[i + 1];
};
const ompBin = flag("omp") ?? "omp";

const base = mkdtempSync(join(tmpdir(), "omp-safety-"));
const markers = join(base, "markers");
const marker = join(base, "marker.sh");
mkdirSync(markers);
writeFileSync(marker, `#!/bin/sh\ntouch "${markers}/$1"\nexec sleep 30\n`);
chmodSync(marker, 0o755);

// Each plant: files to write into the repo, and how to tell it was loaded --
// a marker file, or a sentinel in what OMP sent the model.
const SENTINEL = (name) => `UCCH-SENTINEL-${name}`;
const mcpServer = (name) => JSON.stringify({ mcpServers: { [name]: { command: marker, args: [name] } } });
const debugLaunch = [
  { toolCalls: [{ name: "write", arguments: { i: "debug", path: "xd://debug", content: JSON.stringify({ action: "launch", adapter: "plantdap", program: "x.js" }) } }] },
  { text: "ok" },
];
const plants = {
  "config.yml": { files: { ".omp/config.yml": "tools:\n  approvalMode: always-ask\n" }, check: "approvalMode" },
  hook: {
    files: { ".omp/hooks/pre/plant.ts": `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(markers, "hook"))}, "");\nexport default function () {}\n` },
    check: "marker",
  },
  "lsp.json (.omp)": {
    files: {
      ".omp/lsp.json": JSON.stringify({ servers: { plantlsp: { command: marker, args: ["lsp.json (.omp)"], fileTypes: [".txt"], rootMarkers: ["plant.root"] } } }),
      "plant.root": "",
    },
    check: "marker",
  },
  "lsp.json (root)": {
    files: {
      "lsp.json": JSON.stringify({ servers: { rootlsp: { command: marker, args: ["lsp.json (root)"], fileTypes: [".txt"], rootMarkers: ["plant.root"] } } }),
      "plant.root": "",
    },
    check: "marker",
  },
  // A debug launch through the xd://debug device is what starts an adapter.
  "dap.json (.omp)": {
    files: { ".omp/dap.json": JSON.stringify({ adapters: { plantdap: { command: marker, args: ["dap.json (.omp)"] } } }), "x.js": "1;\n" },
    script: debugLaunch,
    check: "marker",
  },
  "dap.json (root)": {
    files: { "dap.json": JSON.stringify({ adapters: { plantdap: { command: marker, args: ["dap.json (root)"] } } }), "x.js": "1;\n" },
    script: debugLaunch,
    check: "marker",
  },
  "mcp.json (.omp)": { files: { ".omp/mcp.json": mcpServer("mcp.json (.omp)") }, check: "marker" },
  ".mcp.json (root)": { files: { ".mcp.json": mcpServer(".mcp.json (root)") }, check: "marker" },
  ".claude/settings.json mcp": { files: { ".claude/settings.json": mcpServer(".claude/settings.json mcp") }, check: "marker" },
  "agents (.omp)": {
    files: { ".omp/agents/plantagent.md": `---\nname: plantagent\ndescription: ${SENTINEL("agent")}\n---\nBody.\n` },
    check: "sentinel",
    sentinel: SENTINEL("agent"),
  },
  "RULES.md (.omp)": { files: { ".omp/RULES.md": `${SENTINEL("rules")}\n` }, check: "sentinel", sentinel: SENTINEL("rules") },
  "skill (.claude)": {
    files: { ".claude/skills/plantskill/SKILL.md": `---\nname: plantskill\ndescription: ${SENTINEL("claudeskill")}\n---\nBody.\n` },
    check: "sentinel",
    sentinel: SENTINEL("claudeskill"),
  },
  "skill (.omp)": {
    files: { ".omp/skills/plantskill2/SKILL.md": `---\nname: plantskill2\ndescription: ${SENTINEL("ompskill")}\n---\nBody.\n` },
    check: "sentinel",
    sentinel: SENTINEL("ompskill"),
  },
  "command (.claude)": { files: { ".claude/commands/plantcmd.md": `${SENTINEL("cmd")}\n` }, check: "commands", name: "plantcmd" },
  "AGENTS.md": { files: { "AGENTS.md": `${SENTINEL("agentsmd")}\n` }, check: "sentinel", sentinel: SENTINEL("agentsmd") },
  "CLAUDE.md (.claude)": { files: { ".claude/CLAUDE.md": `${SENTINEL("claudemd")}\n` }, check: "sentinel", sentinel: SENTINEL("claudemd") },
  // Not repository plants: where UCCH's own guard hook could live (solution
  // §3.9). They must keep loading under the untrusted-project flags.
  "user hook (agent dir)": {
    files: {},
    agentFiles: { "hooks/pre/user.ts": hookSource("user hook (agent dir)") },
    check: "marker",
  },
  "--hook <abs>": { files: {}, hook: hookSource("--hook <abs>"), check: "marker" },
};

function hookSource(name) {
  return `import { writeFileSync } from "node:fs";\nwriteFileSync(${JSON.stringify(join(markers, name))}, "");\nexport default function () {}\n`;
}

const overlay = join(base, "overlay.yml");
writeFileSync(
  overlay,
  [
    "tools:",
    "  approvalMode: yolo",
    "mcp:",
    "  enableProjectConfig: false",
    "skills:",
    "  enableClaudeProject: false",
    "  enablePiProject: false",
    "  enableAgentsProject: false",
    "commands:",
    "  enableClaudeProject: false",
    "  enableOpencodeProject: false",
    "",
  ].join("\n"),
);

// No DAP for an untrusted project: nothing else stops a project adapter.
const debugOff = join(base, "debug-off.yml");
writeFileSync(debugOff, "debug:\n  enabled: false\n");

const configs = [
  { name: "defaults", env: {}, args: [] },
  { name: "PI_CONFIG_DIR", env: { PI_CONFIG_DIR: ".ucch-omp" }, args: [] },
  { name: "+ --no-extensions --no-rules", env: { PI_CONFIG_DIR: ".ucch-omp" }, args: ["--no-extensions", "--no-rules"] },
  { name: "+ overlay", env: { PI_CONFIG_DIR: ".ucch-omp" }, args: ["--no-extensions", "--no-rules", "--config", overlay] },
  { name: "+ --no-lsp", env: { PI_CONFIG_DIR: ".ucch-omp" }, args: ["--no-extensions", "--no-rules", "--config", overlay, "--no-lsp"] },
  {
    name: "+ debug off",
    env: { PI_CONFIG_DIR: ".ucch-omp" },
    args: ["--no-extensions", "--no-rules", "--config", overlay, "--no-lsp", "--config", debugOff],
  },
];

function run(cmd, args, opts) {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    let err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    const timer = setTimeout(() => child.kill("SIGKILL"), 60000);
    child.on("exit", (code) => {
      clearTimeout(timer);
      resolve({ code, out, err });
    });
  });
}

async function startModel(script, log) {
  const scriptPath = `${log}.script.json`;
  writeFileSync(scriptPath, JSON.stringify(script));
  const child = spawn(process.execPath, [join(here, "scripted-model.mjs"), "--port", "0", "--script", scriptPath, "--log", log], {
    stdio: ["ignore", "pipe", "inherit"],
    // Whole messages and tool schemas: an agent's description, for one, is
    // only in the task tool's schema.
    env: { ...process.env, LOG_FULL: "1", LOG_SCHEMAS: "1" },
  });
  const port = await new Promise((resolve) => child.stdout.once("data", (d) => resolve(Number(/listening (\d+)/.exec(String(d))[1]))));
  return { child, port };
}

const results = {};
for (const config of configs) {
  for (const [plantName, plant] of Object.entries(plants)) {
    if (flag("only") && plantName !== flag("only")) continue;
    const runDir = mkdtempSync(join(base, "run-"));
    const repo = join(runDir, "repo");
    const agentDir = join(runDir, "agent");
    mkdirSync(agentDir, { recursive: true });
    mkdirSync(repo, { recursive: true });
    for (const [rel, content] of Object.entries(plant.files)) {
      mkdirSync(dirname(join(repo, rel)), { recursive: true });
      writeFileSync(join(repo, rel), content);
    }
    for (const [rel, content] of Object.entries(plant.agentFiles ?? {})) {
      mkdirSync(dirname(join(agentDir, rel)), { recursive: true });
      writeFileSync(join(agentDir, rel), content);
    }
    const hookArgs = [];
    if (plant.hook) {
      writeFileSync(join(runDir, "explicit-hook.ts"), plant.hook);
      hookArgs.push("--hook", join(runDir, "explicit-hook.ts"));
    }
    // PI_CONFIG_DIR renames `.omp`; a stranger's repo would not follow, so
    // the plants stay at `.omp/` in every configuration.
    const log = join(runDir, "requests.jsonl");
    // A write to a .txt file is what wakes a planted language server.
    const model = await startModel(
      plant.script ?? [{ toolCalls: [{ name: "write", arguments: { i: "touch a txt", path: "probe.txt", content: "x\n" } }] }, { text: "ok" }],
      log,
    );
    writeFileSync(
      join(agentDir, "models.yml"),
      `providers:\n  scripted:\n    baseUrl: http://127.0.0.1:${model.port}/v1\n    api: openai-completions\n    auth: none\n    models:\n      - id: scripted\n`,
    );
    const env = {
      PATH: process.env.PATH,
      HOME: join(runDir, "home"),
      // ~120 MB of native modules, unpacked once rather than per run.
      PI_NATIVES_DIR: join(tmpdir(), "omp-natives"),
      PI_CODING_AGENT_DIR: agentDir,
      OMP_SKIP_SETUP: "1",
      TERM: "dumb",
      CI: "1",
      ...config.env,
    };
    rmSync(join(markers, plantName), { force: true });
    const turn = await run(ompBin, ["-p", "--no-title", "--model", "scripted/scripted", ...config.args, ...hookArgs, "Write probe.txt."], { cwd: repo, env });
    // Give a lazily spawned server or MCP process a moment to leave its marker.
    await new Promise((r) => setTimeout(r, 1500));
    model.child.kill();
    let loaded;
    if (plant.check === "marker") loaded = existsSync(join(markers, plantName));
    else if (plant.check === "sentinel") loaded = existsSync(log) && readFileSync(log, "utf8").includes(plant.sentinel);
    else if (plant.check === "approvalMode") {
      const got = await run(ompBin, ["config", "get", "tools.approvalMode", ...config.args.filter((a, i, all) => a === "--config" || all[i - 1] === "--config")], { cwd: repo, env });
      loaded = got.out.trim().includes("always-ask");
    } else if (plant.check === "commands") {
      const got = await run(ompBin, ["-p", "--no-title", "--model", "scripted/scripted", ...config.args, `/${plant.name}`], { cwd: repo, env });
      loaded = !/unknown command|not found/i.test(got.out + got.err) && existsSync(log) && readFileSync(log, "utf8").includes(SENTINEL("cmd"));
    }
    results[config.name] ??= {};
    results[config.name][plantName] = loaded ? "LOADED" : "-";
    if (turn.code !== 0) {
      results[config.name][plantName] += ` (exit ${turn.code})`;
      // A failed turn proves nothing about the plant; say why it failed.
      process.stderr.write(`${config.name} / ${plantName}: exit ${turn.code}\n${(turn.err || turn.out).slice(-600)}\n`);
    }
  }
  process.stderr.write(`done: ${config.name}\n`);
}

const names = Object.keys(plants);
const header = ["plant", ...configs.map((c) => c.name)];
const rows = names.filter((n) => results[configs[0].name][n]).map((n) => [n, ...configs.map((c) => results[c.name][n])]);
console.log(`| ${header.join(" | ")} |\n|${header.map(() => "---").join("|")}|`);
for (const row of rows) console.log(`| ${row.join(" | ")} |`);
if (flag("json")) writeFileSync(flag("json"), JSON.stringify(results, null, 2));
if (!process.env.KEEP) rmSync(base, { recursive: true, force: true });
