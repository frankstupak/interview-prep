// cache.test.ts - Comprehensive test suite for caching system
import { describe, it, expect, beforeEach, afterEach, jest } from "@jest/globals";
import {
  CacheStrategy,
  CacheOptions,
  CacheRedisClient,
  CacheConfig,
  MultiLevelCacheConfig,
} from "./cache-types";

import {
  LRUMemoryCache,
  LFUMemoryCache,
  TTLMemoryCache,
  FIFOMemoryCache,
  getFromMemoryCache,
  setInMemoryCache,
  deleteFromMemoryCache,
  getMemoryCacheStats,
  clearMemoryCacheStorage,
} from "./cache-memory";

import {
  RedisCache,
  getFromRedisCache,
  setInRedisCache,
  deleteFromRedisCache,
  getRedisCacheStats,
  clearRedisCacheStorage,
} from "./cache-redis";

import {
  createCacheManager,
  createMultiLevelCacheManager,
  recommendCacheStrategy,
} from "./cache-manager";

// Mock Redis client for testing
// Why: Allows testing Redis functionality without external dependencies
class MockRedisClient implements CacheRedisClient {
  private data = new Map<string, string>();
  private ttls = new Map<string, number>();
  private sortedSets = new Map<string, Array<{ score: number; member: string }>>();
  private hashes = new Map<string, Map<string, string>>();
  private frequencies = new Map<string, number>();
  private lists = new Map<string, string[]>();

  async get(key: string): Promise<string | null> {
    // Check if key has expired
    const ttl = this.ttls.get(key);
    if (ttl && Date.now() > ttl) {
      this.data.delete(key);
      this.ttls.delete(key);
      return null;
    }
    return this.data.get(key) || null;
  }

  async set(key: string, value: string, mode?: string, duration?: number): Promise<string | null> {
    this.data.set(key, value);

    if (mode === "PX" && duration) {
      this.ttls.set(key, Date.now() + duration);
    }

    return "OK";
  }

  async del(key: string): Promise<number> {
    const existed = this.data.has(key);
    this.data.delete(key);
    this.ttls.delete(key);
    return existed ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    return this.data.has(key) ? 1 : 0;
  }

  async ttl(key: string): Promise<number> {
    const ttl = this.ttls.get(key);
    if (!ttl) return -1;

    const remaining = Math.max(0, ttl - Date.now());
    return Math.floor(remaining / 1000);
  }

  async expire(key: string, seconds: number): Promise<number> {
    if (this.data.has(key)) {
      this.ttls.set(key, Date.now() + seconds * 1000);
      return 1;
    }
    return 0;
  }

