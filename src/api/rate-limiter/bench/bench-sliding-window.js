// bench-sliding-window.js
// Before/after benchmark for the in-memory sliding-window rate limiter.
// Run: node bench/bench-sliding-window.js
//
// "old" is a verbatim copy of the pre-fix algorithm (filter + realloc on every
// request, denied hits recorded). "new" mirrors the shipped implementation in
// src/rateLimited-implemented.ts (reject-before-add, lazy prune).

"use strict";

// ---- OLD (pre-fix) ---------------------------------------------------------
function makeOld() {
  const data = new Map();
  return function check(key, limit, windowMs, now) {
    const start = now - windowMs;
    let requests = data.get(key) || [];
    requests = requests.filter((t) => t > start); // realloc EVERY call
    requests.push(now); // denied hits recorded too
    data.set(key, requests);
    const count = requests.length;
    const allowed = count <= limit;
    const remaining = Math.max(0, limit - count);
    const oldest = requests.length > 0 ? requests[0] : now;
    return { allowed, remaining, resetMs: Math.max(0, oldest + windowMs - now) };
  };
}

// ---- NEW (shipped) ---------------------------------------------------------
// Mirrors src/rateLimited-implemented.ts: reject-before-add + head-index prune.
function makeNew() {
  const data = new Map();
  return function check(key, limit, windowMs, now) {
    const start = now - windowMs;
    let log = data.get(key);
    if (!log) {
      log = { buf: [], head: 0, sorted: true };
      data.set(key, log);
    }
    if (log.sorted) {
      while (log.head < log.buf.length && log.buf[log.head] <= start) log.head++;
      if (log.head > 1024 && log.head * 2 > log.buf.length) {
        log.buf = log.buf.slice(log.head);
        log.head = 0;
      }
    } else if (log.buf.length > log.head && log.buf[log.head] <= start) {
      log.buf = log.buf.filter((t) => t > start);
      log.head = 0;
    }
    const count = log.buf.length - log.head;
    if (count >= limit) {
      const oldest = count > 0 ? log.buf[log.head] : now;
      return { allowed: false, remaining: 0, resetMs: Math.max(0, oldest + windowMs - now) };
    }
    if (log.buf.length > log.head && now < log.buf[log.buf.length - 1]) log.sorted = false;
    log.buf.push(now);
    return {
      allowed: true,
      remaining: limit - (count + 1),
      resetMs: Math.max(0, log.buf[log.head] + windowMs - now),
    };
  };
}

function bench(label, fn, { limit, windowMs, totalHits, hitEveryMs }) {
  const t0 = process.hrtime.bigint();
  let allowed = 0;
  let now = 1_000_000_000_000;
  for (let i = 0; i < totalHits; i++) {
    now += hitEveryMs;
    if (fn("hot-key", limit, windowMs, now).allowed) allowed++;
  }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  const opsPerSec = Math.round(totalHits / (ms / 1000));
  console.log(
    `${label.padEnd(22)} ${ms.toFixed(1).padStart(9)} ms   ${String(opsPerSec).padStart(12)} ops/s   allowed=${allowed}`
  );
  return { ms, opsPerSec };
}

const scenarios = [
  {
    name: "SUSTAINED FLOOD (attacker ~100x over limit, hot key)",
    // limit 1k/min, hits every 3ms => ~20k hits land per window
    params: { limit: 1_000, windowMs: 60_000, totalHits: 120_000, hitEveryMs: 3 },
  },
  {
    name: "HIGH-LIMIT STEADY STATE (at ~limit rate)",
    // limit 10k/min, one hit every 6ms => right at the limit
    params: { limit: 10_000, windowMs: 60_000, totalHits: 120_000, hitEveryMs: 6 },
  },
];

for (const s of scenarios) {
  console.log(`\n== ${s.name} ==`);
  const oldR = bench("old (record-denied)", makeOld(), s.params);
  const newR = bench("new (reject-first)", makeNew(), s.params);
  console.log(`speedup: ${(oldR.ms / newR.ms).toFixed(1)}x`);
}

// Memory bound demonstration
console.log("\n== MEMORY BOUND (entries stored for one hot key mid-flood) ==");
{
  const oldData = new Map();
  const oldCheck = (key, limit, windowMs, now) => {
    const start = now - windowMs;
    let r = oldData.get(key) || [];
    r = r.filter((t) => t > start);
    r.push(now);
    oldData.set(key, r);
  };

  const newData = new Map();
  const newCheck = (key, limit, windowMs, now) => {
    const start = now - windowMs;
    let log = newData.get(key);
    if (!log) {
      log = { buf: [], head: 0, sorted: true };
      newData.set(key, log);
    }
    while (log.head < log.buf.length && log.buf[log.head] <= start) log.head++;
    if (log.head > 1024 && log.head * 2 > log.buf.length) {
      log.buf = log.buf.slice(log.head);
      log.head = 0;
    }
    if (log.buf.length - log.head >= limit) return;
    log.buf.push(now);
  };

  const limit = 100;
  const windowMs = 60_000;
  let now = 1_000_000_000_000;
  for (let i = 0; i < 50_000; i++) {
    now += 1; // 50k hits inside one window
    oldCheck("k", limit, windowMs, now);
    newCheck("k", limit, windowMs, now);
  }
  console.log(`limit=${limit}, 50,000 hits inside one window:`);
  console.log(`  old stored entries: ${oldData.get("k").length}`);
  console.log(`  new stored entries: ${(newData.get("k").buf.length - newData.get("k").head)}`);
}
