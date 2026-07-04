// cache-redis.ts - Redis-based cache implementations
// Provides distributed caching with persistence and advanced patterns
//
// Uplift notes (Lumen Industries):
// - Sub-second TTLs no longer crash: SETEX math.floor(ttl/1000) turned any
//   ttl < 1000ms into `SETEX key 0`, which Redis rejects ("invalid expire
//   time"). All scripts now use millisecond-precision SET ... PX / PEXPIRE.
// - LFU set no longer resets a hot key's frequency to 1 on every write
//   (ZADD ... NX preserves the existing score).
// - LRU/LFU order/frequency ZSETs no longer desync from expired data keys:
//   gets lazily ZREM stale members, and capacity enforcement pops members
//   one at a time so phantom (expired) members are purged instead of
//   counting against live keys.
// - Values now round-trip with their types intact: strings were previously
//   stored raw, so set(k, "123") came back as the number 123. Everything is
//   JSON-serialized on write; reads still fall back to raw for legacy data.
// - Falsy-value bug fixed: a cached empty string was reported as a miss.
// - TTL/write-through/write-behind gets are one round trip (GET+PTTL in a
//   single script) instead of two sequential commands.
// - Write-through gets now actually read through: on cache miss the backing
//   storage key is consulted and the cache repopulated.
// - clear() no longer uses KEYS (O(N), blocks the Redis event loop — the
//   documented "never in production" command); it uses cursor-based SCAN
//   when the client supports it, with batched deletes.
// - Write-behind queue batch size is passed as ARGV instead of interpolated
//   into the script source (stable script -> cacheable by SHA, no injection
//   surface), and JSON encoding happens client-side (no cjson dependency).

import {
  CacheStrategy,
  CacheOptions,
  CacheResult,
  CacheStats,
  CacheRedisClient,
  CacheMetadata,
} from "./cache-types";

/**
 * Redis LRU Cache Implementation using Lua scripts
 * Maintains LRU order in Redis with atomic operations
 *
 * Best for: Distributed systems, large datasets, persistence needed
 * Pros: Distributed, persistent, atomic operations
 * Cons: Network latency, more complex than memory
 */
const LRU_REDIS_LUA = `
-- lru-set
-- KEYS[1] = data key, KEYS[2] = access order key
-- ARGV[1] = value, ARGV[2] = ttl (ms), ARGV[3] = max size, ARGV[4] = now timestamp
local dataKey = KEYS[1]
local orderKey = KEYS[2]
local value = ARGV[1]
local ttl = tonumber(ARGV[2])
local maxSize = tonumber(ARGV[3])
local now = tonumber(ARGV[4])

-- Set the value with millisecond TTL if provided (SETEX seconds rounding
-- turned sub-second TTLs into an invalid 0 expire)
if ttl and ttl > 0 then
  redis.call('SET', dataKey, value, 'PX', ttl)
else
  redis.call('SET', dataKey, value)
end

-- Update access order (score = timestamp)
redis.call('ZADD', orderKey, now, dataKey)

-- Enforce max size. Pop the oldest member one at a time: if the member's
-- data key already expired (phantom), removing it frees a slot without
-- touching live data; live members are only evicted while still over cap.
while redis.call('ZCARD', orderKey) > maxSize do
  local oldest = redis.call('ZRANGE', orderKey, 0, 0)
  if #oldest == 0 then break end
  redis.call('ZREM', orderKey, oldest[1])
  redis.call('DEL', oldest[1])
end

return 1
`;

const LRU_GET_REDIS_LUA = `
-- lru-get
-- KEYS[1] = data key, KEYS[2] = access order key
-- ARGV[1] = now timestamp
local dataKey = KEYS[1]
local orderKey = KEYS[2]
local now = tonumber(ARGV[1])

-- Get the value
local value = redis.call('GET', dataKey)
if not value then
  -- Lazy repair: drop the stale order member so expired keys stop
  -- counting against the capacity limit
  redis.call('ZREM', orderKey, dataKey)
  return nil
end

-- Update access time
redis.call('ZADD', orderKey, now, dataKey)

-- Get TTL in ms for metadata
local ttl = redis.call('PTTL', dataKey)
return {value, ttl}
`;

