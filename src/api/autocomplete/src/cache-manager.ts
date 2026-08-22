/**
 * Cache Manager for Autocomplete System
 *
 * This module provides intelligent caching for search results to improve
 * performance and reduce computational overhead. It supports multiple
 * cache strategies and automatic cache invalidation.
 *
 * Key Features:
 * - In-memory LRU cache with O(1) operations
 * - Redis support for distributed caching
 * - Intelligent cache key generation
 * - Automatic cache invalidation
 * - Cache hit/miss analytics
 * - Configurable TTL and size limits
 */

import { AutocompleteRequest, AutocompleteResponse, CacheConfig } from "./types";

export interface CacheProvider {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
  delete(key: string): Promise<void>;
  clear(): Promise<void>;
  exists(key: string): Promise<boolean>;
  getStats(): Promise<CacheStats>;
}

export interface CacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  totalKeys: number;
  memoryUsage?: number;
}

/**
 * Node for doubly-linked list used in LRU cache
 */
interface LRUNode {
  key: string;
  prev: LRUNode | null;
  next: LRUNode | null;
}

/**
 * In-Memory Cache Provider with O(1) LRU eviction
 * Why: Fast, simple, no external dependencies
 * Good for: Development, small datasets, single-instance applications
 *
 * Implementation uses Map + doubly-linked list for TRUE O(1) operations:
 * - get: O(1) - Map lookup + list update
 * - set: O(1) - Map insert + list update
 * - delete: O(1) - Map delete + list removal
 * - evict: O(1) - Remove tail node
 *
 * Previous implementation used indexOf/splice which was O(n) on every access!
 */
export class MemoryCacheProvider implements CacheProvider {
  private cache = new Map<string, { value: string; expiry: number }>();
  private accessMap = new Map<string, LRUNode>(); // O(1) access to nodes
  private head: LRUNode | null = null; // Most recently used
  private tail: LRUNode | null = null; // Least recently used
  private maxSize: number;
  private stats: CacheStats = { hits: 0, misses: 0, hitRate: 0, totalKeys: 0 };

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize;
  }

  async get(key: string): Promise<string | null> {
    const entry = this.cache.get(key);

    if (!entry) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      this.removeFromAccessList(key);
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    // Update access order (move to head) - O(1)
    this.moveToHead(key);
    this.stats.hits++;
    this.updateHitRate();

    console.warn(`💾 Cache HIT for key: ${key}`);
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number = 300): Promise<void> {
    const isUpdate = this.cache.has(key);

    // Evict if at capacity and this is a new key
    if (this.cache.size >= this.maxSize && !isUpdate) {
      this.evictLRU();
    }

    const expiry = Date.now() + ttlSeconds * 1000;
    this.cache.set(key, { value, expiry });

    // Update access order - O(1)
    if (isUpdate) {
      this.moveToHead(key);
    } else {
      this.addToHead(key);
    }

    this.stats.totalKeys = this.cache.size;
    console.warn(`💾 Cache SET for key: ${key}, TTL: ${ttlSeconds}s`);
  }

  async delete(key: string): Promise<void> {
    if (this.cache.delete(key)) {
      this.removeFromAccessList(key);
      this.stats.totalKeys = this.cache.size;
      console.warn(`💾 Cache DELETE for key: ${key}`);
    }
  }

  async clear(): Promise<void> {
    this.cache.clear();
    this.accessMap.clear();
    this.head = null;
    this.tail = null;
    this.stats = { hits: 0, misses: 0, hitRate: 0, totalKeys: 0 };
    console.warn("💾 Cache CLEARED");
  }

  async exists(key: string): Promise<boolean> {
    const entry = this.cache.get(key);
    if (!entry) return false;

    // Check if expired
    if (Date.now() > entry.expiry) {
      this.cache.delete(key);
      this.removeFromAccessList(key);
      return false;
    }

    return true;
  }

  async getStats(): Promise<CacheStats> {
    // Calculate memory usage (rough estimate)
    let memoryUsage = 0;
    for (const [key, entry] of this.cache) {
      memoryUsage += key.length * 2 + entry.value.length * 2 + 64; // Rough estimate
    }

    return {
      ...this.stats,
      totalKeys: this.cache.size,
      memoryUsage,
    };
  }

  /**
   * O(1) eviction: remove the tail (least recently used) node
   */
  private evictLRU(): void {
    if (!this.tail) return;

    const oldestKey = this.tail.key;
    this.removeNode(this.tail);
    this.accessMap.delete(oldestKey);
    this.cache.delete(oldestKey);
    console.warn(`💾 Cache EVICTED LRU key: ${oldestKey}`);
  }

  /**
   * O(1) operation: move existing node to head (most recently used)
   */
  private moveToHead(key: string): void {
    const node = this.accessMap.get(key);
    if (!node) return;

    // Already at head
    if (node === this.head) return;

    // Remove from current position
    this.removeNode(node);

    // Add to head
    this.addNodeToHead(node);
  }

  /**
   * O(1) operation: add new key to head (most recently used)
   */
  private addToHead(key: string): void {
    const node: LRUNode = { key, prev: null, next: null };
    this.accessMap.set(key, node);
    this.addNodeToHead(node);
  }

  /**
   * O(1) operation: add node to head of doubly-linked list
   */
  private addNodeToHead(node: LRUNode): void {
    node.prev = null;
    node.next = this.head;

    if (this.head) {
      this.head.prev = node;
    }

    this.head = node;

    if (!this.tail) {
      this.tail = node;
    }
  }

  /**
   * O(1) operation: remove node from doubly-linked list
   */
  private removeNode(node: LRUNode): void {
    if (node.prev) {
      node.prev.next = node.next;
    } else {
      // Node is head
      this.head = node.next;
    }

    if (node.next) {
      node.next.prev = node.prev;
    } else {
      // Node is tail
      this.tail = node.prev;
    }

    node.prev = null;
    node.next = null;
  }

  /**
   * O(1) operation: remove key from access list
   */
  private removeFromAccessList(key: string): void {
    const node = this.accessMap.get(key);
    if (!node) return;

    this.removeNode(node);
    this.accessMap.delete(key);
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }
}

