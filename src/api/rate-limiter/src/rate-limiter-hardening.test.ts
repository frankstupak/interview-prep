// rate-limiter-hardening.test.ts
// Regression tests for the correctness/robustness fixes in this changeset.
// All Redis-path tests here run the REAL Lua scripts via ioredis-mock (fengari).
import { describe, it, expect, beforeEach } from "@jest/globals";
import {
  checkRateLimitWithSlidingWindow,
  checkRateLimitWithFixedWindow,
  checkRateLimitWithTokenBucket,
  RateLimitType,
} from "./rateLimited-redis";
import {
  checkRateLimitWithSlidingWindowMemory,
  checkRateLimitWithTokenBucketMemory,
  clearMemoryStorage,
} from "./rateLimited-implemented";
import { TestRedisClient } from "./test-redis-client";

beforeEach(() => {
  clearMemoryStorage();
});

describe("sliding window: same-millisecond burst (ZADD member collision regression)", () => {
  // The old Lua used member = tostring(now). Sorted-set members are unique, so
  // two hits in the same millisecond deduped into ONE entry — the limiter
  // undercounted and over-admitted under exactly the bursty traffic it exists
  // to stop. Members are now unique per request.
  it("counts every hit even when all hits share one timestamp", async () => {
    const redis = new TestRedisClient();
    const now = Date.now();
    const limit = 2;

    const r1 = await checkRateLimitWithSlidingWindow(redis, {
      key: "same-ms",
      limit,
      windowMs: 10_000,
      nowMs: now,
      type: RateLimitType.SLIDING_WINDOW_REDIS,
    });
    const r2 = await checkRateLimitWithSlidingWindow(redis, {
      key: "same-ms",
      limit,
      windowMs: 10_000,
      nowMs: now,
      type: RateLimitType.SLIDING_WINDOW_REDIS,
    });
    const r3 = await checkRateLimitWithSlidingWindow(redis, {
      key: "same-ms",
      limit,
      windowMs: 10_000,
      nowMs: now,
      type: RateLimitType.SLIDING_WINDOW_REDIS,
    });

    expect(r1.allowed).toBe(true);
    expect(r1.remaining).toBe(1);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(0);
    // Old behavior: r3 was ALLOWED (the set still held 1 member). It must deny.
    expect(r3.allowed).toBe(false);
    expect(r3.remaining).toBe(0);
  });
});

describe("sliding window: flood behavior (bounded memory + no self-lockout)", () => {
  it("Redis: never stores more than `limit` members per key under sustained flood", async () => {
    const redis = new TestRedisClient();
    const now = Date.now();
    const limit = 10;

    for (let i = 0; i < 100; i++) {
      await checkRateLimitWithSlidingWindow(redis, {
        key: "flood",
        limit,
        windowMs: 60_000,
        nowMs: now + i,
        type: RateLimitType.SLIDING_WINDOW_REDIS,
      });
    }

    // Old behavior: every denied hit was ZADDed too — 100 members and growing
    // without bound for as long as the flood lasts. Now capped at `limit`.
    expect(await redis.zcard("rl:flood:sliding")).toBeLessThanOrEqual(limit);
  });

  it("Redis: a client that backs off recovers when its ALLOWED hits age out (no self-lockout)", async () => {
    const redis = new TestRedisClient();
    const base = Date.now();
    const limit = 2;
    const windowMs = 1_000;
    const opts = {
      key: "recover",
      limit,
      windowMs,
      type: RateLimitType.SLIDING_WINDOW_REDIS as const,
    };

    // Two allowed hits early in the window...
    expect((await checkRateLimitWithSlidingWindow(redis, { ...opts, nowMs: base })).allowed).toBe(
      true
    );
    expect(
      (await checkRateLimitWithSlidingWindow(redis, { ...opts, nowMs: base + 100 })).allowed
    ).toBe(true);
    // ...then a denied burst late in the window.
    for (const dt of [200, 300, 400, 500]) {
      expect(
        (await checkRateLimitWithSlidingWindow(redis, { ...opts, nowMs: base + dt })).allowed
      ).toBe(false);
    }

    // At base+1150 both ALLOWED hits (t=0, t=100) have aged out. Old behavior
    // recorded the denied burst too, so the window still held 4 entries here
    // and the well-behaved client stayed locked out by its own rejections.
    const recovered = await checkRateLimitWithSlidingWindow(redis, { ...opts, nowMs: base + 1150 });
    expect(recovered.allowed).toBe(true);
  });

  it("memory: mirrors both flood properties", async () => {
    const base = Date.now();
    const limit = 2;
    const windowMs = 1_000;
    const opts = {
      key: "recover-mem",
      limit,
      windowMs,
      type: RateLimitType.SLIDING_WINDOW_MEMORY as const,
    };

    expect((await checkRateLimitWithSlidingWindowMemory({ ...opts, nowMs: base })).allowed).toBe(
      true
    );
    expect(
      (await checkRateLimitWithSlidingWindowMemory({ ...opts, nowMs: base + 100 })).allowed
    ).toBe(true);
    for (const dt of [200, 300, 400, 500]) {
      expect(
        (await checkRateLimitWithSlidingWindowMemory({ ...opts, nowMs: base + dt })).allowed
      ).toBe(false);
    }
    expect(
      (await checkRateLimitWithSlidingWindowMemory({ ...opts, nowMs: base + 1150 })).allowed
    ).toBe(true);
  });
});