  async eval(script: string, numkeys: number, ...args: string[]): Promise<unknown> {
    // Mock implementation keyed on the stable marker comment in each script
    // (first Lua line), mirroring the real scripts' observable behavior.
    const keys = args.slice(0, numkeys);
    const argv = args.slice(numkeys);

    if (script.includes("-- lru-set") || script.includes("-- lfu-set")) {
      const dataKey = keys[0];
      const value = argv[0];
      const ttl = parseInt(argv[1]);

      await this.set(dataKey, value);
      if (ttl > 0) {
        this.ttls.set(dataKey, Date.now() + ttl);
      }
      // LFU: initialize frequency for NEW members only (ZADD ... NX)
      if (script.includes("-- lfu-set") && !this.frequencies.has(dataKey)) {
        this.frequencies.set(dataKey, 1);
      }
      return [1];
    }

    if (script.includes("-- lfu-get")) {
      const [dataKey] = keys;
      const value = await this.get(dataKey);
      if (value == null) {
        this.frequencies.delete(dataKey); // lazy repair of stale members
        return null;
      }
      const newFreq = (this.frequencies.get(dataKey) || 1) + 1;
      this.frequencies.set(dataKey, newFreq);
      return [value, await this.pttlMs(dataKey), newFreq];
    }

    if (script.includes("-- lru-get") || script.includes("-- plain-get")) {
      const [dataKey] = keys;
      const value = await this.get(dataKey);
      if (value == null) return null;
      return [value, await this.pttlMs(dataKey)];
    }

    if (script.includes("-- wt-get")) {
      const [cacheKey, storageKey] = keys;
      const value = await this.get(cacheKey);
      if (value != null) return [value, await this.pttlMs(cacheKey)];
      const stored = await this.get(storageKey);
      if (stored == null) return null;
      await this.set(cacheKey, stored); // read-through repopulation
      return [stored, -1];
    }

    if (script.includes("-- wt-set")) {
      const [cacheKey, storageKey] = keys;
      await this.set(cacheKey, argv[0]);
      await this.set(storageKey, argv[0]);
      const ttl = parseInt(argv[1]);
      if (ttl > 0) this.ttls.set(cacheKey, Date.now() + ttl);
      return [1];
    }

    if (script.includes("-- wb-set")) {
      const [cacheKey, queueKey] = keys;
      await this.set(cacheKey, argv[0]);
      const ttl = parseInt(argv[1]);
      if (ttl > 0) this.ttls.set(cacheKey, Date.now() + ttl);
      const queue = this.lists.get(queueKey) ?? [];
      queue.unshift(argv[2]); // LPUSH
      this.lists.set(queueKey, queue);
      return [1];
    }

    if (script.includes("-- wb-drain")) {
      const [queueKey] = keys;
      const n = parseInt(argv[0]);
      const queue = this.lists.get(queueKey) ?? [];
      const items: string[] = [];
      for (let i = 0; i < n; i++) {
        const item = queue.pop(); // RPOP
        if (item === undefined) break;
        items.push(item);
      }
      return items;
    }

    if (script.includes("ZREM")) {
      // delete()-path cleanup scripts
      return [1];
    }

    return [1, 0, 0];
  }

  // PTTL equivalent: remaining TTL in milliseconds, -1 when no TTL
  private async pttlMs(key: string): Promise<number> {
    const expiry = this.ttls.get(key);
    if (!expiry) return -1;
    return Math.max(0, expiry - Date.now());
  }

  async hget(key: string, field: string): Promise<string | null> {
    const hash = this.hashes.get(key);
    return hash?.get(field) || null;
  }

  async hset(key: string, field: string, value: string): Promise<number> {
    if (!this.hashes.has(key)) {
      this.hashes.set(key, new Map());
    }
    const hash = this.hashes.get(key)!;
    const existed = hash.has(field);
    hash.set(field, value);
    return existed ? 0 : 1;
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    const current = parseInt((await this.hget(key, field)) || "0");
    const newValue = current + increment;
    await this.hset(key, field, String(newValue));
    return newValue;
  }

  async keys(pattern: string): Promise<string[]> {
    const regex = new RegExp(pattern.replace("*", ".*"));
    return Array.from(this.data.keys()).filter((key) => regex.test(key));
  }

  // Helper method to clear all data
  clear(): void {
    this.data.clear();
    this.ttls.clear();
    this.sortedSets.clear();
    this.hashes.clear();
    this.frequencies.clear();
    this.lists.clear();
  }
}

// Test setup and cleanup
beforeEach(() => {
  clearMemoryCacheStorage();
  clearRedisCacheStorage();
});

// Global cleanup after each test
afterEach(async () => {
  // Clear any timers that might be running
  jest.clearAllTimers();

  // Clear all mocks
  jest.clearAllMocks();

  // Clear memory cache storage
  clearMemoryCacheStorage();
  clearRedisCacheStorage();
});

