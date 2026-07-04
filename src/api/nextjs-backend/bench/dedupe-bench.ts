/**
 * Benchmark: email-uniqueness enforcement — O(1) Map index vs naive O(n)
 * Array.find scan, across N sequential inserts.
 *
 * The uplifted /api/users route enforces unique emails with a Map index, so
 * each insert stays O(1). A naive `users.find(u => u.email === email)` check
 * is O(n) per insert -> O(n^2) across N inserts. This script quantifies the gap.
 *
 * Run: npx tsx bench/dedupe-bench.ts
 */

interface Rec {
  id: number;
  email: string;
}

function bench(label: string, fn: () => void): number {
  const start = process.hrtime.bigint();
  fn();
  const end = process.hrtime.bigint();
  const ms = Number(end - start) / 1e6;
  // eslint-disable-next-line no-console
  console.log(`${label.padEnd(28)} ${ms.toFixed(1)} ms`);
  return ms;
}

function run(n: number): void {
  const emails = Array.from({ length: n }, (_, i) => `user${i}@example.com`);

  // eslint-disable-next-line no-console
  console.log(`\nN = ${n.toLocaleString()} sequential unique inserts`);

  const naiveMs = bench("naive Array.find dedupe", () => {
    const users: Rec[] = [];
    for (let i = 0; i < n; i += 1) {
      const email = emails[i];
      if (!users.find((u) => u.email === email)) {
        users.push({ id: i, email });
      }
    }
  });

  const indexedMs = bench("indexed Map dedupe", () => {
    const users: Rec[] = [];
    const byEmail = new Map<string, Rec>();
    for (let i = 0; i < n; i += 1) {
      const email = emails[i];
      if (!byEmail.has(email)) {
        const rec = { id: i, email };
        users.push(rec);
        byEmail.set(email, rec);
      }
    }
  });

  const speedup = naiveMs / indexedMs;
  // eslint-disable-next-line no-console
  console.log(`speedup: ${speedup.toFixed(0)}x`);
}

for (const n of [10000, 50000]) {
  run(n);
}
