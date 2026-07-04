// cache-manager.ts - Unified cache management system
// Provides single interface for all caching strategies and multi-level caching

import {
  CacheStrategy,
  CacheOptions,
  CacheResult,
  CacheStats,
  CacheRedisClient,
  MultiLevelCacheConfig,
  CacheConfig,
} from "./cache-types";

import {
  getFromMemoryCache,
  setInMemoryCache,
  deleteFromMemoryCache,
  getMemoryCacheStats,
  clearMemoryCacheStorage,
} from "./cache-memory";

import {
  getFromRedisCache,
  setInRedisCache,
  deleteFromRedisCache,
  getRedisCacheStats,
  clearRedisCacheStorage,
  redisCacheStorage,
} from "./cache-redis";

/**
 * Unified cache manager that routes operations to appropriate implementations
 * Supports both single-level and multi-level caching strategies
 */
export class CacheManager {
  private redis?: CacheRedisClient;
  private config: CacheConfig;

  constructor(config: CacheConfig, redis?: CacheRedisClient) {
    this.config = config;
    this.redis = redis;
  }

  /**
   * Get value from cache using configured strategy
   * Handles routing to memory or Redis implementations
   */
  async get<T = unknown>(key: string, options?: Partial<CacheOptions>): Promise<CacheResult<T>> {
    const opts: CacheOptions = {
      key,
      strategy: this.config.strategy,
      maxSize: this.config.maxSize,
      ttl: this.config.defaultTtl,
      nowMs: Date.now(),
      ...options,
    };

    // Unsupported strategies are configuration bugs: fail loud instead of
    // silently reporting a miss (which hides the misconfiguration forever)
    if (!this.isMemoryStrategy(opts.strategy) && !this.isRedisStrategy(opts.strategy)) {
      throw new Error(`Unsupported cache strategy: ${opts.strategy}`);
    }

    try {
      // Route to appropriate implementation based on strategy
      if (this.isMemoryStrategy(opts.strategy)) {
        return await getFromMemoryCache<T>(opts);
      } else {
        if (!this.redis) {
          throw new Error(`Redis client required for strategy: ${opts.strategy}`);
        }
        return (await getFromRedisCache(this.redis, opts)) as CacheResult<T>;
      }
    } catch (error) {
      if (error instanceof Error) console.error(`Cache get error for key ${key}:`, error);
      return { hit: false, value: null };
    }
  }

