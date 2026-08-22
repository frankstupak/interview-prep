/* eslint-disable no-console -- benchmark script prints results */
/**
 * Benchmark: resolveAll(tag) discovery cost — tag index (O(k)) vs the previous
 * full-registration scan (O(n)). Run: npx tsx bench/resolveAll.bench.ts
 */
import { DefaultServiceContainer } from "../src/service-container";
import { ServiceLifetime } from "../src/di-types";

const N = 50_000; // total registered services
const K = 20; // services tagged "handler"
const M = 20_000; // resolveAll iterations

function hrms(fn: () => void): number {
  const t0 = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t0) / 1e6;
}

async function main(): Promise<void> {
  const container = new DefaultServiceContainer();
  for (let i = 0; i < N; i++) {
    const tags = i % Math.floor(N / K) === 0 ? ["handler"] : [];
    container.register({
      name: `svc-${i}`,
      factory: () => ({ i }),
      lifetime: ServiceLifetime.SINGLETON,
      tags,
    });
  }

  // Warm the singleton cache (not timed).
  await container.resolveAll("handler");

  // --- Discovery micro-benchmark: the part the fix changes -------------------
  // Model both strategies over identical registration metadata.
  const regs = new Map<string, { tags: string[] }>();
  const tagIndex = new Map<string, Set<string>>();
  for (let i = 0; i < N; i++) {
    const tags = i % Math.floor(N / K) === 0 ? ["handler"] : [];
    regs.set(`svc-${i}`, { tags });
    for (const t of tags) {
      let set = tagIndex.get(t);
      if (!set) {
        set = new Set<string>();
        tagIndex.set(t, set);
      }
      set.add(`svc-${i}`);
    }
  }

  const naiveLookup = (tag: string): string[] => {
    const out: string[] = [];
    for (const [name, r] of regs) {
      if (r.tags.includes(tag)) out.push(name);
    }
    return out;
  };
  const indexedLookup = (tag: string): string[] => {
    const set = tagIndex.get(tag);
    return set ? [...set] : [];
  };

  // sanity: both find the same K
  const nK = naiveLookup("handler").length;
  const iK = indexedLookup("handler").length;
  if (nK !== iK) throw new Error(`mismatch ${nK} vs ${iK}`);

  let acc = 0;
  const naiveMs = hrms(() => {
    for (let m = 0; m < M; m++) acc += naiveLookup("handler").length;
  });
  const indexMs = hrms(() => {
    for (let m = 0; m < M; m++) acc += indexedLookup("handler").length;
  });
  void acc;

  const naivePer = (naiveMs / M) * 1000; // µs per call
  const indexPer = (indexMs / M) * 1000;
  console.log(`N=${N} registrations, K=${nK} tagged, M=${M} lookups`);
  console.log(`  naive O(n) scan : ${naiveMs.toFixed(1)} ms total  |  ${naivePer.toFixed(2)} µs/lookup`);
  console.log(`  indexed O(k)    : ${indexMs.toFixed(1)} ms total  |  ${indexPer.toFixed(2)} µs/lookup`);
  console.log(`  speedup         : ${(naiveMs / indexMs).toFixed(1)}x`);

  await container.dispose();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