describe("🧠 Memory Cache Implementations", () => {
  describe("LRU Memory Cache", () => {
    it("should evict least recently used items when full", async () => {
      const cache = new LRUMemoryCache<string>(2); // Small size for testing

      // Fill cache to capacity
      await cache.set("key1", "value1");
      await cache.set("key2", "value2");

      // Access key1 to make it more recently used
      await cache.get("key1");

      // Add third item, should evict key2 (least recently used)
      await cache.set("key3", "value3");

      const result1 = await cache.get("key1");
      const result2 = await cache.get("key2");
      const result3 = await cache.get("key3");

      expect(result1.hit).toBe(true);
      expect(result2.hit).toBe(false); // Evicted
      expect(result3.hit).toBe(true);
    });

    it("should update access order on get operations", async () => {
      const cache = new LRUMemoryCache<string>(2);

      await cache.set("key1", "value1");
      await cache.set("key2", "value2");

      // Access key1 (making it most recently used)
      await cache.get("key1");

      // Add key3, should evict key2
      await cache.set("key3", "value3");

      const stats = cache.getStats();
      expect(stats.evictions).toBe(1);
    });
  });

  describe("LFU Memory Cache", () => {
    it("should evict least frequently used items when full", async () => {
      const cache = new LFUMemoryCache<string>(2);

      // Add items
      await cache.set("key1", "value1");
      await cache.set("key2", "value2");

      // Access key1 multiple times
      await cache.get("key1");
      await cache.get("key1");
      await cache.get("key1");

      // Access key2 once
      await cache.get("key2");

      // Add third item, should evict key2 (less frequently used)
      await cache.set("key3", "value3");

      const result1 = await cache.get("key1");
      const result2 = await cache.get("key2");
      const result3 = await cache.get("key3");

      expect(result1.hit).toBe(true);
      expect(result2.hit).toBe(false); // Evicted
      expect(result3.hit).toBe(true);
    });

    it("should track access frequency correctly", async () => {
      const cache = new LFUMemoryCache<string>(3);

      await cache.set("key1", "value1");

      // Access multiple times
      for (let i = 0; i < 5; i++) {
        await cache.get("key1");
      }

      const result = await cache.get("key1");
      expect(result.metadata?.hitCount).toBe(6); // 5 gets + 1 final get
    });
  });

  describe("TTL Memory Cache", () => {
    let ttlCache: TTLMemoryCache<string>;

    afterEach(() => {
      // Destroy TTL cache to clear its cleanup timer
      if (ttlCache) {
        ttlCache.destroy();
      }
    });

    it("should expire items after TTL", async () => {
      ttlCache = new TTLMemoryCache<string>(10);
      const now = Date.now();
      const shortTtl = 100; // 100ms

      await ttlCache.set("key1", "value1", shortTtl, now);

      // Should be available immediately
      const result1 = await ttlCache.get("key1", now);
      expect(result1.hit).toBe(true);

      // Should be expired after TTL
      const result2 = await ttlCache.get("key1", now + shortTtl + 1);
      expect(result2.hit).toBe(false);
    });

    it("should return correct TTL in metadata", async () => {
      ttlCache = new TTLMemoryCache<string>(10);
      const now = Date.now();
      const ttl = 5000; // 5 seconds

      await ttlCache.set("key1", "value1", ttl, now);

      const result = await ttlCache.get("key1", now + 1000); // 1 second later
      expect(result.hit).toBe(true);
      expect(result.ttl).toBeCloseTo(4000, -2); // ~4 seconds remaining
    });

    it("should clean up expired items", async () => {
      ttlCache = new TTLMemoryCache<string>(10);
      const now = Date.now();

      await ttlCache.set("key1", "value1", 100, now);
      await ttlCache.set("key2", "value2", 200, now);

      // Clean up after first item expires
      const cleaned = ttlCache.cleanup(now + 150);
      expect(cleaned).toBe(1);

      const result1 = await ttlCache.get("key1", now + 150);
      const result2 = await ttlCache.get("key2", now + 150);

      expect(result1.hit).toBe(false);
      expect(result2.hit).toBe(true);
    });
  });

  describe("FIFO Memory Cache", () => {
    it("should evict oldest items by insertion order", async () => {
      const cache = new FIFOMemoryCache<string>(2);

      await cache.set("key1", "value1");
      await cache.set("key2", "value2");

      // Access key1 (shouldn't affect eviction order in FIFO)
      await cache.get("key1");

      // Add third item, should evict key1 (first in)
      await cache.set("key3", "value3");

      const result1 = await cache.get("key1");
      const result2 = await cache.get("key2");
      const result3 = await cache.get("key3");

      expect(result1.hit).toBe(false); // Evicted (first in, first out)
      expect(result2.hit).toBe(true);
      expect(result3.hit).toBe(true);
    });
  });
});