/**
 * Redis LFU Cache Implementation using Lua scripts
 * Tracks access frequency for each key
 *
 * Best for: Workloads with clear hot/cold patterns
 * Pros: Excellent for skewed access patterns, distributed
 * Cons: More memory overhead for frequency tracking
 */
const LFU_REDIS_LUA = `
-- lfu-set
-- KEYS[1] = data key, KEYS[2] = frequency key
-- ARGV[1] = value, ARGV[2] = ttl (ms), ARGV[3] = max size
local dataKey = KEYS[1]
local freqKey = KEYS[2]
local value = ARGV[1]
local ttl = tonumber(ARGV[2])
local maxSize = tonumber(ARGV[3])

-- Set the value with millisecond TTL if provided
if ttl and ttl > 0 then
  redis.call('SET', dataKey, value, 'PX', ttl)
else
  redis.call('SET', dataKey, value)
end

-- Initialize frequency to 1 ONLY for new members (NX). Previously every
-- overwrite reset a hot key's frequency to 1, making it the next victim.
redis.call('ZADD', freqKey, 'NX', 1, dataKey)

-- Enforce max size, purging phantom (expired) members before live ones
while redis.call('ZCARD', freqKey) > maxSize do
  local leastFreq = redis.call('ZRANGE', freqKey, 0, 0)
  if #leastFreq == 0 then break end
  redis.call('ZREM', freqKey, leastFreq[1])
  redis.call('DEL', leastFreq[1])
end

return 1
`;

const LFU_GET_REDIS_LUA = `
-- lfu-get
-- KEYS[1] = data key, KEYS[2] = frequency key
local dataKey = KEYS[1]
local freqKey = KEYS[2]

-- Get the value
local value = redis.call('GET', dataKey)
if not value then
  -- Lazy repair of stale frequency members for expired keys
  redis.call('ZREM', freqKey, dataKey)
  return nil
end

-- Increment frequency
local freq = redis.call('ZINCRBY', freqKey, 1, dataKey)

-- Get TTL in ms for metadata
local ttl = redis.call('PTTL', dataKey)
return {value, ttl, freq}
`;

/**
 * Plain single-round-trip get for TTL / write-behind strategies
 * (GET + PTTL used to be two sequential network round trips)
 */
const PLAIN_GET_LUA = `
-- plain-get
-- KEYS[1] = data key
local value = redis.call('GET', KEYS[1])
if not value then
  return nil
end
local ttl = redis.call('PTTL', KEYS[1])
return {value, ttl}
`;

/**
 * Write-through get with read-through fallback: on cache miss, consult the
 * backing storage key and repopulate the cache. Previously a write-through
 * cache miss ignored the storage key entirely, defeating the pattern.
 */
const WRITE_THROUGH_GET_LUA = `
-- wt-get
-- KEYS[1] = cache key, KEYS[2] = storage key
local value = redis.call('GET', KEYS[1])
if value then
  local ttl = redis.call('PTTL', KEYS[1])
  return {value, ttl}
end
local stored = redis.call('GET', KEYS[2])
if not stored then
  return nil
end
-- Repopulate cache from storage (no TTL: storage is the source of truth)
redis.call('SET', KEYS[1], stored)
return {stored, -1}
`;

/**
 * Write-Through Cache Implementation
 * Writes to both cache and persistent storage simultaneously
 *
 * Best for: Strong consistency requirements, read-heavy workloads
 * Pros: Always consistent, simple to reason about
 * Cons: Higher write latency, more complex error handling
 */
const WRITE_THROUGH_LUA = `
-- wt-set
-- KEYS[1] = cache key, KEYS[2] = storage key
-- ARGV[1] = value, ARGV[2] = ttl (ms)
local cacheKey = KEYS[1]
local storageKey = KEYS[2]
local value = ARGV[1]
local ttl = tonumber(ARGV[2])

-- Write to both cache and storage
redis.call('SET', cacheKey, value)
redis.call('SET', storageKey, value)

-- Set millisecond TTL on cache if provided
if ttl and ttl > 0 then
  redis.call('PEXPIRE', cacheKey, ttl)
end

return 1
`;

/**
 * Write-Behind Cache Implementation
 * Writes to cache immediately, storage asynchronously
 *
 * Best for: Write-heavy workloads, can tolerate eventual consistency
 * Pros: Lower write latency, better performance
 * Cons: Risk of data loss, eventual consistency
 */