describe("fixed window: deterministic boundary behavior", () => {
  it("resets the counter exactly at the window boundary (explicit, pinned timeline)", async () => {
    const redis = new TestRedisClient();
    const windowMs = 60_000;
    const limit = 2;
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const opts = {
      key: "boundary",
      limit,
      windowMs,
      type: RateLimitType.FIXED_WINDOW_REDIS as const,
    };

    // Fill the window mid-window. (Not right at the boundary: PEXPIRE runs on
    // the store's wall clock while nowMs here is simulated, so a simulated hit
    // 1ms before the boundary would give the key a 1ms real-time TTL.)
    expect(
      (await checkRateLimitWithFixedWindow(redis, { ...opts, nowMs: windowStart + 1_000 })).allowed
    ).toBe(true);
    expect(
      (await checkRateLimitWithFixedWindow(redis, { ...opts, nowMs: windowStart + 1_001 })).allowed
    ).toBe(true);
    expect(
      (await checkRateLimitWithFixedWindow(redis, { ...opts, nowMs: windowStart + 1_002 })).allowed
    ).toBe(false);

    // First millisecond of the next window: fresh counter.
    const next = await checkRateLimitWithFixedWindow(redis, {
      ...opts,
      nowMs: windowStart + windowMs,
    });
    expect(next.allowed).toBe(true);
    expect(next.remaining).toBe(limit - 1);
    expect(next.resetMs).toBe(windowMs);
  });

  it("window keys expire at the window end, not a full window after the last hit", async () => {
    const redis = new TestRedisClient();
    const windowMs = 60_000;
    const windowStart = Math.floor(Date.now() / windowMs) * windowMs;
    const nowMs = windowStart + 45_000; // 15s left in the window

    await checkRateLimitWithFixedWindow(redis, {
      key: "ttl-check",
      limit: 5,
      windowMs,
      nowMs,
      type: RateLimitType.FIXED_WINDOW_REDIS,
    });

    const ttl = await redis.pttl(`rl:ttl-check:fixed:${windowStart}`);
    // Old behavior re-armed PEXPIRE(windowMs) on every hit: TTL here was a
    // full 60s, keeping the dead key alive ~45s past the window end.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(15_000);
  });
});

describe("token bucket: accurate Retry-After (resetMs)", () => {
  // Old behavior returned the FULL refill interval whenever the bucket hit
  // zero, ignoring time already elapsed toward the next token — overstating
  // Retry-After by up to one whole refill period.
  it("Redis: credits elapsed time toward the next token", async () => {
    const redis = new TestRedisClient();
    const base = Date.now();
    const capacity = 2;
    const windowMs = 1_000; // refillMs = 500
    const opts = {
      key: "reset-acc",
      limit: capacity,
      windowMs,
      type: RateLimitType.TOKEN_BUCKET_REDIS as const,
    };

    await checkRateLimitWithTokenBucket(redis, { ...opts, nowMs: base }); // tokens 2 -> 1
    const drained = await checkRateLimitWithTokenBucket(redis, { ...opts, nowMs: base }); // tokens 1 -> 0
    expect(drained.allowed).toBe(true);
    expect(drained.resetMs).toBe(500); // nothing elapsed yet: full interval

    // 200ms later, still empty: next token lands in 300ms, not 500ms.
    const denied = await checkRateLimitWithTokenBucket(redis, { ...opts, nowMs: base + 200 });
    expect(denied.allowed).toBe(false);
    expect(denied.resetMs).toBe(300);
  });

  it("memory: identical resetMs accounting", async () => {
    const base = Date.now();
    const capacity = 2;
    const windowMs = 1_000;
    const opts = {
      key: "reset-acc-mem",
      limit: capacity,
      windowMs,
      type: RateLimitType.TOKEN_BUCKET_MEMORY as const,
    };

    await checkRateLimitWithTokenBucketMemory({ ...opts, nowMs: base });
    const drained = await checkRateLimitWithTokenBucketMemory({ ...opts, nowMs: base });
    expect(drained.resetMs).toBe(500);

    const denied = await checkRateLimitWithTokenBucketMemory({ ...opts, nowMs: base + 200 });
    expect(denied.allowed).toBe(false);
    expect(denied.resetMs).toBe(300);
  });

  it("Redis: a long-idle full bucket restarts its refill clock at now", async () => {
    const redis = new TestRedisClient();
    const base = Date.now();
    const capacity = 2;
    const windowMs = 1_000; // refillMs = 500
    const opts = {
      key: "idle-clamp",
      limit: capacity,
      windowMs,
      type: RateLimitType.TOKEN_BUCKET_REDIS as const,
    };

    // Drain, then idle far past a full refill.
    await checkRateLimitWithTokenBucket(redis, { ...opts, nowMs: base });
    await checkRateLimitWithTokenBucket(redis, { ...opts, nowMs: base });

    const later = base + 60_000;
    const a = await checkRateLimitWithTokenBucket(redis, { ...opts, nowMs: later });
    const b = await checkRateLimitWithTokenBucket(redis, { ...opts, nowMs: later });
    expect(a.allowed).toBe(true);
    expect(b.allowed).toBe(true);
    const denied = await checkRateLimitWithTokenBucket(redis, { ...opts, nowMs: later });
    expect(denied.allowed).toBe(false);
    // Refill clock restarted at `later`: full interval until the next token.
    expect(denied.resetMs).toBe(500);
  });
});