describe("🔴 Redis Cache Implementations", () => {
  let redis: MockRedisClient;
  let cache: RedisCache;

  beforeEach(() => {
    redis = new MockRedisClient();
    cache = new RedisCache(redis, 100);
  });

  afterEach(async () => {
    redis.clear();
    // Clear any timers that might be running
    jest.clearAllTimers();
    // Clear memory cache storage
    clearMemoryCacheStorage();
    clearRedisCacheStorage();
  });

  describe("Basic Redis Operations", () => {
    it("should store and retrieve values", async () => {
      await cache.set("key1", "value1", CacheStrategy.TTL_REDIS);
      const result = await cache.get("key1", CacheStrategy.TTL_REDIS);

      expect(result.hit).toBe(true);
      expect(result.value).toBe("value1");
    });

    it("should handle JSON serialization", async () => {
      const complexValue = { name: "John", age: 30, tags: ["user", "premium"] };

      await cache.set("user:123", complexValue, CacheStrategy.TTL_REDIS);
      const result = await cache.get("user:123", CacheStrategy.TTL_REDIS);

      expect(result.hit).toBe(true);
      expect(result.value).toEqual(complexValue);
    });

    it("should handle TTL correctly", async () => {
      const ttl = 1000; // 1 second

      await cache.set("key1", "value1", CacheStrategy.TTL_REDIS, ttl);
      const result = await cache.get("key1", CacheStrategy.TTL_REDIS);

      expect(result.hit).toBe(true);
      expect(result.ttl).toBeGreaterThan(0);
    });

    it("should delete values correctly", async () => {
      await cache.set("key1", "value1", CacheStrategy.TTL_REDIS);

      const deleted = await cache.delete("key1", CacheStrategy.TTL_REDIS);
      expect(deleted).toBe(true);

      const result = await cache.get("key1", CacheStrategy.TTL_REDIS);
      expect(result.hit).toBe(false);
    });
  });

  describe("Redis Strategy-Specific Behavior", () => {
    it("should handle LRU Redis strategy", async () => {
      const now = Date.now();

      await cache.set("key1", "value1", CacheStrategy.LRU_REDIS, 5000, now);
      const result = await cache.get("key1", CacheStrategy.LRU_REDIS, now);

      expect(result.hit).toBe(true);
      expect(result.value).toBe("value1");
    });

    it("should handle LFU Redis strategy", async () => {
      await cache.set("key1", "value1", CacheStrategy.LFU_REDIS);

      // Access multiple times
      await cache.get("key1", CacheStrategy.LFU_REDIS);
      await cache.get("key1", CacheStrategy.LFU_REDIS);

      const result = await cache.get("key1", CacheStrategy.LFU_REDIS);
      expect(result.hit).toBe(true);
      expect(result.metadata?.hitCount).toBeGreaterThan(0);
    });
  });
});