const WRITE_BEHIND_LUA = `
-- wb-set
-- KEYS[1] = cache key, KEYS[2] = write queue key
-- ARGV[1] = value, ARGV[2] = ttl (ms), ARGV[3] = pre-encoded queue payload
local cacheKey = KEYS[1]
local queueKey = KEYS[2]
local value = ARGV[1]
local ttl = tonumber(ARGV[2])

-- Write to cache immediately
redis.call('SET', cacheKey, value)

-- Set millisecond TTL on cache if provided
if ttl and ttl > 0 then
  redis.call('PEXPIRE', cacheKey, ttl)
end

-- Queue for background write to storage (payload encoded client-side; no
-- cjson dependency, script source stays constant)
redis.call('LPUSH', queueKey, ARGV[3])

return 1
`;

/**
 * Drain a batch from the write-behind queue. Batch size is ARGV so the
 * script source is constant (SHA-cacheable) instead of string-interpolated.
 */
const WRITE_BEHIND_DRAIN_LUA = `
-- wb-drain
-- KEYS[1] = write queue key, ARGV[1] = batch size
-- RPOP with COUNT (Redis 6.2+): one command, no per-item loop
local items = redis.call('RPOP', KEYS[1], tonumber(ARGV[1]))
if not items then
  return {}
end
return items
`;

/**
 * Redis cache implementation class
 * Provides unified interface for all Redis caching strategies
 */
export class RedisCache {
  private stats: CacheStats = {
    hits: 0,
    misses: 0,
    hitRate: 0,
    size: 0,
    maxSize: 0,
    evictions: 0,
  };

  constructor(
    private redis: CacheRedisClient,
    private maxSize: number = 10000
  ) {
    this.stats.maxSize = maxSize;
  }

  /**
   * Get value from Redis cache with strategy-specific logic
   */
  async get(
    key: string,
    strategy: CacheStrategy,
    nowMs: number = Date.now()
  ): Promise<CacheResult> {
    // Unsupported strategies are programmer errors: fail loud, don't
    // masquerade as a cache miss
    this.assertRedisStrategy(strategy);

    try {
      let result: unknown;
      const metadata: CacheMetadata = {};

      switch (strategy) {
        case CacheStrategy.LRU_REDIS: {
          result = await this.redis.eval(
            LRU_GET_REDIS_LUA,
            2,
            `cache:${key}`,
            `lru_order:cache`,
            String(nowMs)
          );
          break;
        }
        case CacheStrategy.LFU_REDIS: {
          result = await this.redis.eval(LFU_GET_REDIS_LUA, 2, `cache:${key}`, `lfu_freq:cache`);
          if (result && Array.isArray(result) && result.length >= 3) {
            metadata.hitCount = Math.round(Number(result[2])) || 0;
          }
          break;
        }
        case CacheStrategy.WRITE_THROUGH_REDIS: {
          result = await this.redis.eval(
            WRITE_THROUGH_GET_LUA,
            2,
            `cache:${key}`,
            `storage:${key}`
          );
          break;
        }
        case CacheStrategy.TTL_REDIS:
        case CacheStrategy.WRITE_BEHIND_REDIS: {
          // Single round trip (GET + PTTL in one script) instead of two
          result = await this.redis.eval(PLAIN_GET_LUA, 1, `cache:${key}`);
          break;
        }
      }

      const resultArr = Array.isArray(result) ? result : null;
      // Fix: `!resultArr[0]` treated a cached empty string as a miss
      if (!resultArr || resultArr[0] == null) {
        this.stats.misses++;
        this.updateHitRate();
        return { hit: false, value: null };
      }

      // Parse value (JSON serialization; raw fallback for legacy data)
      let parsedValue: unknown;
      try {
        parsedValue = JSON.parse(String(resultArr[0]));
      } catch {
        parsedValue = resultArr[0]; // Use as string if not JSON
      }

      // Set TTL metadata (scripts return PTTL: already milliseconds)
      if (resultArr[1] != null && Number(resultArr[1]) > 0) {
        metadata.ttl = Number(resultArr[1]);
      }

      this.stats.hits++;
      this.updateHitRate();

      return {
        hit: true,
        value: parsedValue,
        ttl: metadata.ttl,
        metadata,
      };
    } catch (error) {
      if (error instanceof Error) console.error("Redis cache get error:", error);
      this.stats.misses++;
      this.updateHitRate();
      return { hit: false, value: null };
    }
  }

