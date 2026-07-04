// cache-uplift.test.ts - Regression tests for the Lumen Industries uplift.
//
// The Redis-side tests run against ioredis-mock, which executes the REAL Lua
// scripts in an embedded Lua VM (unlike the hand-rolled MockRedisClient in
// cache.test.ts, which pattern-matches script text). ioredis-mock was already
// in this package's dependencies but was never used by any test.

import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
// eslint-disable-next-line @typescript-eslint/no-require-imports
import RedisMock = require("ioredis-mock");
import type { Redis } from "ioredis";

import { CacheStrategy, CacheRedisClient } from "./cache-types";
import {
  LRUMemoryCache,
  LFUMemoryCache,
  TTLMemoryCache,
  FIFOMemoryCache,
  clearMemoryCacheStorage,
} from "./cache-memory";
import { RedisCache, clearRedisCacheStorage } from "./cache-redis";
import { createCacheManager, createMultiLevelCacheManager } from "./cache-manager";

// ioredis-mock@8.13.1's own package.json pins @types/ioredis-mock@^8, which
// resolves to a stale 8.2.7 whose exported type TS doesn't recognize as
// constructable (upstream packaging mismatch, unrelated to this repo).
// ioredis-mock is a drop-in for the real `ioredis` client (which ships its
// own accurate types), so construct via an explicit cast and type the
// instance as ioredis's own Redis rather than fighting the broken .d.ts.
const RedisMockCtor = RedisMock as unknown as new () => Redis;
type IoRedisMock = Redis;