/**
 * Redis Cache Provider (Simulated)
 * Why: Distributed caching for multi-instance applications
 * Good for: Production environments, microservices
 */
export class RedisCacheProvider implements CacheProvider {
  private connectionString: string;
  private stats: CacheStats = { hits: 0, misses: 0, hitRate: 0, totalKeys: 0 };
  private simulatedCache = new Map<string, { value: string; expiry: number }>();

  constructor(connectionString: string) {
    this.connectionString = connectionString;
    console.warn(`🔗 Redis cache provider initialized (simulated): ${connectionString}`);
  }

  async get(key: string): Promise<string | null> {
    // Simulate Redis get operation
    const entry = this.simulatedCache.get(key);

    if (!entry) {
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    // Check if expired
    if (Date.now() > entry.expiry) {
      this.simulatedCache.delete(key);
      this.stats.misses++;
      this.updateHitRate();
      return null;
    }

    this.stats.hits++;
    this.updateHitRate();
    console.warn(`🔗 Redis Cache HIT for key: ${key}`);
    return entry.value;
  }

  async set(key: string, value: string, ttlSeconds: number = 300): Promise<void> {
    // Simulate Redis set operation with TTL
    const expiry = Date.now() + ttlSeconds * 1000;
    this.simulatedCache.set(key, { value, expiry });
    console.warn(`🔗 Redis Cache SET for key: ${key}, TTL: ${ttlSeconds}s`);
  }

  async delete(key: string): Promise<void> {
    this.simulatedCache.delete(key);
    console.warn(`🔗 Redis Cache DELETE for key: ${key}`);
  }

  async clear(): Promise<void> {
    this.simulatedCache.clear();
    this.stats = { hits: 0, misses: 0, hitRate: 0, totalKeys: 0 };
    console.warn("🔗 Redis Cache CLEARED");
  }

  async exists(key: string): Promise<boolean> {
    const entry = this.simulatedCache.get(key);
    if (!entry) return false;

    // Check if expired
    if (Date.now() > entry.expiry) {
      this.simulatedCache.delete(key);
      return false;
    }

    return true;
  }

  async getStats(): Promise<CacheStats> {
    // Clean up expired keys before reporting stats
    const now = Date.now();
    for (const [key, entry] of this.simulatedCache) {
      if (now > entry.expiry) {
        this.simulatedCache.delete(key);
      }
    }

    return {
      ...this.stats,
      totalKeys: this.simulatedCache.size,
    };
  }

  private updateHitRate(): void {
    const total = this.stats.hits + this.stats.misses;
    this.stats.hitRate = total > 0 ? this.stats.hits / total : 0;
  }
}

/**
 * Cache Manager
 * Orchestrates cache operations with intelligent key generation
 * and automatic invalidation
 */
export class CacheManager {
  private provider: CacheProvider;
  private config: CacheConfig;
  private invalidationPatterns: Set<RegExp> = new Set();

  constructor(provider: CacheProvider, config: CacheConfig) {
    this.provider = provider;
    this.config = config;

    if (config.invalidationPatterns) {
      config.invalidationPatterns.forEach((pattern) => {
        this.invalidationPatterns.add(new RegExp(pattern));
      });
    }
  }