  /**
   * Set value in Redis cache with strategy-specific logic
   */
  async set(
    key: string,
    value: unknown,
    strategy: CacheStrategy,
    ttl?: number,
    nowMs: number = Date.now()
  ): Promise<void> {
    this.assertRedisStrategy(strategy);

    try {
      // JSON-serialize everything. Storing bare strings meant set(k, "123")
      // read back as the number 123 (and "true" as a boolean).
      const serializedValue = JSON.stringify(value);

      switch (strategy) {
        case CacheStrategy.LRU_REDIS:
          await this.redis.eval(
            LRU_REDIS_LUA,
            2,
            `cache:${key}`,
            `lru_order:cache`,
            serializedValue,
            String(ttl || 0),
            String(this.maxSize),
            String(nowMs)
          );
          break;

        case CacheStrategy.LFU_REDIS:
          await this.redis.eval(
            LFU_REDIS_LUA,
            2,
            `cache:${key}`,
            `lfu_freq:cache`,
            serializedValue,
            String(ttl || 0),
            String(this.maxSize)
          );
          break;

        case CacheStrategy.TTL_REDIS:
          if (ttl && ttl > 0) {
            await this.redis.set(`cache:${key}`, serializedValue, "PX", ttl);
          } else {
            await this.redis.set(`cache:${key}`, serializedValue);
          }
          break;

        case CacheStrategy.WRITE_THROUGH_REDIS:
          await this.redis.eval(
            WRITE_THROUGH_LUA,
            2,
            `cache:${key}`,
            `storage:${key}`,
            serializedValue,
            String(ttl || 0)
          );
          break;

        case CacheStrategy.WRITE_BEHIND_REDIS: {
          const queuePayload = JSON.stringify({
            storageKey: `storage:${key}`,
            value: serializedValue,
            timestamp: nowMs,
          });
          await this.redis.eval(
            WRITE_BEHIND_LUA,
            2,
            `cache:${key}`,
            `write_queue`,
            serializedValue,
            String(ttl || 0),
            queuePayload
          );
          break;
        }
      }

      // Update size estimate (rough approximation)
      this.stats.size = Math.min(this.stats.size + 1, this.maxSize);
    } catch (error) {
      if (error instanceof Error) console.error("Redis cache set error:", error);
      throw error;
    }
  }

  /**
   * Delete value from Redis cache
   */
  async delete(key: string, strategy: CacheStrategy): Promise<boolean> {
    try {
      const deleted = await this.redis.del(`cache:${key}`);

      // Clean up strategy-specific data structures
      switch (strategy) {
        case CacheStrategy.LRU_REDIS:
          await this.redis.eval(
            'redis.call("ZREM", KEYS[1], ARGV[1]); return 1',
            1,
            "lru_order:cache",
            `cache:${key}`
          );
          break;

        case CacheStrategy.LFU_REDIS:
          await this.redis.eval(
            'redis.call("ZREM", KEYS[1], ARGV[1]); return 1',
            1,
            "lfu_freq:cache",
            `cache:${key}`
          );
          break;

        case CacheStrategy.WRITE_THROUGH_REDIS:
          await this.redis.del(`storage:${key}`);
          break;
      }

      if (deleted > 0) {
        this.stats.size = Math.max(0, this.stats.size - 1);
        return true;
      }
      return false;
    } catch (error) {
      if (error instanceof Error) console.error("Redis cache delete error:", error);
      return false;
    }
  }

