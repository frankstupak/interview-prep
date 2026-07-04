// cache-memory.ts - In-memory cache implementations
// Provides multiple caching strategies without external dependencies
//
// Uplift notes (Lumen Industries):
// - LFU eviction rewritten from an O(n) full-map scan per eviction to the
//   O(1) frequency-bucket scheme (Matani, Shah, Mitra — arXiv:2110.11602).
// - LRU no longer maintains a duplicate access-order Map; it reorders the
//   primary Map on access (delete + re-insert is O(1) and halves key overhead).
// - FIFO no longer maintains a side array with O(n) indexOf/splice; the
//   primary Map's insertion order IS the FIFO order.
// - TTL capacity eviction no longer does an O(n) cleanup + O(n) oldest-scan
//   per insert; oldest-created is the first Map key, evicted in O(1).
// - stats.memoryUsage no longer leaks on key overwrite or on lazy expiry.
// - TTL cleanup timer is unref()'d so it cannot keep the process alive, and
//   clearMemoryCacheStorage() now destroys timers (this was the open-handle
//   source that forced --detectOpenHandles and the skipped perf suite).

import {
  CacheStrategy,
  CacheOptions,
  CacheResult,
  CacheEntry,
  CacheStats,
  CacheMetadata,
} from "./cache-types";

/**
 * Base class for in-memory cache implementations
 * Provides common functionality and statistics tracking
 */
abstract class BaseMemoryCache<T = unknown> {
  protected cache = new Map<string, CacheEntry<T>>();
  protected stats: CacheStats = {
    hits: 0,
    misses: 0,
    hitRate: 0,
    size: 0,
    maxSize: 0,
    evictions: 0,
    memoryUsage: 0,
  };

  constructor(protected maxSize: number = 1000) {
    this.stats.maxSize = maxSize;
  }

  /**
   * Abstract method for eviction policy
   * Each strategy implements its own eviction logic
   */
  protected abstract evict(): void;

  /**
   * Abstract method for updating access patterns
   * Each strategy tracks access differently
   */
  protected abstract onAccess(entry: CacheEntry<T>): void;

  /**
   * Get value from cache
   * Updates access patterns and statistics
   */
  async get(key: string, nowMs: number = Date.now()): Promise<CacheResult<T>> {
    const entry = this.cache.get(key);

    // Cache miss
    if (!entry) {
      this.stats.misses++;
      this.updateHitRate();
      return { hit: false, value: null };
    }

    // Check if expired (lazy expiry). Fix: also release its memory accounting.
    if (entry.expiresAt && nowMs > entry.expiresAt) {
      this.removeEntry(key, entry, false);
      this.stats.misses++;
      this.updateHitRate();
      return { hit: false, value: null };
    }

    // Cache hit - update access patterns
    entry.lastAccessed = nowMs;
    entry.accessCount++;
    this.onAccess(entry);

    this.stats.hits++;
    this.updateHitRate();

    const metadata: CacheMetadata = {
      hitCount: entry.accessCount,
      lastAccessed: entry.lastAccessed,
      createdAt: entry.createdAt,
      size: entry.size,
    };

    if (entry.expiresAt) {
      metadata.ttl = Math.max(0, entry.expiresAt - nowMs);
    }

    return {
      hit: true,
      value: entry.value,
      ttl: entry.expiresAt ? Math.max(0, entry.expiresAt - nowMs) : undefined,
      metadata,
    };
  }

  /**
   * Set value in cache
   * Handles eviction when cache is full
   */
  async set(key: string, value: T, ttl?: number, nowMs: number = Date.now()): Promise<void> {
    // Remove existing entry if present.
    // Fix: release the OLD entry's memory accounting (previously leaked).
    const existing = this.cache.get(key);
    if (existing) {
      this.cache.delete(key);
      this.stats.size--;
      this.stats.memoryUsage = Math.max(
        0,
        (this.stats.memoryUsage ?? 0) - (existing.size || 0)
      );
    }

    // Evict if at capacity
    while (this.cache.size >= this.maxSize && this.cache.size > 0) {
      this.evict();
    }

    // Calculate expiration
    const expiresAt = ttl ? nowMs + ttl : undefined;

    // Estimate size (rough approximation)
    const size = this.estimateSize(value);

    // Create cache entry
    const entry: CacheEntry<T> = {
      key,
      value,
      createdAt: nowMs,
      lastAccessed: nowMs,
      accessCount: 0,
      ttl,
      expiresAt,
      size,
    };

    this.cache.set(key, entry);
    this.stats.size++;
    this.stats.memoryUsage = (this.stats.memoryUsage ?? 0) + (size || 0);
  }