  /**
   * Set value in cache using configured strategy
   */
  async set<T = unknown>(key: string, value: T, options?: Partial<CacheOptions>): Promise<void> {
    const opts: CacheOptions = {
      key,
      strategy: this.config.strategy,
      maxSize: this.config.maxSize,
      nowMs: Date.now(),
      ...options,
      // Applied AFTER the spread: a caller passing { ttl: undefined } must
      // fall back to defaultTtl instead of clobbering it with undefined
      ttl: options?.ttl ?? this.config.defaultTtl,
    };

    try {
      // Route to appropriate implementation based on strategy
      if (this.isMemoryStrategy(opts.strategy)) {
        await setInMemoryCache(opts, value);
      } else if (this.isRedisStrategy(opts.strategy)) {
        if (!this.redis) {
          throw new Error(`Redis client required for strategy: ${opts.strategy}`);
        }
        await setInRedisCache(this.redis, opts, value);
      } else {
        throw new Error(`Unsupported cache strategy: ${opts.strategy}`);
      }
    } catch (error) {
      if (error instanceof Error) console.error(`Cache set error for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Delete value from cache
   */
  async delete(key: string, options?: Partial<CacheOptions>): Promise<boolean> {
    const opts: CacheOptions = {
      key,
      strategy: this.config.strategy,
      maxSize: this.config.maxSize,
      ...options,
    };

    try {
      // Route to appropriate implementation based on strategy
      if (this.isMemoryStrategy(opts.strategy)) {
        return await deleteFromMemoryCache(opts);
      } else if (this.isRedisStrategy(opts.strategy)) {
        if (!this.redis) {
          throw new Error(`Redis client required for strategy: ${opts.strategy}`);
        }
        return await deleteFromRedisCache(this.redis, opts);
      } else {
        throw new Error(`Unsupported cache strategy: ${opts.strategy}`);
      }
    } catch (error) {
      if (error instanceof Error) console.error(`Cache delete error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    try {
      if (this.isMemoryStrategy(this.config.strategy)) {
        return await getMemoryCacheStats(this.config.strategy, this.config.maxSize);
      } else if (this.isRedisStrategy(this.config.strategy)) {
        if (!this.redis) {
          throw new Error(`Redis client required for strategy: ${this.config.strategy}`);
        }
        return await getRedisCacheStats(this.redis, this.config.maxSize);
      } else {
        throw new Error(`Unsupported cache strategy: ${this.config.strategy}`);
      }
    } catch (error) {
      if (error instanceof Error) console.error("Cache stats error:", error);
      return {
        hits: 0,
        misses: 0,
        hitRate: 0,
        size: 0,
        maxSize: this.config.maxSize,
        evictions: 0,
      };
    }
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    try {
      if (this.isMemoryStrategy(this.config.strategy)) {
        clearMemoryCacheStorage();
      } else if (this.isRedisStrategy(this.config.strategy)) {
        if (!this.redis) {
          throw new Error(`Redis client required for strategy: ${this.config.strategy}`);
        }
        // Clear via the existing cached instance, then reset storage
        const redisCache = redisCacheStorage.getCache(this.redis, this.config.maxSize);
        await redisCache.clear();
        clearRedisCacheStorage();
      }
    } catch (error) {
      if (error instanceof Error) console.error("Cache clear error:", error);
      throw error;
    }
  }

  /**
   * Check if strategy is memory-based
   */
  private isMemoryStrategy(strategy: CacheStrategy): boolean {
    return [
      CacheStrategy.LRU_MEMORY,
      CacheStrategy.LFU_MEMORY,
      CacheStrategy.TTL_MEMORY,
      CacheStrategy.FIFO_MEMORY,
    ].includes(strategy);
  }

  /**
   * Check if strategy is Redis-based
   */
  private isRedisStrategy(strategy: CacheStrategy): boolean {
    return [
      CacheStrategy.LRU_REDIS,
      CacheStrategy.LFU_REDIS,
      CacheStrategy.TTL_REDIS,
      CacheStrategy.WRITE_THROUGH_REDIS,
      CacheStrategy.WRITE_BEHIND_REDIS,
    ].includes(strategy);
  }
}

/**
 * Multi-level cache manager (L1 memory + L2 Redis)
 * Provides automatic promotion and write-through capabilities
 *
 * Best for: High-performance applications with predictable access patterns
 * Pros: Best of both worlds - speed + persistence
 * Cons: More complex, potential consistency issues
 */
export class MultiLevelCacheManager {
  private l1Cache: CacheManager; // Fast memory cache
  private l2Cache: CacheManager; // Persistent Redis cache
  private config: MultiLevelCacheConfig;

  constructor(config: MultiLevelCacheConfig, redis?: CacheRedisClient) {
    this.config = config;
    this.l1Cache = new CacheManager(config.l1);
    this.l2Cache = new CacheManager(config.l2, redis);
  }

  /**
   * Get value with L1 -> L2 fallback and optional promotion
   */
  async get<T = unknown>(key: string, options?: Partial<CacheOptions>): Promise<CacheResult<T>> {
    try {
      // Try L1 cache first (fastest)
      const l1Result = await this.l1Cache.get<T>(key, options);
      if (l1Result.hit) {
        return l1Result;
      }

      // Fallback to L2 cache
      const l2Result = await this.l2Cache.get<T>(key, options);
      if (l2Result.hit && this.config.promoteOnHit) {
        // Promote to L1 cache for faster future access
        try {
          await this.l1Cache.set(key, l2Result.value, {
            ...options,
            ttl: l2Result.ttl,
          });
        } catch (error) {
          if (error instanceof Error) console.error("Error promoting to L1 cache:", error);
          // Don't fail the request if promotion fails
        }
      }

      return l2Result;
    } catch (error) {
      if (error instanceof Error)
        console.error(`Multi-level cache get error for key ${key}:`, error);
      return { hit: false, value: null };
    }
  }

  /**
   * Set value with write-through or write-behind strategy
   */
  async set<T = unknown>(key: string, value: T, options?: Partial<CacheOptions>): Promise<void> {
    try {
      if (this.config.writeThrough) {
        // Write to both levels simultaneously
        await Promise.all([
          this.l1Cache.set(key, value, options),
          this.l2Cache.set(key, value, options),
        ]);
      } else {
        // Write to L1 first, L2 asynchronously
        await this.l1Cache.set(key, value, options);

        // Background write to L2 (fire and forget)
        this.l2Cache.set(key, value, options).catch((err) => {
          if (err instanceof Error) console.error("Background L2 cache write error:", err);
        });
      }
    } catch (error) {
      if (error instanceof Error)
        console.error(`Multi-level cache set error for key ${key}:`, error);
      throw error;
    }
  }

  /**
   * Delete from both cache levels
   */
  async delete(key: string, options?: Partial<CacheOptions>): Promise<boolean> {
    try {
      const [l1Deleted, l2Deleted] = await Promise.all([
        this.l1Cache.delete(key, options),
        this.l2Cache.delete(key, options),
      ]);

      return l1Deleted || l2Deleted;
    } catch (error) {
      if (error instanceof Error)
        console.error(`Multi-level cache delete error for key ${key}:`, error);
      return false;
    }
  }

  /**
   * Get combined statistics from both cache levels
   */
  async getStats(): Promise<{ l1: CacheStats; l2: CacheStats; combined: CacheStats }> {
    try {
      const [l1Stats, l2Stats] = await Promise.all([
        this.l1Cache.getStats(),
        this.l2Cache.getStats(),
      ]);

      // Every request touches L1; L2 is only consulted on an L1 miss.
      // The old formula summed l1.misses + l2.misses, so a request that
      // missed L1 but hit L2 (a SUCCESSFUL cache hit) scored 1 hit + 1 miss
      // = a 50% hit rate, and a full miss double-counted as 2 misses.
      const combined: CacheStats = {
        hits: l1Stats.hits + l2Stats.hits,
        misses: l2Stats.misses,
        hitRate: 0, // Will be calculated below
        size: l1Stats.size + l2Stats.size,
        maxSize: l1Stats.maxSize + l2Stats.maxSize,
        evictions: l1Stats.evictions + l2Stats.evictions,
        memoryUsage: (l1Stats.memoryUsage || 0) + (l2Stats.memoryUsage || 0),
      };

      const totalRequests = l1Stats.hits + l1Stats.misses;
      combined.hitRate = totalRequests > 0 ? (combined.hits / totalRequests) * 100 : 0;

      return { l1: l1Stats, l2: l2Stats, combined };
    } catch (error) {
      if (error instanceof Error) console.error("Multi-level cache stats error:", error);
      throw error;
    }
  }

  /**
   * Clear both cache levels
   */
  async clear(): Promise<void> {
    try {
      await Promise.all([this.l1Cache.clear(), this.l2Cache.clear()]);
    } catch (error) {
      if (error instanceof Error) console.error("Multi-level cache clear error:", error);
      throw error;
    }
  }

  /**
   * Warm up L1 cache with hot data from L2
   * Useful for application startup or after cache clears
   */
  async warmupL1(hotKeys: string[], options?: Partial<CacheOptions>): Promise<number> {
    let warmedUp = 0;

    for (const key of hotKeys) {
      try {
        const l2Result = await this.l2Cache.get(key, options);
        if (l2Result.hit) {
          await this.l1Cache.set(key, l2Result.value, {
            ...options,
            ttl: l2Result.ttl,
          });
          warmedUp++;
        }
      } catch (error) {
        if (error instanceof Error) console.error(`Error warming up key ${key}:`, error);
        // Continue with other keys
      }
    }

    return warmedUp;
  }
}

/**
 * Factory function to create cache manager based on strategy
 */
export function createCacheManager(config: CacheConfig, redis?: CacheRedisClient): CacheManager {
  return new CacheManager(config, redis);
}

/**
 * Factory function to create multi-level cache manager
 */
export function createMultiLevelCacheManager(
  config: MultiLevelCacheConfig,
  redis?: CacheRedisClient
): MultiLevelCacheManager {
  return new MultiLevelCacheManager(config, redis);
}

/**
 * Utility function to determine optimal cache strategy based on usage patterns
 */
export function recommendCacheStrategy(
  accessPattern: "random" | "temporal" | "frequency" | "mixed",
  dataSize: "small" | "medium" | "large",
  consistency: "eventual" | "strong",
  distribution: "single" | "distributed"
): CacheStrategy {
  // Decision matrix based on requirements
  if (distribution === "distributed") {
    // Redis strategies for distributed systems
    if (consistency === "strong") {
      return CacheStrategy.WRITE_THROUGH_REDIS;
    }

    switch (accessPattern) {
      case "temporal":
        return CacheStrategy.LRU_REDIS;
      case "frequency":
        return CacheStrategy.LFU_REDIS;
      case "mixed":
        return CacheStrategy.LRU_REDIS; // Good general purpose
      default:
        return CacheStrategy.TTL_REDIS;
    }
  } else {
    // Memory strategies for single instance
    switch (accessPattern) {
      case "temporal":
        return CacheStrategy.LRU_MEMORY;
      case "frequency":
        return CacheStrategy.LFU_MEMORY;
      case "mixed":
        return CacheStrategy.LRU_MEMORY; // Good general purpose
      default:
        return CacheStrategy.TTL_MEMORY;
    }
  }
}