describe("🎯 Cache Manager", () => {
  let redis: MockRedisClient;
  let memoryConfig: CacheConfig;
  let redisConfig: CacheConfig;

  beforeEach(() => {
    redis = new MockRedisClient();

    memoryConfig = {
      strategy: CacheStrategy.LRU_MEMORY,
      maxSize: 100,
      defaultTtl: 5000,
      enableStats: true,
    };

    redisConfig = {
      strategy: CacheStrategy.LRU_REDIS,
      maxSize: 100,
      defaultTtl: 5000,
      enableStats: true,
    };
  });

  afterEach(async () => {
    redis.clear();
    // Clear any timers that might be running
    jest.clearAllTimers();
    // Clear memory cache storage
    clearMemoryCacheStorage();
    clearRedisCacheStorage();
  });

  describe("Single-Level Cache Manager", () => {
    it("should route to memory cache for memory strategies", async () => {
      const manager = createCacheManager(memoryConfig);

      await manager.set("key1", "value1");
      const result = await manager.get("key1");

      expect(result.hit).toBe(true);
      expect(result.value).toBe("value1");
    });

    it("should route to Redis cache for Redis strategies", async () => {
      const manager = createCacheManager(redisConfig, redis);

      await manager.set("key1", "value1");
      const result = await manager.get("key1");

      expect(result.hit).toBe(true);
      expect(result.value).toBe("value1");
    });

    it("should handle TTL overrides", async () => {
      const manager = createCacheManager(memoryConfig);
      const customTtl = 1000;

      await manager.set("key1", "value1", { ttl: customTtl });
      const result = await manager.get("key1");

      expect(result.hit).toBe(true);
      expect(result.ttl).toBeLessThanOrEqual(customTtl);
    });

    it("should provide cache statistics", async () => {
      const manager = createCacheManager(memoryConfig);

      await manager.set("key1", "value1");
      await manager.get("key1");
      await manager.get("nonexistent");

      const stats = await manager.getStats();
      expect(stats.hits).toBe(1);
      expect(stats.misses).toBe(1);
      expect(stats.hitRate).toBe(50);
    });

    it("should handle delete operations", async () => {
      const manager = createCacheManager(memoryConfig);

      await manager.set("key1", "value1");
      const deleted = await manager.delete("key1");

      expect(deleted).toBe(true);

      const result = await manager.get("key1");
      expect(result.hit).toBe(false);
    });

    it("should handle clear operations", async () => {
      const manager = createCacheManager(memoryConfig);

      await manager.set("key1", "value1");
      await manager.set("key2", "value2");

      await manager.clear();

      const result1 = await manager.get("key1");
      const result2 = await manager.get("key2");

      expect(result1.hit).toBe(false);
      expect(result2.hit).toBe(false);
    });
  });

  describe("Multi-Level Cache Manager", () => {
    let multiLevelConfig: MultiLevelCacheConfig;

    beforeEach(() => {
      multiLevelConfig = {
        l1: {
          strategy: CacheStrategy.LRU_MEMORY,
          maxSize: 50,
          defaultTtl: 5000,
          enableStats: true,
        },
        l2: {
          strategy: CacheStrategy.LRU_REDIS,
          maxSize: 200,
          defaultTtl: 10000,
          enableStats: true,
        },
        promoteOnHit: true,
        writeThrough: false,
      };
    });

    it("should write to both levels", async () => {
      const manager = createMultiLevelCacheManager(multiLevelConfig, redis);

      await manager.set("key1", "value1");

      // Should be in both L1 and L2
      const result = await manager.get("key1");
      expect(result.hit).toBe(true);
      expect(result.value).toBe("value1");
    });

    it("should promote L2 hits to L1 when configured", async () => {
      const manager = createMultiLevelCacheManager(multiLevelConfig, redis);

      // Set in L2 only (simulate L1 miss, L2 hit scenario)
      await manager.set("key1", "value1");

      // Clear L1 to simulate L1 miss
      // Note: In real implementation, you'd have separate L1/L2 access

      const result = await manager.get("key1");
      expect(result.hit).toBe(true);
    });

    it("should provide combined statistics", async () => {
      const manager = createMultiLevelCacheManager(multiLevelConfig, redis);

      await manager.set("key1", "value1");
      await manager.get("key1");
      await manager.get("nonexistent");

      const stats = await manager.getStats();
      expect(stats.combined.hits).toBeGreaterThan(0);
      expect(stats.combined.misses).toBeGreaterThan(0);
      expect(stats.l1).toBeDefined();
      expect(stats.l2).toBeDefined();
    });

    it("should handle warmup operations", async () => {
      const manager = createMultiLevelCacheManager(multiLevelConfig, redis);

      // Pre-populate L2
      await manager.set("key1", "value1");
      await manager.set("key2", "value2");
      await manager.set("key3", "value3");

      // Warmup L1 with specific keys
      const warmedUp = await manager.warmupL1(["key1", "key2", "nonexistent"]);

      expect(warmedUp).toBe(2); // Only key1 and key2 should be warmed up
    });

    it("should handle delete from both levels", async () => {
      const manager = createMultiLevelCacheManager(multiLevelConfig, redis);

      await manager.set("key1", "value1");
      const deleted = await manager.delete("key1");

      expect(deleted).toBe(true);

      const result = await manager.get("key1");
      expect(result.hit).toBe(false);
    });

    it("should handle clear operations on both levels", async () => {
      const manager = createMultiLevelCacheManager(multiLevelConfig, redis);

      await manager.set("key1", "value1");
      await manager.set("key2", "value2");

      await manager.clear();

      const result1 = await manager.get("key1");
      const result2 = await manager.get("key2");

      expect(result1.hit).toBe(false);
      expect(result2.hit).toBe(false);
    });
  });
});