  /**
   * Delete value from cache
   */
  async delete(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (entry) {
      this.removeEntry(key, entry, false);
      return true;
    }
    return false;
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    this.cache.clear();
    this.stats.size = 0;
    this.stats.memoryUsage = 0;
  }

  /**
   * Release resources (timers etc). No-op for most strategies.
   */
  destroy(): void {
    // Overridden by strategies that hold resources (e.g. TTL cleanup timer)
  }

  /**
   * Get cache statistics
   */
  getStats(): CacheStats {
    return { ...this.stats };
  }

  /**
   * Clean up expired entries
   */
  cleanup(nowMs: number = Date.now()): number {
    let cleaned = 0;
    for (const [key, entry] of this.cache.entries()) {
      if (entry.expiresAt && nowMs > entry.expiresAt) {
        this.removeEntry(key, entry, false);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Shared removal path: keeps size + memoryUsage accounting consistent.
   * Subclasses hook removals via onRemove() to keep their side structures in sync.
   */
  protected removeEntry(key: string, entry: CacheEntry<T>, isEviction: boolean): void {
    this.cache.delete(key);
    this.stats.size--;
    if (isEviction) this.stats.evictions++;
    this.stats.memoryUsage = Math.max(0, (this.stats.memoryUsage ?? 0) - (entry.size || 0));
    this.onRemove(key);
  }

  /**
   * Hook for subclasses to clean side structures on any removal
   */
  protected onRemove(_key: string): void {
    // Default: nothing to clean
  }

  /**
   * Update hit rate percentage
   */
  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? (this.stats.hits / total) * 100 : 0;
  }

  /**
   * Rough size estimation for memory tracking
   */
  private estimateSize(value: unknown): number {
    if (typeof value === "string") return value.length * 2; // UTF-16
    if (typeof value === "number") return 8;
    if (typeof value === "boolean") return 4;
    if (value === null || value === undefined) return 0;

    // For objects, rough JSON size estimation
    try {
      return JSON.stringify(value).length * 2;
    } catch {
      return 100; // Default estimate
    }
  }
}

/**
 * LRU (Least Recently Used) Cache Implementation
 * Evicts the least recently accessed items when full
 *
 * Best for: General purpose caching, temporal locality patterns
 * Time Complexity: O(1) for get/set operations
 *
 * Uplift: the primary Map is kept in recency order (access = delete +
 * re-insert, both O(1)), so no duplicate accessOrder Map is needed.
 * The least-recently-used key is always the first key in the Map.
 */
export class LRUMemoryCache<T = unknown> extends BaseMemoryCache<T> {
  protected onAccess(entry: CacheEntry<T>): void {
    // Move to most-recently-used position (end of Map iteration order)
    this.cache.delete(entry.key);
    this.cache.set(entry.key, entry);
  }

  protected evict(): void {
    // Least-recently used = first key in the recency-ordered Map
    const oldestKey = this.cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;
    const entry = this.cache.get(oldestKey);
    if (entry) {
      this.removeEntry(oldestKey, entry, true);
    }
  }
}

/**
 * LFU (Least Frequently Used) Cache Implementation
 * Evicts the least frequently accessed items when full
 *
 * Best for: Workloads with clear hot/cold data patterns
 * Time Complexity: O(1) for get/set operations INCLUDING eviction
 *
 * Uplift: eviction was previously an O(n) scan over every entry on every
 * eviction (so filling a full cache of size n cost O(n^2)). This is the
 * O(1) frequency-bucket scheme from "An O(1) algorithm for implementing
 * the LFU cache eviction scheme" (Matani, Shah, Mitra): a Map from
 * frequency -> insertion-ordered Set of keys, plus a minFreq cursor.
 * Ties within a frequency bucket break least-recently-used first, which
 * matches the previous implementation's lastAccessed tiebreaker.
 */
export class LFUMemoryCache<T = unknown> extends BaseMemoryCache<T> {
  private freqOf = new Map<string, number>();
  private buckets = new Map<number, Set<string>>();
  private minFreq = 0;

  protected onAccess(entry: CacheEntry<T>): void {
    const key = entry.key;
    const freq = this.freqOf.get(key) ?? 0;
    this.bucketRemove(freq, key);
    if (freq === this.minFreq && !this.buckets.has(freq)) {
      this.minFreq = freq + 1;
    }
    const next = freq + 1;
    this.freqOf.set(key, next);
    this.bucketAdd(next, key);
  }

  async set(key: string, value: T, ttl?: number, nowMs: number = Date.now()): Promise<void> {
    // If overwriting, drop the old frequency state first
    const oldFreq = this.freqOf.get(key);
    if (oldFreq !== undefined) {
      this.bucketRemove(oldFreq, key);
      this.freqOf.delete(key);
    }

    await super.set(key, value, ttl, nowMs);

    // New entries start at frequency 0 (accessCount semantics preserved)
    this.freqOf.set(key, 0);
    this.bucketAdd(0, key);
    this.minFreq = 0;
  }

  async clear(): Promise<void> {
    await super.clear();
    this.freqOf.clear();
    this.buckets.clear();
    this.minFreq = 0;
  }

  protected onRemove(key: string): void {
    const freq = this.freqOf.get(key);
    if (freq !== undefined) {
      this.bucketRemove(freq, key);
      this.freqOf.delete(key);
    }
  }

  protected evict(): void {
    if (this.cache.size === 0) return;

    // Advance minFreq to the first non-empty bucket (amortized O(1):
    // minFreq resets to 0 on insert and only moves up by 1 per promotion)
    while (!this.buckets.has(this.minFreq)) {
      this.minFreq++;
    }

    const bucket = this.buckets.get(this.minFreq)!;
    // First key in the Set = least recently promoted = LRU tiebreak
    const victim = bucket.values().next().value as string | undefined;
    if (victim === undefined) return;

    const entry = this.cache.get(victim);
    if (entry) {
      this.removeEntry(victim, entry, true); // onRemove cleans bucket state
    } else {
      // Defensive: stale bookkeeping without a live entry
      this.bucketRemove(this.minFreq, victim);
      this.freqOf.delete(victim);
    }
  }

  private bucketAdd(freq: number, key: string): void {
    let bucket = this.buckets.get(freq);
    if (!bucket) {
      bucket = new Set<string>();
      this.buckets.set(freq, bucket);
    }
    bucket.add(key);
  }

  private bucketRemove(freq: number, key: string): void {
    const bucket = this.buckets.get(freq);
    if (bucket) {
      bucket.delete(key);
      if (bucket.size === 0) this.buckets.delete(freq);
    }
  }
}

/**
 * TTL (Time To Live) Cache Implementation
 * Items expire after a set time, no size-based eviction
 *
 * Best for: Time-sensitive data, session storage
 * Time Complexity: O(1) for get/set operations
 *
 * Uplift: at-capacity eviction previously ran a full O(n) cleanup scan plus
 * a second O(n) oldest-createdAt scan on EVERY insert at capacity. Because
 * set() always (re-)inserts with a fresh createdAt, the primary Map's
 * insertion order IS createdAt order, so the oldest entry is the first key:
 * O(1). Expired entries are still reclaimed lazily on get() and by the
 * periodic cleanup sweep. The cleanup timer is unref()'d so it cannot hold
 * the event loop open, and destroy() is wired into clearMemoryCacheStorage().
 */
export class TTLMemoryCache<T = unknown> extends BaseMemoryCache<T> {
  private cleanupTimer?: NodeJS.Timeout;

  constructor(maxSize: number = 1000, cleanupInterval: number = 60000) {
    super(maxSize);

    // Periodic cleanup of expired items
    this.cleanupTimer = setInterval(() => {
      this.cleanup();
    }, cleanupInterval);
    // Do not keep the process alive just for cache housekeeping
    this.cleanupTimer.unref?.();
  }

  protected onAccess(_entry: CacheEntry<T>): void {
    // TTL doesn't change access patterns, just tracks for stats
  }

  protected evict(): void {
    if (this.cache.size === 0) return;

    // Oldest-created = first key in insertion-ordered Map
    const oldestKey = this.cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;

    const entry = this.cache.get(oldestKey);
    if (entry) {
      // Expired entries are reclaimed, not "evicted", for stats purposes
      const expired = entry.expiresAt !== undefined && Date.now() > entry.expiresAt;
      this.removeEntry(oldestKey, entry, !expired);
    }
  }

  /**
   * Cleanup timer when cache is destroyed
   */
  destroy(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = undefined;
    }
  }
}

/**
 * FIFO (First In First Out) Cache Implementation
 * Evicts the oldest items when full (insertion order)
 *
 * Best for: Simple caching needs, predictable eviction
 * Time Complexity: O(1) for get/set operations
 *
 * Uplift: previously kept a side array with O(n) indexOf + O(n) splice on
 * every overwrite/delete. The primary Map already tracks insertion order
 * (set() deletes then re-inserts, matching the old move-to-back behavior),
 * so the side array is gone and eviction pops the first Map key in O(1).
 */
export class FIFOMemoryCache<T = unknown> extends BaseMemoryCache<T> {
  protected onAccess(_entry: CacheEntry<T>): void {
    // FIFO doesn't change eviction order based on access
  }