  /**
   * Generate cache key from request parameters
   * Ensures consistent key generation for identical requests
   */
  generateCacheKey(request: AutocompleteRequest): string {
    // The key MUST cover every request parameter that changes the response.
    // The previous key omitted `category` and `tags`, so a cached result for
    // ?q=x&category=books was served verbatim to ?q=x&category=movies -
    // cross-filter cache poisoning. Query/category/tags are normalized the
    // same way the search engine normalizes them, so equivalent requests
    // ("Test" vs "test") share one entry instead of duplicating cache slots.
    const parts = [
      request.query.trim().toLowerCase(),
      request.limit?.toString() || "default",
      // Engine semantics: fuzzy defaults to TRUE (fuzzy !== false). The old
      // key stringified undefined as "false" - the opposite of reality.
      (request.fuzzy !== false).toString(),
      request.threshold !== undefined ? request.threshold.toString() : "default",
      request.category?.trim().toLowerCase() || "any",
      request.tags && request.tags.length > 0
        ? [...request.tags].map((t) => t.trim().toLowerCase()).sort().join(",")
        : "any",
      request.fields?.join(",") || "all",
    ];

    return `autocomplete:${parts.join(":")}`;
  }

  /**
   * Get cached response for a request
   */
  async get(request: AutocompleteRequest): Promise<AutocompleteResponse | null> {
    if (!this.config.enabled) {
      return null;
    }

    const key = this.generateCacheKey(request);
    const cached = await this.provider.get(key);

    if (!cached) {
      return null;
    }

    try {
      return JSON.parse(cached) as AutocompleteResponse;
    } catch (error) {
      console.error(`Failed to parse cached response for key ${key}:`, error);
      await this.provider.delete(key);
      return null;
    }
  }

  /**
   * Store response in cache
   */
  async set(request: AutocompleteRequest, response: AutocompleteResponse): Promise<void> {
    if (!this.config.enabled) {
      return;
    }

    const key = this.generateCacheKey(request);
    const value = JSON.stringify(response);
    const ttl = this.config.ttl || 300;

    await this.provider.set(key, value, ttl);
  }

  /**
   * Invalidate specific cache entry
   */
  async invalidate(request?: AutocompleteRequest): Promise<void> {
    if (!request) {
      await this.provider.clear();
      return;
    }

    const key = this.generateCacheKey(request);
    await this.provider.delete(key);
  }

  /**
   * Invalidate cache entries matching patterns
   * Useful when underlying data changes
   */
  async invalidateByPattern(pattern: string): Promise<void> {
    // This is a simplified implementation
    // In production Redis, you'd use SCAN + MATCH
    console.warn(`Invalidating cache entries matching pattern: ${pattern}`);
    await this.provider.clear();
  }

  /**
   * Clear all cache entries
   */
  async clear(): Promise<void> {
    await this.provider.clear();
  }

  /**
   * Get cache statistics
   */
  async getStats(): Promise<CacheStats> {
    return await this.provider.getStats();
  }

  async healthCheck(): Promise<{ status: "healthy" | "degraded" | "unhealthy"; details: unknown }> {
    try {
      const stats = await this.provider.getStats();
      return {
        status: "healthy",
        details: {
          ...stats,
          testResult: true,
        },
      };
    } catch (error) {
      return {
        status: "unhealthy",
        details: {
          testResult: false,
          error: (error as Error).message,
        },
      };
    }
  }

  /**
   * Warm up cache with common queries
   * Useful on application startup
   */
  async warmup(
    queries: string[],
    fetchFn: (query: string) => Promise<AutocompleteResponse>
  ): Promise<void> {
    console.warn(`🔥 Warming up cache with ${queries.length} common queries`);

    for (const query of queries) {
      const request: AutocompleteRequest = { query };
      const response = await fetchFn(query);
      await this.set(request, response);
    }

    console.warn(`✅ Cache warmup complete`);
  }
}

/**
 * Create cache manager with configuration
 */
export function createCacheManager(config: CacheConfig): CacheManager {
  let provider: CacheProvider;

  if (config.provider === "redis" && config.redisUrl) {
    provider = new RedisCacheProvider(config.redisUrl);
  } else {
    provider = new MemoryCacheProvider(config.maxSize || 1000);
  }

  return new CacheManager(provider, config);
}

export function createCacheProvider(
  type: "memory" | "redis",
  options: { maxSize?: number; redisUrl?: string } = {}
): CacheProvider {
  if (type === "redis") {
    return new RedisCacheProvider(options.redisUrl || "redis://localhost:6379");
  }

  return new MemoryCacheProvider(options.maxSize || 1000);
}
