// cache-bench.ts — micro-benchmarks for the memory cache eviction paths.
//
// Run with: npx tsx src/cache-bench.ts
//
// These target the hot paths that were previously O(n) per operation
// (O(n^2) per workload): LFU eviction scans, FIFO order-array splices,
// and TTL at-capacity cleanup sweeps. LRU is included as a control.
/* eslint-disable no-console */

import {
  LRUMemoryCache,
  LFUMemoryCache,
  TTLMemoryCache,
  FIFOMemoryCache,
} from "./cache-memory";

const N = Number(process.env.BENCH_N ?? 10_000);

async function bench(name: string, fn: () => Promise<void>): Promise<void> {
  const t0 = performance.now();
  await fn();
  console.log(`${name.padEnd(48)} ${(performance.now() - t0).toFixed(1)} ms`);
}

async function main(): Promise<void> {
  console.log(`cache-bench: N=${N}\n`);

  await bench(`LFU churn (${N} evicting sets @ capacity)`, async () => {
    const c = new LFUMemoryCache<number>(N);
    for (let i = 0; i < N; i++) await c.set(`k${i}`, i);
    for (let i = 0; i < N; i++) await c.set(`churn${i}`, i);
  });

  await bench(`FIFO overwrite (${N} re-sets in full cache)`, async () => {
    const c = new FIFOMemoryCache<number>(N);
    for (let i = 0; i < N; i++) await c.set(`k${i}`, i);
    for (let i = 0; i < N; i++) await c.set(`k${(i * 7919) % N}`, i);
  });

  await bench(`TTL at-capacity insert (${N} sets)`, async () => {
    const c = new TTLMemoryCache<number>(N, 3_600_000);
    for (let i = 0; i < N; i++) await c.set(`k${i}`, i, 3_600_000);
    for (let i = 0; i < N; i++) await c.set(`t${i}`, i, 3_600_000);
    c.destroy();
  });

  await bench(`LRU churn (${N} evicting sets @ capacity)`, async () => {
    const c = new LRUMemoryCache<number>(N);
    for (let i = 0; i < N; i++) await c.set(`k${i}`, i);
    for (let i = 0; i < N; i++) await c.set(`churn${i}`, i);
  });
}

void main();