function newRedis(): { raw: IoRedisMock; client: CacheRedisClient } {
  const raw = new RedisMockCtor();
  return { raw, client: raw as unknown as CacheRedisClient };
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

afterEach(() => {
  clearMemoryCacheStorage();
  clearRedisCacheStorage();
});

describe("🧪 Redis uplift regressions (real Lua via ioredis-mock)", () => {
  let raw: IoRedisMock;
  let cache: RedisCache;

  beforeEach(() => {
    const r = newRedis();
    raw = r.raw;
    cache = new RedisCache(r.client, 100);
  });

  afterEach(async () => {
    await raw.flushall();
  });

  it("accepts sub-second TTLs (SETEX seconds-rounding used to produce an invalid 0 expire)", async () => {
    // ttl = 500ms: with the old math.floor(ttl / 1000) this became SETEX 0,
    // which Redis rejects at runtime
    await expect(cache.set("k", "v", CacheStrategy.LRU_REDIS, 500)).resolves.toBeUndefined();
    const result = await cache.get("k", CacheStrategy.LRU_REDIS);
    expect(result.hit).toBe(true);
    expect(result.ttl).toBeGreaterThan(0);
    expect(result.ttl).toBeLessThanOrEqual(500);

    await expect(cache.set("k2", "v", CacheStrategy.LFU_REDIS, 1)).resolves.toBeUndefined();
  });

  it("preserves LFU frequency across overwrites (was reset to 1 on every set)", async () => {
    await cache.set("hot", "v1", CacheStrategy.LFU_REDIS);
    await cache.get("hot", CacheStrategy.LFU_REDIS);
    await cache.get("hot", CacheStrategy.LFU_REDIS);
    await cache.get("hot", CacheStrategy.LFU_REDIS); // freq now 4

    await cache.set("hot", "v2", CacheStrategy.LFU_REDIS); // overwrite

    const score = await raw.zscore("lfu_freq:cache", "cache:hot");
    // Old behavior: score reset to 1. Fixed: ZADD NX keeps the earned 4.
    expect(Number(score)).toBeGreaterThanOrEqual(4);

    const result = await cache.get("hot", CacheStrategy.LFU_REDIS);
    expect(result.value).toBe("v2");
    expect(result.metadata?.hitCount).toBeGreaterThanOrEqual(5);
  });

  it("round-trips value types intact (string '123' used to come back as number 123)", async () => {
    await cache.set("s", "123", CacheStrategy.TTL_REDIS);
    await cache.set("b", "true", CacheStrategy.TTL_REDIS);
    await cache.set("n", 123, CacheStrategy.TTL_REDIS);
    await cache.set("o", { a: [1, 2] }, CacheStrategy.TTL_REDIS);

    expect((await cache.get("s", CacheStrategy.TTL_REDIS)).value).toBe("123");
    expect((await cache.get("b", CacheStrategy.TTL_REDIS)).value).toBe("true");
    expect((await cache.get("n", CacheStrategy.TTL_REDIS)).value).toBe(123);
    expect((await cache.get("o", CacheStrategy.TTL_REDIS)).value).toEqual({ a: [1, 2] });
  });

  it("reports a cached empty string as a hit (was reported as a miss)", async () => {
    await cache.set("empty", "", CacheStrategy.TTL_REDIS);
    const result = await cache.get("empty", CacheStrategy.TTL_REDIS);
    expect(result.hit).toBe(true);
    expect(result.value).toBe("");
  });

  it("enforces LRU capacity in Redis (real eviction through the Lua path)", async () => {
    const small = new RedisCache(raw as unknown as CacheRedisClient, 3);
    await small.set("k1", "v1", CacheStrategy.LRU_REDIS, undefined, 1000);
    await small.set("k2", "v2", CacheStrategy.LRU_REDIS, undefined, 2000);
    await small.set("k3", "v3", CacheStrategy.LRU_REDIS, undefined, 3000);
    await small.set("k4", "v4", CacheStrategy.LRU_REDIS, undefined, 4000);

    expect((await small.get("k1", CacheStrategy.LRU_REDIS)).hit).toBe(false);
    expect((await small.get("k4", CacheStrategy.LRU_REDIS)).hit).toBe(true);
    expect(await raw.zcard("lru_order:cache")).toBeLessThanOrEqual(3);
  });

  it("lazily repairs LRU order members for expired keys (ZSET no longer desyncs)", async () => {
    await cache.set("gone", "v", CacheStrategy.LRU_REDIS, 5);
    await sleep(20); // let the 5ms PX expire

    const result = await cache.get("gone", CacheStrategy.LRU_REDIS);
    expect(result.hit).toBe(false);
    // The stale order member must be gone so it stops counting against capacity
    expect(await raw.zscore("lru_order:cache", "cache:gone")).toBeNull();
  });

  it("write-through gets read through to storage on cache miss (pattern previously defeated)", async () => {
    await cache.set("wt", { id: 7 }, CacheStrategy.WRITE_THROUGH_REDIS);
    // Simulate cache eviction while storage retains the value
    await raw.del("cache:wt");

    const result = await cache.get("wt", CacheStrategy.WRITE_THROUGH_REDIS);
    expect(result.hit).toBe(true);
    expect(result.value).toEqual({ id: 7 });
    // Cache repopulated from storage
    expect(await raw.get("cache:wt")).not.toBeNull();
  });

  it("write-behind queues and drains with client-side JSON payloads", async () => {
    await cache.set("wb1", "a", CacheStrategy.WRITE_BEHIND_REDIS);
    await cache.set("wb2", "b", CacheStrategy.WRITE_BEHIND_REDIS);
    await cache.set("wb3", "c", CacheStrategy.WRITE_BEHIND_REDIS);
    expect(await raw.llen("write_queue")).toBe(3);

    const processed = await cache.processWriteBehindQueue(2);
    expect(processed).toBe(2);
    expect(await raw.llen("write_queue")).toBe(1);

    await cache.processWriteBehindQueue(10);
    expect(await raw.llen("write_queue")).toBe(0);
    expect(await raw.get("storage:wb1")).toBe(JSON.stringify("a"));
  });

  it("clear() uses non-blocking SCAN when available and removes cache + storage keys", async () => {
    const scanSpy = jest.spyOn(raw, "scan");
    await cache.set("c1", "v", CacheStrategy.TTL_REDIS);
    await cache.set("c2", "v", CacheStrategy.WRITE_THROUGH_REDIS);

    await cache.clear();

    expect(scanSpy).toHaveBeenCalled(); // SCAN path, not the O(N) blocking KEYS
    expect(await raw.get("cache:c1")).toBeNull();
    expect(await raw.get("cache:c2")).toBeNull();
    expect(await raw.get("storage:c2")).toBeNull();
  });

  it("throws loudly for unsupported strategies instead of masquerading as a miss", async () => {
    await expect(cache.get("k", "nope" as CacheStrategy)).rejects.toThrow(
      "Unsupported Redis cache strategy"
    );
    await expect(cache.set("k", "v", "nope" as CacheStrategy)).rejects.toThrow(
      "Unsupported Redis cache strategy"
    );
  });
});

describe("🧪 Memory uplift regressions", () => {
  it("LFU evicts correctly under churn with hot keys protected (O(1) bucket scheme)", async () => {
    const cache = new LFUMemoryCache<string>(50);
    for (let i = 0; i < 50; i++) await cache.set(`k${i}`, "v");
    // Heat up 10 keys
    for (let round = 0; round < 3; round++) {
      for (let i = 0; i < 10; i++) await cache.get(`k${i}`);
    }
    // Churn 100 fresh keys through the full cache
    for (let i = 100; i < 200; i++) await cache.set(`c${i}`, "v");

    // Hot keys survive: cold ones were the eviction victims
    for (let i = 0; i < 10; i++) {
      expect((await cache.get(`k${i}`)).hit).toBe(true);
    }
    expect(cache.getStats().size).toBe(50);
  });

  it("LFU breaks frequency ties least-recently-used first (behavior parity)", async () => {
    const cache = new LFUMemoryCache<string>(3);
    await cache.set("a", "v", undefined, 1000);
    await cache.set("b", "v", undefined, 2000);
    await cache.set("c", "v", undefined, 3000);
    // Equal frequency 1 for all; refresh recency: a most recent
    await cache.get("b", 4000);
    await cache.get("c", 5000);
    await cache.get("a", 6000);

    await cache.set("d", "v", undefined, 7000); // evicts LRU of the min bucket: b

    expect((await cache.get("b")).hit).toBe(false);
    expect((await cache.get("a")).hit).toBe(true);
    expect((await cache.get("c")).hit).toBe(true);
  });

  it("memoryUsage no longer inflates on overwrites", async () => {
    const cache = new LRUMemoryCache<string>(100);
    await cache.set("k", "x".repeat(100));
    const single = cache.getStats().memoryUsage ?? 0;

    for (let i = 0; i < 99; i++) await cache.set("k", "x".repeat(100));

    // Old code never released the overwritten entry's bytes -> ~100x inflation
    expect(cache.getStats().memoryUsage).toBe(single);
    expect(cache.getStats().size).toBe(1);
  });

  it("memoryUsage is released when an entry lazily expires on get", async () => {
    const cache = new LRUMemoryCache<string>(100);
    await cache.set("temp", "x".repeat(500), 10, 1000);
    expect(cache.getStats().memoryUsage).toBeGreaterThan(0);

    const result = await cache.get("temp", 5000); // past expiry
    expect(result.hit).toBe(false);
    expect(cache.getStats().memoryUsage).toBe(0);
  });

  it("FIFO overwrite moves the key to the back of the eviction order (parity)", async () => {
    const cache = new FIFOMemoryCache<string>(3);
    await cache.set("a", "1");
    await cache.set("b", "2");
    await cache.set("c", "3");
    await cache.set("a", "1-again"); // re-set: moves to back, like the old side-array did

    await cache.set("d", "4"); // evicts b (now the oldest)

    expect((await cache.get("b")).hit).toBe(false);
    expect((await cache.get("a")).hit).toBe(true);
  });

  it("TTL cache destroy() releases the cleanup timer and is idempotent", () => {
    const cache = new TTLMemoryCache<string>(10, 1000);
    cache.destroy();
    cache.destroy(); // second call must not throw
    // No assertion on internals needed: the perf suite in cache.test.ts now
    // running without --forceExit is the observable proof the handle is gone.
    expect(true).toBe(true);
  });

  it("TTL capacity eviction removes the oldest-created entry in O(1)", async () => {
    const cache = new TTLMemoryCache<string>(3, 60000);
    await cache.set("a", "1", undefined, 1000);
    await cache.set("b", "2", undefined, 2000);
    await cache.set("c", "3", undefined, 3000);
    await cache.set("d", "4", undefined, 4000); // evicts a (oldest createdAt)

    expect((await cache.get("a")).hit).toBe(false);
    expect((await cache.get("d")).hit).toBe(true);
    expect(cache.getStats().size).toBe(3);
    cache.destroy();
  });
});

describe("🧪 Manager uplift regressions", () => {
  const l1Config = {
    strategy: CacheStrategy.LRU_MEMORY,
    maxSize: 100,
    defaultTtl: 60000,
    enableStats: true,
  };
  const l2Config = {
    strategy: CacheStrategy.LRU_REDIS,
    maxSize: 1000,
    defaultTtl: 300000,
    enableStats: true,
  };

  it("combined hit rate counts an L1-miss/L2-hit as one successful request (was 50%)", async () => {
    const { client } = newRedis();
    const manager = createMultiLevelCacheManager(
      { l1: l1Config, l2: l2Config, promoteOnHit: false, writeThrough: true },
      client
    );

    await manager.set("key", "value");
    clearMemoryCacheStorage(); // force the L1 miss, keep L2 intact

    const result = await manager.get("key");
    expect(result.hit).toBe(true); // served from L2

    const stats = await manager.getStats();
    // One request, one effective hit: 100%. The old formula reported 50%.
    expect(stats.combined.hitRate).toBe(100);
    expect(stats.combined.misses).toBe(0);
  });

  it("set with an explicit undefined ttl falls back to defaultTtl", async () => {
    const manager = createCacheManager(l1Config);
    await manager.set("k", "v", { ttl: undefined });

    const result = await manager.get("k");
    expect(result.hit).toBe(true);
    // defaultTtl applied -> a concrete remaining TTL is reported
    expect(result.ttl).toBeGreaterThan(0);
    expect(result.ttl).toBeLessThanOrEqual(60000);
  });

  it("manager get/set throw loudly for unsupported strategies", async () => {
    const manager = createCacheManager({ ...l1Config, strategy: "bogus" as CacheStrategy });
    await expect(manager.get("k")).rejects.toThrow("Unsupported cache strategy");
  });
});
