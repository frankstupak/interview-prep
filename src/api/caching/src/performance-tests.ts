// performance-tests.ts - Performance benchmarks for caching strategies
import { describe, it, expect, beforeEach, afterEach } from "@jest/globals";
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

// Mock Redis client for performance testing
class MockRedisClient implements CacheRedisClient {
  private data = new Map<string, string>();
  private ttls = new Map<string, number>();

  async get(key: string): Promise<string | null> {
    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 0.1));

    const ttl = this.ttls.get(key);
    if (ttl && Date.now() > ttl) {
      this.data.delete(key);
      this.ttls.delete(key);
      return null;
    }
    return this.data.get(key) || null;
  }

  async set(key: string, value: string, mode?: string, duration?: number): Promise<string | null> {
    // Simulate network latency
    await new Promise((resolve) => setTimeout(resolve, 0.1));

    this.data.set(key, value);
    if (mode === "PX" && duration) {
      this.ttls.set(key, Date.now() + duration);
    }
    return "OK";
  }

  async del(key: string): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 0.1));
    const existed = this.data.has(key);
    this.data.delete(key);
    this.ttls.delete(key);
    return existed ? 1 : 0;
  }

  async exists(key: string): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 0.1));
    return this.data.has(key) ? 1 : 0;
  }

  async ttl(key: string): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 0.1));
    const ttl = this.ttls.get(key);
    if (!ttl) return -1;
    const remaining = Math.max(0, ttl - Date.now());
    return Math.floor(remaining / 1000);
  }

  async expire(key: string, seconds: number): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 0.1));
    if (this.data.has(key)) {
      this.ttls.set(key, Date.now() + seconds * 1000);
      return 1;
    }
    return 0;
  }

  async eval(_script: string, _numkeys: number, ..._args: string[]): Promise<unknown> {
    await new Promise((resolve) => setTimeout(resolve, 0.2)); // Lua script overhead
    return [1, 0, 0];
  }

  async hget(_key: string, _field: string): Promise<string | null> {
    await new Promise((resolve) => setTimeout(resolve, 0.1));
    return null;
  }

  async hset(_key: string, _field: string, _value: string): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 0.1));
    return 1;
  }

  async hincrby(key: string, field: string, increment: number): Promise<number> {
    await new Promise((resolve) => setTimeout(resolve, 0.1));
    return increment;
  }

  async keys(_pattern: string): Promise<string[]> {
    await new Promise((resolve) => setTimeout(resolve, 0.5)); // Keys operation is expensive
    return Array.from(this.data.keys());
  }

  clear(): void {
    this.data.clear();
    this.ttls.clear();
  }
}

async function runBenchmark(
  name: string,
  operations: number,
  fn: (i: number) => Promise<void>
): Promise<{
  name: string;
  operations: number;
  totalTimeMs: number;
  avgTimeMs: number;
  opsPerSec: number;
}> {
  if (typeof process.env.CI === "undefined") {
    console.warn(`\n🚀 Running benchmark: ${name}`);
  }

  const start = performance.now();

  for (let i = 0; i < operations; i++) {
    await fn(i);
  }

  const end = performance.now();
  const totalTimeMs = end - start;
  const avgTimeMs = totalTimeMs / operations;
  const opsPerSec = (operations / totalTimeMs) * 1000;

  if (typeof process.env.CI === "undefined") {
    console.warn(`   Operations: ${operations}`);
    console.warn(`   Total time: ${totalTimeMs.toFixed(2)}ms`);
    console.warn(`   Avg time: ${avgTimeMs.toFixed(3)}ms per operation`);
    console.warn(`   Throughput: ${opsPerSec.toFixed(0)} ops/sec`);
  }

  return { name, operations, totalTimeMs, avgTimeMs, opsPerSec };
}

