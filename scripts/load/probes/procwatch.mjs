#!/usr/bin/env node
/**
 * Counts `claude` processes more closely than the resource sampler's 15 s
 * tick: run inside the container, it reads /proc every --every ms for
 * --seconds and prints how many distinct ones it saw and the most alive at
 * once -- every second, as running totals, so a caller can stop it early
 * and read the last line. A turn's process lives for seconds, so a poll
 * cannot miss one.
 * (git processes live for milliseconds; the server counts those itself, in
 * `git_processes_total`.)
 *
 *   docker exec ucch-load node /load/probes/procwatch.mjs --seconds 60 [--every 20]
 *
 * A process is a `claude` by its name, or by running fake-claude.mjs (which
 * names itself so).
 */
import { readdirSync, readFileSync } from "node:fs";
import { parseArgs } from "node:util";

const { values: args } = parseArgs({
  options: { seconds: { type: "string", default: "60" }, every: { type: "string", default: "20" } },
});

function isClaude(pid) {
  try {
    if (readFileSync(`/proc/${pid}/comm`, "utf8").trim() === "claude") return true;
    const argv = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0");
    return argv.some((arg) => arg.endsWith("/claude") || arg.endsWith("fake-claude.mjs"));
  } catch {
    // Gone between the listing and the read.
    return false;
  }
}

const seen = new Set();
let peak = 0;
const report = () =>
  console.log(JSON.stringify({ seconds: Number(args.seconds), claude: { processes: seen.size, peak } }));
const reporter = setInterval(report, 1000);
const stopAt = Date.now() + Number(args.seconds) * 1000;
while (Date.now() < stopAt) {
  let alive = 0;
  for (const pid of readdirSync("/proc")) {
    if (!/^\d+$/.test(pid) || !isClaude(pid)) continue;
    alive++;
    seen.add(pid);
  }
  peak = Math.max(peak, alive);
  await new Promise((resolve) => setTimeout(resolve, Number(args.every)));
}
clearInterval(reporter);
report();
