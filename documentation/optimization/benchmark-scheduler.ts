/** Synthetic admission benchmark, not a measurement of deployed agent RAM.
 * Run: pnpm exec tsx optimization/benchmark-scheduler.ts
 */
import { TurnScheduler, type TurnKind } from '../apps/server/src/turn-scheduler.js';
import { performance } from 'node:perf_hooks';
const estimates = { cli: 512, omp: 512, native: 128 };
async function run(budgetMb?: number) {
  const scheduler = new TurnScheduler({ cliPerUser: 2, cliTotal: 5, ompTotal: 6, nativeTotal: 32,
    ...(budgetMb ? { memory: { budgetMb, estimatesMb: estimates } } : {}) });
  let peakEstimatedMb = 0;
  const start = performance.now();
  const jobs = Array.from({ length: 60 }, (_, i) => {
    const kind: TurnKind = (['cli', 'omp', 'native'] as const)[i % 3]!;
    return scheduler.acquire({ ownerId: `user-${i}`, threadId: `thread-${i}`, kind }).then(async release => {
      const { running } = scheduler.stats();
      peakEstimatedMb = Math.max(peakEstimatedMb, running.cli * estimates.cli + running.omp * estimates.omp + running.native * estimates.native);
      await new Promise(resolve => setTimeout(resolve, 20));
      release();
    });
  });
  await Promise.all(jobs);
  return { budgetMb: budgetMb ?? null, completed: jobs.length, peakEstimatedMb, elapsedMs: Math.round(performance.now() - start) };
}
console.log(JSON.stringify({ kind: 'synthetic-scheduler-only', note: 'No agent processes or real RAM workload. Timing is local and illustrative.', node: process.version,
  baseline: await run(), candidate: await run(2048) }, null, 2));