describe("⚡ Performance Benchmarks", () => {
  beforeEach(() => {
    clearMemoryCacheStorage();
    clearRedisCacheStorage();
  });

  describe("Memory Cache Performance", () => {
    const operations = 1000;
    const cacheSize = 500;

    it("should benchmark LRU memory cache", async () => {
      const cache = new LRUMemoryCache<string>(cacheSize);

      // Warm up
      for (let i = 0; i < 100; i++) {
        await cache.set(`warmup${i}`, `value${i}`);
      }

      const setResult = await runBenchmark("LRU Memory - Set Operations", operations, async (i) => {
        await cache.set(`key${i}`, `value${i}`);
      });

      const getResult = await runBenchmark("LRU Memory - Get Operations", operations, async (i) => {
        await cache.get(`key${i % cacheSize}`); // Ensure some hits
      });

      expect(setResult.avgTimeMs).toBeLessThan(1); // Should be very fast
      expect(getResult.avgTimeMs).toBeLessThan(1);
      expect(setResult.opsPerSec).toBeGreaterThan(1000);
      expect(getResult.opsPerSec).toBeGreaterThan(1000);
    });

    it("should benchmark LFU memory cache", async () => {
      const cache = new LFUMemoryCache<string>(cacheSize);

      const setResult = await runBenchmark("LFU Memory - Set Operations", operations, async (i) => {
        await cache.set(`key${i}`, `value${i}`);
      });

      const getResult = await runBenchmark("LFU Memory - Get Operations", operations, async (i) => {
        await cache.get(`key${i % cacheSize}`);
      });

      expect(setResult.avgTimeMs).toBeLessThan(1);
      expect(getResult.avgTimeMs).toBeLessThan(1);
    });

    it("should benchmark TTL memory cache", async () => {
      const cache = new TTLMemoryCache<string>(cacheSize);

      const setResult = await runBenchmark("TTL Memory - Set Operations", operations, async (i) => {
        await cache.set(`key${i}`, `value${i}`, 60000); // 1 minute TTL
      });

      const getResult = await runBenchmark("TTL Memory - Get Operations", operations, async (i) => {
        await cache.get(`key${i % cacheSize}`);
      });

      expect(setResult.avgTimeMs).toBeLessThan(1);
      expect(getResult.avgTimeMs).toBeLessThan(1);
    });

    it("should benchmark FIFO memory cache", async () => {
      const cache = new FIFOMemoryCache<string>(cacheSize);

      const setResult = await runBenchmark(
        "FIFO Memory - Set Operations",
        operations,
        async (i) => {
          await cache.set(`key${i}`, `value${i}`);
        }
      );

      const getResult = await runBenchmark(
        "FIFO Memory - Get Operations",
        operations,
        async (i) => {
          await cache.get(`key${i % cacheSize}`);
        }
      );

      expect(setResult.avgTimeMs).toBeLessThan(1);
      expect(getResult.avgTimeMs).toBeLessThan(1);
    });
  });

  describe("Redis Cache Performance", () => {
    const operations = 100; // Fewer operations due to simulated network latency
    const cacheSize = 50;
    let redis: MockRedisClient;
    let cache: RedisCache;

    beforeEach(() => {
      redis = new MockRedisClient();
      cache = new RedisCache(redis, cacheSize);
    });

    afterEach(() => {
      redis.clear();
    });

    it("should benchmark Redis TTL cache", async () => {
      const setResult = await runBenchmark("Redis TTL - Set Operations", operations, async (i) => {
        await cache.set(`key${i}`, `value${i}`, CacheStrategy.TTL_REDIS, 60000);
      });

      const getResult = await runBenchmark("Redis TTL - Get Operations", operations, async (i) => {
        await cache.get(`key${i % cacheSize}`, CacheStrategy.TTL_REDIS);
      });

      // Redis operations should be slower due to network simulation
      expect(setResult.avgTimeMs).toBeGreaterThan(0.1);
      expect(getResult.avgTimeMs).toBeGreaterThan(0.1);
      expect(setResult.opsPerSec).toBeLessThan(10000); // Much slower than memory
    });

    it("should benchmark Redis LRU cache", async () => {
      const setResult = await runBenchmark("Redis LRU - Set Operations", operations, async (i) => {
        await cache.set(`key${i}`, `value${i}`, CacheStrategy.LRU_REDIS);
      });

      const getResult = await runBenchmark("Redis LRU - Get Operations", operations, async (i) => {
        await cache.get(`key${i % cacheSize}`, CacheStrategy.LRU_REDIS);
      });

      // LRU operations might be slightly slower due to Lua script overhead
      expect(setResult.avgTimeMs).toBeGreaterThan(0.2);
      expect(getResult.avgTimeMs).toBeGreaterThan(0.2);
    });
  });

  describe("Cache Manager Performance", () => {
    const operations = 500;

    it("should benchmark single-level cache manager", async () => {
      const manager = createCacheManager({
        strategy: CacheStrategy.LRU_MEMORY,
        maxSize: 1000,
        defaultTtl: 60000,
        enableStats: true,
      });

      const setResult = await runBenchmark(
        "Cache Manager - Set Operations",
        operations,
        async (i) => {
          await manager.set(`key${i}`, `value${i}`);
        }
      );

      const getResult = await runBenchmark(
        "Cache Manager - Get Operations",
        operations,
        async (i) => {
          await manager.get(`key${i % 500}`);
        }
      );

      expect(setResult.avgTimeMs).toBeLessThan(2); // Small overhead for abstraction
      expect(getResult.avgTimeMs).toBeLessThan(2);
    });

    it("should benchmark multi-level cache manager", async () => {
      const redis = new MockRedisClient();
      const manager = createMultiLevelCacheManager(
        {
          l1: {
            strategy: CacheStrategy.LRU_MEMORY,
            maxSize: 100,
            defaultTtl: 30000,
            enableStats: true,
          },
          l2: {
            strategy: CacheStrategy.LRU_REDIS,
            maxSize: 500,
            defaultTtl: 60000,
            enableStats: true,
          },
          promoteOnHit: true,
          writeThrough: false,
        },
        redis
      );

      await runBenchmark("Multi-Level Cache - Set Operations", operations, async (i) => {
        await manager.set(`key${i}`, `value${i}`);
      });

      const getResult = await runBenchmark(
        "Multi-Level Cache - Get Operations (L1 hits)",
        operations,
        async (i) => {
          await manager.get(`key${i % 100}`); // Should mostly hit L1
        }
      );

      // Multi-level should be fast for L1 hits
      expect(getResult.avgTimeMs).toBeLessThan(5);

      redis.clear();
    });
  });

  describe("Comparative Performance Analysis", () => {
    it("should compare memory cache strategies", async () => {
      const operations = 1000;
      const cacheSize = 500;

      const strategies = [
        { name: "LRU", cache: new LRUMemoryCache<string>(cacheSize) },
        { name: "LFU", cache: new LFUMemoryCache<string>(cacheSize) },
        { name: "TTL", cache: new TTLMemoryCache<string>(cacheSize) },
        { name: "FIFO", cache: new FIFOMemoryCache<string>(cacheSize) },
      ];

      const results = [];

      for (const strategy of strategies) {
        const result = await runBenchmark(`${strategy.name} Comparison`, operations, async (i) => {
          await strategy.cache.set(`key${i}`, `value${i}`);
          await strategy.cache.get(`key${i % cacheSize}`);
        });
        results.push({ strategy: strategy.name, ...result });
      }

      console.warn("\n📊 Memory Cache Strategy Comparison:");
      results.forEach((result) => {
        console.warn(`   ${result.strategy}: ${result.opsPerSec.toFixed(0)} ops/sec`);
      });

      // All memory strategies should be reasonably fast
      results.forEach((result) => {
        expect(result.opsPerSec).toBeGreaterThan(500);
      });
    });

    it("should compare memory vs Redis performance", async () => {
      const operations = 100;
      const redis = new MockRedisClient();

      const memoryCache = new LRUMemoryCache<string>(100);
      const redisCache = new RedisCache(redis, 100);

      const memoryResult = await runBenchmark("Memory Cache Comparison", operations, async (i) => {
        await memoryCache.set(`key${i}`, `value${i}`);
        await memoryCache.get(`key${i}`);
      });

      const redisResult = await runBenchmark("Redis Cache Comparison", operations, async (i) => {
        await redisCache.set(`key${i}`, `value${i}`, CacheStrategy.TTL_REDIS);
        await redisCache.get(`key${i}`, CacheStrategy.TTL_REDIS);
      });

      console.warn("\n📊 Memory vs Redis Performance:");
      console.warn(`   Memory: ${memoryResult.opsPerSec.toFixed(0)} ops/sec`);
      console.warn(`   Redis: ${redisResult.opsPerSec.toFixed(0)} ops/sec`);
      console.warn(
        `   Memory is ${(memoryResult.opsPerSec / redisResult.opsPerSec).toFixed(1)}x faster`
      );

      // Memory should be significantly faster
      expect(memoryResult.opsPerSec).toBeGreaterThan(redisResult.opsPerSec);

      redis.clear();
    });
  });

  describe("Scalability Tests", () => {
    it("should test performance with increasing cache sizes", async () => {
      const operations = 500;
      const cacheSizes = [100, 500, 1000, 5000];

      console.warn("\n📈 Scalability Test - Cache Size vs Performance:");

      for (const size of cacheSizes) {
        const cache = new LRUMemoryCache<string>(size);

        const result = await runBenchmark(`Cache Size ${size}`, operations, async (i) => {
          await cache.set(`key${i}`, `value${i}`);
          if (i % 2 === 0) {
            await cache.get(`key${i % size}`);
          }
        });

        console.warn(`   Size ${size}: ${result.opsPerSec.toFixed(0)} ops/sec`);

        // Performance should remain relatively stable
        expect(result.opsPerSec).toBeGreaterThan(100);
      }
    });

    it("should test performance with increasing operation counts", async () => {
      const cache = new LRUMemoryCache<string>(1000);
      const operationCounts = [100, 500, 1000, 2000];

      console.warn("\n📈 Scalability Test - Operation Count vs Performance:");

      for (const ops of operationCounts) {
        const result = await runBenchmark(`${ops} Operations`, ops, async (i) => {
          await cache.set(`key${i}`, `value${i}`);
          await cache.get(`key${i % 500}`);
        });

        console.warn(`   ${ops} ops: ${result.opsPerSec.toFixed(0)} ops/sec`);

        // Throughput should remain consistent
        expect(result.opsPerSec).toBeGreaterThan(100);
      }
    });
  });

  describe("Memory Usage Analysis", () => {
    it("should analyze memory usage patterns", async () => {
      const cache = new LRUMemoryCache<string>(1000);
      const operations = 500;

      // Fill cache with varying data sizes
      for (let i = 0; i < operations; i++) {
        const dataSize = i % 10 === 0 ? 1000 : 10; // Some large items
        const value = "x".repeat(dataSize);
        await cache.set(`key${i}`, value);
      }

      const stats = cache.getStats();

      console.warn("\n💾 Memory Usage Analysis:");
      console.warn(`   Cache size: ${stats.size} items`);
      console.warn(`   Memory usage: ${stats.memoryUsage || 0} bytes`);
      console.warn(`   Avg item size: ${((stats.memoryUsage || 0) / stats.size).toFixed(1)} bytes`);
      console.warn(`   Hit rate: ${stats.hitRate.toFixed(1)}%`);

      expect(stats.memoryUsage).toBeGreaterThan(0);
      expect(stats.size).toBeLessThanOrEqual(1000);
    });
  });
});