  /**
   * Clear all cache entries.
   * Uses cursor-based SCAN (non-blocking) when the client supports it;
   * KEYS is O(N) and blocks the Redis event loop, which is why every Redis
   * operations guide bans it in production. Deletes are batched.
   */
  async clear(): Promise<void> {
    try {
      const patterns = ["cache:*", "storage:*"];

      if (typeof this.redis.scan === "function") {
        for (const pattern of patterns) {
          let cursor = "0";
          do {
            const [next, keys] = await this.redis.scan(
              cursor,
              "MATCH",
              pattern,
              "COUNT",
              "500"
            );
            cursor = next;
            if (keys.length > 0) {
              await Promise.all(keys.map((k) => this.redis.del(k)));
            }
          } while (cursor !== "0");
        }
      } else {
        // Fallback for clients without scan support
        for (const pattern of patterns) {
          const keys = await this.redis.keys(pattern);
          if (keys.length > 0) {
            await Promise.all(keys.map((k) => this.redis.del(k)));
          }
        }
      }

      // Clear strategy-specific data structures
      await this.redis.del("lru_order:cache");
      await this.redis.del("lfu_freq:cache");
      await this.redis.del("write_queue");

      this.stats.size = 0;
    } catch (error) {
      if (error instanceof Error) console.error("Redis cache clear error:", error);
      throw error;
    }
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Process write-behind queue (for background processing)
   */
  async processWriteBehindQueue(batchSize: number = 10): Promise<number> {
    try {
      const items = (await this.redis.eval(
        WRITE_BEHIND_DRAIN_LUA,
        1,
        "write_queue",
        String(Math.max(1, Math.floor(batchSize)))
      )) as string[];

      let processed = 0;
      for (const item of items ?? []) {
        try {
          const writeData = JSON.parse(item) as { storageKey: string; value: string };
          // In a real implementation, this would write to persistent storage
          await this.redis.set(writeData.storageKey, writeData.value);
          processed++;
        } catch (error) {
          if (error instanceof Error) console.error("Error processing write-behind item:", error);
          // Could implement dead letter queue here
        }
      }

      return processed;
    } catch (error) {
      if (error instanceof Error) console.error("Error processing write-behind queue:", error);
      return 0;
    }
  }

  /**
   * Throw (outside the operational catch) for unsupported strategies
   */
  private assertRedisStrategy(strategy: CacheStrategy): void {
    switch (strategy) {
      case CacheStrategy.LRU_REDIS:
      case CacheStrategy.LFU_REDIS:
      case CacheStrategy.TTL_REDIS:
      case CacheStrategy.WRITE_THROUGH_REDIS:
      case CacheStrategy.WRITE_BEHIND_REDIS:
        return;
      default:
        throw new Error(`Unsupported Redis cache strategy: ${strategy}`);
    }
  }

  /**
   * Update hit rate percentage
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;
  }
}

/**
 * Global Redis cache instance storage
 */
class RedisCacheStorage {
  private caches = new Map<string, RedisCache>();

  getCache(redis: CacheRedisClient, maxSize: number = 10000): RedisCache {
    const key = `redis-${maxSize}`;

    if (!this.caches.has(key)) {
      this.caches.set(key, new RedisCache(redis, maxSize));
    }

    return this.caches.get(key)!;
  }

  clearAll(): void {
    this.caches.clear();
  }
}

// Global storage instance
export const redisCacheStorage = new RedisCacheStorage();

/**
 * Unified Redis cache interface functions
 * Provides consistent API across all Redis cache strategies
 */
export async function getFromRedisCache(
  redis: CacheRedisClient,
  { key, strategy, maxSize, nowMs }: CacheOptions
): Promise<CacheResult> {
  const cache = redisCacheStorage.getCache(redis, maxSize);
  return cache.get(key, strategy, nowMs);
}

export async function setInRedisCache(
  redis: CacheRedisClient,
  { key, strategy, maxSize, ttl, nowMs }: CacheOptions,
  value: unknown
): Promise<void> {
  const cache = redisCacheStorage.getCache(redis, maxSize);
  return cache.set(key, value, strategy, ttl, nowMs);
}

export async function deleteFromRedisCache(
  redis: CacheRedisClient,
  { key, strategy, maxSize }: CacheOptions
): Promise<boolean> {
  const cache = redisCacheStorage.getCache(redis, maxSize);
  return cache.delete(key, strategy);
}

export async function getRedisCacheStats(
  redis: CacheRedisClient,
  maxSize: number = 10000
): Promise<CacheStats> {
  const cache = redisCacheStorage.getCache(redis, maxSize);
  return cache.getStats();
}

export function clearRedisCacheStorage(): void {
  redisCacheStorage.clearAll();
}