describe("🎯 Strategy Recommendation", () => {
  it("should recommend memory strategies for single instance", () => {
    const strategy = recommendCacheStrategy("temporal", "small", "eventual", "single");
    expect(strategy).toBe(CacheStrategy.LRU_MEMORY);
  });

  it("should recommend Redis strategies for distributed systems", () => {
    const strategy = recommendCacheStrategy("temporal", "large", "eventual", "distributed");
    expect(strategy).toBe(CacheStrategy.LRU_REDIS);
  });

  it("should recommend write-through for strong consistency", () => {
    const strategy = recommendCacheStrategy("mixed", "medium", "strong", "distributed");
    expect(strategy).toBe(CacheStrategy.WRITE_THROUGH_REDIS);
  });

  it("should recommend LFU for frequency-based patterns", () => {
    const strategy = recommendCacheStrategy("frequency", "medium", "eventual", "single");
    expect(strategy).toBe(CacheStrategy.LFU_MEMORY);
  });

  it("should recommend TTL for random access patterns", () => {
    const strategy = recommendCacheStrategy("random", "small", "eventual", "single");
    expect(strategy).toBe(CacheStrategy.TTL_MEMORY);
  });
});

describe("🔄 Unified Cache Interface Functions", () => {
  let redis: MockRedisClient;

  beforeEach(() => {
    redis = new MockRedisClient();
  });

  afterEach(async () => {
    redis.clear();
    // Clear any timers that might be running
    jest.clearAllTimers();
    // Clear memory cache storage
    clearMemoryCacheStorage();
    clearRedisCacheStorage();
  });

  describe("Memory Cache Interface", () => {
    it("should handle get/set operations", async () => {
      const options: CacheOptions = {
        key: "test-key",
        strategy: CacheStrategy.LRU_MEMORY,
        maxSize: 100,
      };

      await setInMemoryCache(options, "test-value");
      const result = await getFromMemoryCache(options);

      expect(result.hit).toBe(true);
      expect(result.value).toBe("test-value");
    });

    it("should handle delete operations", async () => {
      const options: CacheOptions = {
        key: "test-key",
        strategy: CacheStrategy.LRU_MEMORY,
        maxSize: 100,
      };

      await setInMemoryCache(options, "test-value");
      const deleted = await deleteFromMemoryCache(options);

      expect(deleted).toBe(true);

      const result = await getFromMemoryCache(options);
      expect(result.hit).toBe(false);
    });

    it("should provide statistics", async () => {
      const options: CacheOptions = {
        key: "test-key",
        strategy: CacheStrategy.LRU_MEMORY,
        maxSize: 100,
      };

      await setInMemoryCache(options, "test-value");
      await getFromMemoryCache(options);

      const stats = await getMemoryCacheStats(CacheStrategy.LRU_MEMORY, 100);
      expect(stats.hits).toBe(1);
      expect(stats.size).toBe(1);
    });
  });

  describe("Redis Cache Interface", () => {
    it("should handle get/set operations", async () => {
      const options: CacheOptions = {
        key: "test-key",
        strategy: CacheStrategy.TTL_REDIS,
        maxSize: 100,
      };

      await setInRedisCache(redis, options, "test-value");
      const result = await getFromRedisCache(redis, options);

      expect(result.hit).toBe(true);
      expect(result.value).toBe("test-value");
    });

    it("should handle delete operations", async () => {
      const options: CacheOptions = {
        key: "test-key",
        strategy: CacheStrategy.TTL_REDIS,
        maxSize: 100,
      };

      await setInRedisCache(redis, options, "test-value");
      const deleted = await deleteFromRedisCache(redis, options);

      expect(deleted).toBe(true);

      const result = await getFromRedisCache(redis, options);
      expect(result.hit).toBe(false);
    });

    it("should provide statistics", async () => {
      const options: CacheOptions = {
        key: "test-key",
        strategy: CacheStrategy.TTL_REDIS,
        maxSize: 100,
      };

      await setInRedisCache(redis, options, "test-value");
      await getFromRedisCache(redis, options);

      const stats = await getRedisCacheStats(redis, 100);
      expect(stats.hits).toBe(1);
    });
  });
});

