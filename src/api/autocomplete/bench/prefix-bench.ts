/* eslint-disable no-console -- CLI benchmark script; console output is the deliverable */
/**
 * Benchmark: prefix autocomplete via Fuse.js scan vs PrefixIndex trie.
 *
 * Run: npm run bench:prefix   (tsx bench/prefix-bench.ts)
 *
 * Compares three ways of answering a short prefix query over N items:
 *   1. Fuse.js as shipped   - `^q` WITHOUT useExtendedSearch (broken: the
 *      caret is fuzzy-matched as a literal character)
 *   2. Fuse.js extended     - `^q` WITH useExtendedSearch: true (correct,
 *      but still scans every indexed string per query)
 *   3. PrefixIndex trie     - O(|prefix| + k) lookup
 */

import Fuse from "fuse.js";
import { PrefixIndex } from "../src/prefix-index";
import { AutocompleteItem } from "../src/types";

const N = Number(process.env.BENCH_N || 100_000);
const QUERY_ROUNDS = Number(process.env.BENCH_ROUNDS || 200);
const LIMIT = 10;

const ADJ = ["fast", "smart", "cloud", "micro", "hyper", "quantum", "neural", "atomic", "green", "solid"];
const NOUN = ["widget", "gadget", "service", "engine", "parser", "router", "cache", "queue", "stream", "index"];
const SUF = ["pro", "lite", "max", "core", "kit", "hub", "lab", "box", "net", "base"];

function makeItems(n: number): AutocompleteItem[] {
  const items: AutocompleteItem[] = [];
  for (let i = 0; i < n; i++) {
    const a = ADJ[i % ADJ.length];
    const b = NOUN[Math.floor(i / ADJ.length) % NOUN.length];
    const c = SUF[Math.floor(i / (ADJ.length * NOUN.length)) % SUF.length];
    items.push({
      id: `item-${i}`,
      title: `${a} ${b} ${c} ${i}`,
      description: `The ${a} ${b} for serious ${c} users`,
      category: NOUN[i % NOUN.length],
      tags: [a, b],
      createdAt: new Date(),
      updatedAt: new Date(),
    });
  }
  return items;
}

// Same 1-2 char prefixes the engine's prefix strategy handles
const QUERIES = ["fa", "sm", "cl", "mi", "hy", "qu", "ne", "at", "gr", "so", "w", "g", "s", "e", "p"];

function bench(label: string, fn: () => void, rounds: number): number {
  // warmup
  for (let i = 0; i < Math.min(10, rounds); i++) fn();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < rounds; i++) fn();
  const t1 = process.hrtime.bigint();
  const perOpMs = Number(t1 - t0) / 1e6 / rounds;
  console.log(`${label.padEnd(34)} ${perOpMs.toFixed(4)} ms/query`);
  return perOpMs;
}

function main(): void {
  console.log(`\n=== Prefix autocomplete benchmark: N=${N} items, ${QUERY_ROUNDS} query rounds, limit=${LIMIT} ===\n`);
  const items = makeItems(N);
  const fuseKeys = [
    { name: "title", weight: 0.7 },
    { name: "description", weight: 0.3 },
    { name: "tags", weight: 0.2 },
  ];

  let t = Date.now();
  const fusePlain = new Fuse(items, { keys: fuseKeys, threshold: 0.3, includeScore: true });
  console.log(`Fuse (default) index build:        ${Date.now() - t} ms`);

  t = Date.now();
  const fuseExt = new Fuse(items, { keys: fuseKeys, threshold: 0.3, includeScore: true, useExtendedSearch: true });
  console.log(`Fuse (extended) index build:       ${Date.now() - t} ms`);

  t = Date.now();
  const trie = new PrefixIndex();
  trie.build(items);
  console.log(`PrefixIndex trie build:            ${Date.now() - t} ms  (${trie.tokens} tokens)\n`);

  let qi = 0;
  const nextQ = (): string => QUERIES[qi++ % QUERIES.length];

  const plainMs = bench("Fuse as shipped (`^q`, no ext):", () => {
    fusePlain.search(`^${nextQ()}`, { limit: LIMIT });
  }, QUERY_ROUNDS);

  qi = 0;
  const extMs = bench("Fuse extended (`^q`, correct):", () => {
    fuseExt.search(`^${nextQ()}`, { limit: LIMIT });
  }, QUERY_ROUNDS);

  qi = 0;
  const trieMs = bench("PrefixIndex trie:", () => {
    trie.search(nextQ(), LIMIT);
  }, QUERY_ROUNDS);

  console.log(`\nSpeedup vs Fuse-as-shipped:  ${(plainMs / trieMs).toFixed(1)}x`);
  console.log(`Speedup vs Fuse-extended:    ${(extMs / trieMs).toFixed(1)}x\n`);

  // Correctness spot check: trie results actually start with the prefix
  const sample = trie.search("qu", LIMIT);
  const ok = sample.length > 0 && sample.every((r) =>
    r.title.split(/\s+/).some((w) => w.startsWith("qu")) || r.tags.some((tg) => tg.startsWith("qu"))
  );
  console.log(`Trie correctness spot check ("qu" -> ${sample.length} results, all prefixed): ${ok ? "PASS" : "FAIL"}`);
  if (!ok) process.exit(1);
}

main();
