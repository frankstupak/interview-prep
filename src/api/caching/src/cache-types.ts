// cache-types.ts - Type definitions for caching system

/**
 * Cache strategy types - different algorithms for cache management
 * Each strategy has different use cases and performance characteristics
 */
export enum CacheStrategy {
  // In-memory implementations (no external dependencies)
  LRU_MEMORY = "lru-memory", // Least Recently Used - evicts oldest accessed items
  LFU_MEMORY = "lfu-memory", // Least Frequently Used - evicts least accessed items
  TTL_MEMORY = "ttl-memory", // Time To Live - items expire after set time
  FIFO_MEMORY = "fifo-memory", // First In First Out - simple queue-based eviction

  // Redis-based implementations (distributed, persistent)
  LRU_REDIS = "lru-redis", // Redis LRU with distributed state
  LFU_REDIS = "lfu-redis", // Redis LFU with distributed state
  TTL_REDIS = "ttl-redis", // Redis TTL with distributed state
  WRITE_THROUGH_REDIS = "write-through-redis", // Write to cache and storage simultaneously
  WRITE_BEHIND_REDIS = "write-behind-redis", // Write to cache first, storage later
}

/**
 * Cache operation options
 */
export interface CacheOptions {
  key: string; // Cache key identifier
  strategy: CacheStrategy; // Which caching algorithm to use
  ttl?: number; // Time to live in milliseconds (optional)
  maxSize?: number; // Maximum cache size (for memory strategies)
  nowMs?: number; // Current time override (for testing)
}

/**
 * Cache operation result
 */
export interface CacheResult<T = unknown> {
  hit: boolean; // Whether the key was found in cache
  value: T | null; // The cached value (null if miss)
  ttl?: number; // Remaining TTL in milliseconds
  metadata?: CacheMetadata; // Additional cache information
}

/**
 * Cache metadata for analytics and debugging
 */
export interface CacheMetadata {
  hitCount?: number; // Number of times this key was accessed
  lastAccessed?: number; // Timestamp of last access
  createdAt?: number; // Timestamp when cached
  size?: number; // Size in bytes (estimated)
  evictionReason?: string; // Why item was evicted (if applicable)
  ttl?: number; // Remaining TTL in milliseconds
}

/**
 * Cache statistics for monitoring
 */
export interface CacheStats {
  hits: number; // Total cache hits
  misses: number; // Total cache misses
  hitRate: number; // Hit rate percentage (0-100)
  size: number; // Current cache size
  maxSize: number; // Maximum cache size
  evictions: number; // Total evictions
  memoryUsage?: number; // Memory usage in bytes
}

/**
 * Cache entry for internal storage
 */
export interface CacheEntry<T = unknown> {
  key: string; // Cache key
  value: T; // Stored value
  createdAt: number; // Creation timestamp
  lastAccessed: number; // Last access timestamp
  accessCount: number; // Number of accesses
  ttl?: number; // Time to live in milliseconds
  expiresAt?: number; // Expiration timestamp
  size: number; // Estimated size in bytes
}

/**
 * Redis client interface for caching operations
 * Abstracts Redis operations needed for caching
 */
export interface CacheRedisClient {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, mode?: string, duration?: number): Promise<string | null>;
  del(key: string): Promise<number>;
  exists(key: string): Promise<number>;
  ttl(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<number>;
  eval(script: string, numkeys: number, ...args: string[]): Promise<unknown>;
  hget(key: string, field: string): Promise<string | null>;
  hset(key: string, field: string, value: string): Promise<number>;
  hincrby(key: string, field: string, increment: number): Promise<number>;
  keys(pattern: string): Promise<string[]>;
  /**
   * Optional cursor-based SCAN (ioredis signature). When available, bulk
   * operations use non-blocking SCAN instead of the O(N), event-loop-blocking
   * KEYS command. Optional so existing client implementations keep compiling.
   */
  scan?(cursor: string, ...args: Array<string | number>): Promise<[string, string[]]>;
}

/**
 * Cache configuration for different strategies
 */
export interface CacheConfig {
  strategy: CacheStrategy; // Primary caching strategy
  maxSize: number; // Maximum number of items
  defaultTtl: number; // Default TTL in milliseconds
  cleanupInterval?: number; // Cleanup interval for expired items (ms)
  enableStats: boolean; // Whether to collect statistics
  writeDelay?: number; // Delay for write-behind strategy (ms)
}

/**
 * Multi-level cache configuration
 * Allows L1 (memory) + L2 (Redis) caching
 */
export interface MultiLevelCacheConfig {
  l1: CacheConfig; // Level 1 cache (typically memory)
  l2: CacheConfig; // Level 2 cache (typically Redis)
  promoteOnHit: boolean; // Whether to promote L2 hits to L1
  writeThrough: boolean; // Whether to write through both levels
}
