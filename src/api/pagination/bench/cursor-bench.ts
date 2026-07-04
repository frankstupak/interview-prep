// cursor-bench.ts - benchmark: binary-search cursor seek vs naive linear seek.
//
// A first-pass cursor implementation resolves the anchor position with
// Array.findIndex (O(n) per page). This library binary-searches the
// (sortKey, id) tuple boundary (O(log n) per page). Both run against the
// same pre-sorted 1,000,000-row dataset so the comparison isolates seek
// cost; cursor decode overhead is identical in both loops.
//
// Run from src/api/pagination: npm run bench
/* eslint-disable no-console */

import {
  createCursorPaginator,
  decodeCursor,
  type DataItem,
} from "../src/pagination";

interface Row extends DataItem {
  id: number;
  salary: number;
}

const N = 1_000_000;
const LIMIT = 100;

function buildRows(n: number): Row[] {
  const rows: Row[] = [];
  for (let i = 1; i <= n; i++) {
    rows.push({ id: i, salary: 50000 + (i % 1000) });
  }
  return rows;
}

function fmt(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${ms.toFixed(1)}ms`;
}

/** Naive strawman: identical cursor semantics, linear findIndex seek. */
function naivePage(
  sorted: Row[],
  cursor: string | undefined,
  limit: number
): { data: Row[]; nextAnchor: string | undefined } {
  let start = 0;
  if (cursor) {
    const p = decodeCursor(cursor);
    start = sorted.findIndex((r) => r.id > (p.id as number));
    if (start === -1) start = sorted.length;
  }
  const data = sorted.slice(start, start + limit);
  const done = start + limit >= sorted.length || data.length === 0;
  return { data, nextAnchor: done ? undefined : encodeAnchor(data[data.length - 1].id) };
}

/** Same token format the library emits (v1, id sort, asc, next). */
function encodeAnchor(id: number): string {
  return Buffer.from(
    JSON.stringify({ v: 1, k: id, id, s: "id", d: "asc", nav: "next", sc: "" }),
    "utf8"
  ).toString("base64url");
}

function main(): void {
  console.log(`dataset: ${N.toLocaleString()} rows, page size ${LIMIT}`);
  const rows = buildRows(N);
  const sorted = [...rows].sort((a, b) => a.id - b.id);
  const pages = Math.ceil(N / LIMIT);

  const paginator = createCursorPaginator(
    rows,
    { sortBy: "id" },
    { defaultLimit: LIMIT, maxLimit: LIMIT }
  );

  // ---- Full sweep: binary-search seek (this PR) ----
  let t0 = performance.now();
  let cursor: string | undefined;
  let count = 0;
  for (;;) {
    const page = paginator.page(cursor, LIMIT);
    count += page.data.length;
    if (page.nextCursor === null) break;
    cursor = page.nextCursor;
  }
  const binarySweep = performance.now() - t0;
  if (count !== N) throw new Error(`binary sweep lost rows: ${count}`);

  // ---- Full sweep: naive linear seek ----
  t0 = performance.now();
  let naiveCursor: string | undefined;
  count = 0;
  for (;;) {
    const page = naivePage(sorted, naiveCursor, LIMIT);
    count += page.data.length;
    if (page.nextAnchor === undefined) break;
    naiveCursor = page.nextAnchor;
  }
  const naiveSweep = performance.now() - t0;
  if (count !== N) throw new Error(`naive sweep lost rows: ${count}`);

  console.log(`\nfull sweep (${pages.toLocaleString()} pages over ${N.toLocaleString()} rows):`);
  console.log(`  binary-search seek: ${fmt(binarySweep)}  (${((binarySweep / pages) * 1000).toFixed(1)}us/page)`);
  console.log(`  linear findIndex:   ${fmt(naiveSweep)}  (${((naiveSweep / pages) * 1000).toFixed(1)}us/page)`);
  console.log(`  speedup: ${(naiveSweep / binarySweep).toFixed(1)}x`);

  // ---- Single page at 90% depth ----
  const deepId = Math.floor(N * 0.9);
  const deepToken = encodeAnchor(deepId);

  const REPS = 2000;
  t0 = performance.now();
  for (let i = 0; i < REPS; i++) paginator.page(deepToken, LIMIT);
  const binaryDeep = (performance.now() - t0) / REPS;

  const NAIVE_REPS = 200;
  t0 = performance.now();
  for (let i = 0; i < NAIVE_REPS; i++) naivePage(sorted, deepToken, LIMIT);
  const naiveDeep = (performance.now() - t0) / NAIVE_REPS;

  console.log(`\nsingle page at 90% depth (anchor row ${deepId.toLocaleString()}):`);
  console.log(`  binary-search seek: ${(binaryDeep * 1000).toFixed(1)}us/page (${REPS} reps)`);
  console.log(`  linear findIndex:   ${(naiveDeep * 1000).toFixed(1)}us/page (${NAIVE_REPS} reps)`);
  console.log(`  speedup: ${(naiveDeep / binaryDeep).toFixed(0)}x`);
}

main();