  protected evict(): void {
    // Oldest inserted = first key in insertion-ordered Map
    const oldestKey = this.cache.keys().next().value as string | undefined;
    if (oldestKey === undefined) return;

    const entry = this.cache.get(oldestKey);
    if (entry) {
      this.removeEntry(oldestKey, entry, true);
    }
  }
}

/**
 * Memory cache factory function
 * Creates appropriate cache instance based on strategy
 */
export function createMemoryCache<T = unknown>(
  strategy: CacheStrategy,
  maxSize: number = 1000,
  cleanupInterval?: number
): BaseMemoryCache<T> {
  switch (strategy) {
    case CacheStrategy.LRU_MEMORY:
      return new LRUMemoryCache<T>(maxSize);
    case CacheStrategy.LFU_MEMORY:
      return new LFUMemoryCache<T>(maxSize);
    case CacheStrategy.TTL_MEMORY:
      return new TTLMemoryCache<T>(maxSize, cleanupInterval);
    case CacheStrategy.FIFO_MEMORY:
      return new FIFOMemoryCache<T>(maxSize);
    default:
      throw new Error(`Unsupported memory cache strategy: ${strategy}`);
  }
}

/**
 * Global memory cache storage for different strategies
 * Allows multiple cache instances with different configurations
 */
class MemoryCacheStorage {
  private caches = new Map<string, BaseMemoryCache<unknown>>();