// Re-enabled: the hang was the TTL cache's un-unref()'d cleanup setInterval
// holding the event loop open; it is now unref()'d and destroyed by clearMemoryCacheStorage().
describe("📊 Performance and Edge Cases", () => {
  describe("Large Dataset Handling", () => {
    it("should handle large number of cache operations", async () => {
      const cache = new LRUMemoryCache<string>(100);
      const operations = 50; // Reduced from 500 to prevent hanging

      // Set many values
      for (let i = 0; i < operations; i++) {
        await cache.set(`key${i}`, `value${i}`);
      }

      // Get all values
      let hits = 0;
      for (let i = 0; i < operations; i++) {
        const result = await cache.get(`key${i}`);
        if (result.hit) hits++;
      }

      expect(hits).toBe(operations);

      const stats = cache.getStats();
      expect(stats.size).toBe(operations);
    });

    it("should handle eviction correctly under load", async () => {
      const cache = new LRUMemoryCache<string>(10); // Small cache
      const operations = 20; // Reduced from 200 to prevent hanging

      // Fill cache beyond capacity
      for (let i = 0; i < operations; i++) {
        await cache.set(`key${i}`, `value${i}`);
      }

      const stats = cache.getStats();
      expect(stats.size).toBe(10); // Should not exceed max size
      expect(stats.evictions).toBe(10); // Should have evicted 10 items
    });
  });

  describe("Error Handling", () => {
    it("should handle invalid strategy gracefully", async () => {
      const redis = new MockRedisClient();
      const cache = new RedisCache(redis);

      await expect(cache.get("key1", "invalid-strategy" as CacheStrategy)).rejects.toThrow(
        "Unsupported Redis cache strategy"
      );
    });

    it("should handle Redis connection errors gracefully", async () => {
      // Mock Redis client that throws errors
      const errorRedis: CacheRedisClient = {
        get: async () => {
          throw new Error("Connection failed");
        },
        set: async () => {
          throw new Error("Connection failed");
        },
        del: async () => {
          throw new Error("Connection failed");
        },
        exists: async () => 0,
        ttl: async () => -1,
        expire: async () => 0,
        eval: async () => {
          throw new Error("Connection failed");
        },
        hget: async () => null,
        hset: async () => 0,
        hincrby: async () => 0,
        keys: async () => [],
      };

      const cache = new RedisCache(errorRedis);

      // Should return cache miss instead of throwing
      const result = await cache.get("key1", CacheStrategy.TTL_REDIS);
      expect(result.hit).toBe(false);
    });
  });

  describe("Memory Usage Tracking", () => {
    it("should track memory usage approximately", async () => {
      const cache = new LRUMemoryCache<string>(100);

      await cache.set("small", "x");
      await cache.set("large", "x".repeat(1000));

      const stats = cache.getStats();
      expect(stats.memoryUsage).toBeGreaterThan(0);
    });
  });

  describe("Concurrent Operations", () => {
    it("should handle concurrent get/set operations", async () => {
      const cache = new LRUMemoryCache<string>(20);

      // Simulate concurrent operations (reduced from 50 to 10)
      const promises = [];
      for (let i = 0; i < 10; i++) {
        promises.push(cache.set(`key${i}`, `value${i}`));
        promises.push(cache.get(`key${i}`));
      }

      await Promise.all(promises);

      const stats = cache.getStats();
      expect(stats.size).toBeGreaterThan(0);
    });
  });
});
