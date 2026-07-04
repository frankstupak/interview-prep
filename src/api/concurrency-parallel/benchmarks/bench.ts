/**
 * Benchmarks: worker-pool dispatch under skewed task durations + fibonacci.
 * Run against a built dist (node benchmarks/bench.js). Compare by building
 * the old and new sources into dist and running this same script.
 */
/* eslint-disable no-console */
import { ParallelManager } from "../src/parallel-manager";

async function benchDispatch() {
  const manager = new ParallelManager({ workerCount: 2, timeout: 600000 });
  await manager.initializeWorkers();

  // 16 tasks with alternating heavy/light durations — the adversarial (and
  // realistic) case for eager round-robin: all heavy tasks land on one worker.
  const tasks = [];
  for (let i = 0; i < 16; i++) {
    tasks.push({ iterations: i % 2 === 0 ? 15_000_000 : 50_000 });
  }

  const start = Date.now();
  await manager.executeParallel(tasks, "compute");
  const elapsed = Date.now() - start;
  await manager.cleanup();
  return elapsed;
}

async function benchFibonacci(n) {
  const manager = new ParallelManager({ workerCount: 1, timeout: 600000 });
  await manager.initializeWorkers();
  const start = Date.now();
  await manager.executeParallel([{ n }], "fibonacci");
  const elapsed = Date.now() - start;
  await manager.cleanup();
  return elapsed;
}

(async () => {
  const dispatchMs = await benchDispatch();
  console.log(`RESULT dispatch_skewed_16tasks_2workers_ms=${dispatchMs}`);
  const fibMs = await benchFibonacci(42);
  console.log(`RESULT fibonacci_n42_ms=${fibMs}`);
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