  getCache(strategy: CacheStrategy, maxSize: number = 1000): BaseMemoryCache<unknown> {
    const key = `${strategy}-${maxSize}`;

    if (!this.caches.has(key)) {
      this.caches.set(key, createMemoryCache(strategy, maxSize));
    }

    return this.caches.get(key)!;
  }

  clearAll(): void {
    for (const cache of this.caches.values()) {
      cache.clear();
      // Fix: release timers (TTL caches) so no open handles leak between
      // tests or on shutdown
      cache.destroy();
    }
    this.caches.clear();
  }
}

// Global storage instance
export const memoryCacheStorage = new MemoryCacheStorage();

/**
 * Unified memory cache interface functions
 * Provides consistent API across all memory cache strategies
 */
export async function getFromMemoryCache<T = unknown>({
  key,
  strategy,
  maxSize,
  nowMs,
}: CacheOptions): Promise<CacheResult<T>> {
  const cache = memoryCacheStorage.getCache(strategy, maxSize);
  return cache.get(key, nowMs) as Promise<CacheResult<T>>;
}

export async function setInMemoryCache<T = unknown>(
  { key, strategy, maxSize, ttl, nowMs }: CacheOptions,
  value: T
): Promise<void> {
  const cache = memoryCacheStorage.getCache(strategy, maxSize);
  return cache.set(key, value, ttl, nowMs);
}

export async function deleteFromMemoryCache({
  key,
  strategy,
  maxSize,
}: CacheOptions): Promise<boolean> {
  const cache = memoryCacheStorage.getCache(strategy, maxSize);
  return cache.delete(key);
}

export async function getMemoryCacheStats(
  strategy: CacheStrategy,
  maxSize: number = 1000
): Promise<CacheStats> {
  const cache = memoryCacheStorage.getCache(strategy, maxSize);
  return cache.getStats();
}

export function clearMemoryCacheStorage(): void {
  memoryCacheStorage.clearAll();
}
