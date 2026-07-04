/**
 * Autocomplete Service - Main orchestrator for the autocomplete system
 *
 * This service coordinates between data sources, search engine, and cache
 * to provide a complete autocomplete solution. It handles initialization,
 * data loading, search operations, and system health monitoring.
 *
 * Key Responsibilities:
 * - Coordinate data loading from multiple sources
 * - Manage search index lifecycle
 * - Handle caching strategies
 * - Provide health monitoring and metrics
 * - Implement rate limiting and throttling
 */

import { SearchEngine } from "./search-engine";
import { CacheManager, createCacheProvider } from "./cache-manager";
import { DataSourceManager, createDataSource } from "./data-source";
import {
  AutocompleteItem,
  AutocompleteRequest,
  AutocompleteResponse,
  AutocompleteConfig,
  DataSource,
  IndexStats,
} from "./types.js";

export class AutocompleteService {
  private searchEngine: SearchEngine;
  private cacheManager: CacheManager;
  private dataSourceManager: DataSourceManager;
  private config: AutocompleteConfig;
  private isInitialized = false;
  private lastIndexRebuild = new Date();
  private indexRebuildTimer?: NodeJS.Timeout;

  /**
   * Single-flight map: identical concurrent requests share one in-flight
   * search instead of each hitting the engine (classic cache-stampede guard).
   *
   * This replaces the previous lodash.debounce wrapper, which was a genuine
   * correctness bug on a server: per lodash's documented contract,
   * "subsequent calls to the debounced function return the result of the
   * LAST func invocation" - and undefined before the first invocation ever
   * runs. Debouncing the shared request path therefore (a) returned
   * `undefined` responses during the wait window and (b) leaked one user's
   * search response to a different user whose request arrived in the same
   * window. Debounce belongs on the client keystroke, never on the server
   * request path.
   */
  private inflight = new Map<string, Promise<AutocompleteResponse>>();

  constructor(config: AutocompleteConfig) {
    this.config = config;

    // Initialize core components
    this.searchEngine = new SearchEngine(config.search);

    // Initialize cache manager
    const cacheProvider = createCacheProvider("memory", {
      maxSize: config.cache.maxSize,
    });
    this.cacheManager = new CacheManager(cacheProvider, config.cache);

    // Initialize data source manager
    this.dataSourceManager = new DataSourceManager();

    console.warn("🚀 AutocompleteService initialized");
  }

  /**
   * Initialize the service with data sources
   */
  async initialize(dataSources: DataSource[]): Promise<void> {
    console.warn("🔧 Initializing AutocompleteService...");

    try {
      // Add data sources
      for (const sourceConfig of dataSources) {
        const source = createDataSource(sourceConfig);
        this.dataSourceManager.addSource(sourceConfig.id, source);
      }

      // Load initial data and build search index
      await this.rebuildIndex();

      // Set up automatic index rebuilding if enabled
      if (this.config.index.enableBackgroundUpdates) {
        this.scheduleIndexRebuild();
      }

      this.isInitialized = true;
      console.warn("✅ AutocompleteService initialized successfully");
    } catch (error) {
      console.error("❌ Failed to initialize AutocompleteService:", error);
      throw error;
    }
  }

  /**
   * Perform autocomplete search
   */
  async search(request: AutocompleteRequest): Promise<AutocompleteResponse> {
    if (!this.isInitialized) {
      throw new Error("AutocompleteService not initialized. Call initialize() first.");
    }

    // Validate request
    this.validateRequest(request);

    // Single-flight: coalesce identical concurrent requests onto one search.
    // Distinct requests always run independently and each caller always
    // receives the response for ITS OWN request. (config.api.debounceMs is
    // intentionally ignored on the server path - see the `inflight` docs.)
    const key = this.cacheManager.generateCacheKey(request);
    const existing = this.inflight.get(key);
    if (existing) {
      return existing;
    }

    const pending = this.performSearch(request).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, pending);
    return pending;
  }

  /**
   * Perform the actual search operation
   */
  private async performSearch(request: AutocompleteRequest): Promise<AutocompleteResponse> {
    const startTime = Date.now();

    console.warn(`🔍 Processing search request: "${request.query}"`);

    try {
      // Try cache first
      const cachedResult = await this.cacheManager.get(request);
      if (cachedResult) {
        console.warn(`⚡ Returning cached result for: "${request.query}"`);
        cachedResult.metadata = {
          ...cachedResult.metadata,
          cacheHit: true,
        };
        return cachedResult;
      }

      // Perform search using search engine
      const searchResult = await this.searchEngine.search(request);

      // Cache the result
      await this.cacheManager.set(request, searchResult);

      const totalTime = Date.now() - startTime;
      console.warn(`✅ Search completed in ${totalTime}ms: ${searchResult.results.length} results`);

      return searchResult;
    } catch (error) {
      console.error("❌ Search failed:", error);
      throw new Error(`Search operation failed: ${error}`);
    }
  }

  /**
   * Get search suggestions for a partial query
   */
  async getSuggestions(partialQuery: string, limit: number = 5): Promise<string[]> {
    if (!partialQuery || partialQuery.length < 2) {
      return [];
    }

    // Use a broad search to find potential matches
    const searchRequest: AutocompleteRequest = {
      query: partialQuery,
      limit: limit * 2, // Get more results to filter from
      fuzzy: true,
      threshold: 0.5, // More lenient for suggestions
    };

    try {
      const results = await this.performSearch(searchRequest);

      // Extract unique suggestions from titles (case-insensitive dedupe)
      const suggestions = new Map<string, string>(); // lowerKey -> display form

      for (const result of results.results) {
        const title = result.item.title.toLowerCase();

        // Add the full title if it contains the query
        if (title.includes(partialQuery.toLowerCase())) {
          const key = result.item.title.toLowerCase();
          if (!suggestions.has(key)) suggestions.set(key, result.item.title);
        }

        // Add individual words that start with the query
        const words = title.split(/\s+/);
        for (const word of words) {
          if (word.startsWith(partialQuery.toLowerCase()) && word.length > partialQuery.length) {
            if (!suggestions.has(word)) {
              const display = title === word ? result.item.title : word;
              suggestions.set(word, display);
            }
          }
        }

        if (suggestions.size >= limit) break;
      }

      return Array.from(suggestions.values()).slice(0, limit);
    } catch (error) {
      console.error("❌ Failed to get suggestions:", error);
      return [];
    }
  }

  /**
   * Add new items to the search index
   */
  async addItems(items: AutocompleteItem[]): Promise<void> {
    console.warn(`➕ Adding ${items.length} items to search index`);

    try {
      // Load current data
      const currentItems = await this.dataSourceManager.loadAll();

      // Add new items (avoiding duplicates) and sanitize
      const existingIds = new Set(currentItems.map((item) => item.id));
      const newItems = items
        .filter((item) => !existingIds.has(item.id))
        .map((item) => ({
          ...item,
          tags: Array.isArray(item.tags) ? item.tags : [],
          createdAt: item.createdAt ? new Date(item.createdAt) : new Date(),
          updatedAt: item.updatedAt ? new Date(item.updatedAt) : new Date(),
        }))
        .filter((item) => {
          const isValid = !!(item.id && item.title && item.category);
          if (!isValid) {
            console.warn(`Skipping invalid autocomplete item: ${item.id || "unknown"}`);
          }
          return isValid;
        });

      if (newItems.length === 0) {
        console.warn("ℹ️ No new items to add (all items already exist)");
        return;
      }

      // Rebuild index with new items
      const allItems = [...currentItems, ...newItems];
      this.searchEngine.buildIndex(allItems);

      // Invalidate cache since index changed
      await this.cacheManager.invalidate();

      console.warn(`✅ Added ${newItems.length} new items to search index`);
    } catch (error) {
      console.error("❌ Failed to add items:", error);
      throw error;
    }
  }

  /**
   * Remove items from the search index
   */
  async removeItems(itemIds: string[]): Promise<void> {
    console.warn(`➖ Removing ${itemIds.length} items from search index`);

    try {
      // Load current data
      const currentItems = await this.dataSourceManager.loadAll();

      // Filter out items to remove
      const filteredItems = currentItems.filter((item) => !itemIds.includes(item.id));

      if (filteredItems.length === currentItems.length) {
        console.warn("ℹ️ No items were removed (IDs not found)");
        return;
      }

      // Rebuild index without removed items
      this.searchEngine.buildIndex(filteredItems);

      // Invalidate cache since index changed
      await this.cacheManager.invalidate();

      const removedCount = currentItems.length - filteredItems.length;
      console.warn(`✅ Removed ${removedCount} items from search index`);
    } catch (error) {
      console.error("❌ Failed to remove items:", error);
      throw error;
    }
  }

  /**
   * Rebuild the search index from all data sources
   */
  async rebuildIndex(): Promise<void> {
    console.warn("🔨 Rebuilding search index...");
    const startTime = Date.now();

    try {
      // Load data from all sources
      const items = await this.dataSourceManager.loadAll();

      // Build search index
      this.searchEngine.buildIndex(items);

      // Clear cache since index changed
      await this.cacheManager.invalidate();

      this.lastIndexRebuild = new Date();
      const rebuildTime = Date.now() - startTime;

      console.warn(`✅ Search index rebuilt with ${items.length} items in ${rebuildTime}ms`);
    } catch (error) {
      console.error("❌ Failed to rebuild search index:", error);
      throw error;
    }
  }

  /**
   * Schedule automatic index rebuilding
   */
  private scheduleIndexRebuild(): void {
    if (this.indexRebuildTimer) {
      clearInterval(this.indexRebuildTimer);
    }

    this.indexRebuildTimer = setInterval(async () => {
      console.warn("⏰ Scheduled index rebuild triggered");
      try {
        await this.rebuildIndex();
      } catch (error) {
        console.error("❌ Scheduled index rebuild failed:", error);
      }
    }, this.config.index.rebuildInterval);

    // Background maintenance must not keep the Node.js process alive
    this.indexRebuildTimer.unref?.();

    console.warn(`⏰ Scheduled index rebuild every ${this.config.index.rebuildInterval}ms`);
  }

  /**
   * Validate search request
   */
  private validateRequest(request: AutocompleteRequest): void {
    if (!request.query || typeof request.query !== "string") {
      throw new Error("Query is required and must be a string");
    }

    if (request.query.trim().length === 0) {
      throw new Error("Query cannot be empty");
    }

    if (request.limit && (request.limit < 1 || request.limit > this.config.api.maxLimit)) {
      throw new Error(`Limit must be between 1 and ${this.config.api.maxLimit}`);
    }

    if (request.threshold && (request.threshold < 0 || request.threshold > 1)) {
      throw new Error("Threshold must be between 0 and 1");
    }
  }

  /**
   * Get service health status
   */
  async getHealthStatus(): Promise<{
    status: "healthy" | "degraded" | "unhealthy";
    details: {
      initialized: boolean;
      lastIndexRebuild: Date;
      indexStats: IndexStats;
      cacheHealth: unknown;
      dataSourceStats: unknown[];
    };
  }> {
    try {
      const indexStats = this.searchEngine.getAnalytics().indexStats;
      const cacheHealth = await this.cacheManager.healthCheck();
      const dataSourceStats = this.dataSourceManager.getSourceStats();

      const isHealthy =
        this.isInitialized && indexStats.totalItems > 0 && cacheHealth.status === "healthy";

      return {
        status: isHealthy ? "healthy" : "degraded",
        details: {
          initialized: this.isInitialized,
          lastIndexRebuild: this.lastIndexRebuild,
          indexStats,
          cacheHealth,
          dataSourceStats,
        },
      };
    } catch (error) {
      console.error("❌ Health check failed:", error);
      return {
        status: "unhealthy",
        details: {
          initialized: false,
          lastIndexRebuild: new Date(0),
          indexStats: {
            totalItems: 0,
            lastUpdated: new Date(0),
            indexSize: 0,
            averageSearchTime: 0,
            cacheHitRate: 0,
            popularQueries: [],
          },
          cacheHealth: { status: "unhealthy" },
          dataSourceStats: [],
        },
      };
    }
  }

  /**
   * Get comprehensive analytics
   */
  getAnalytics(): {
    search: ReturnType<SearchEngine["getAnalytics"]>;
    cache: Promise<unknown>;
    service: {
      initialized: boolean;
      lastIndexRebuild: Date;
      uptime: number;
    };
  } {
    return {
      search: this.searchEngine.getAnalytics(),
      cache: this.cacheManager.getStats(),
      service: {
        initialized: this.isInitialized,
        lastIndexRebuild: this.lastIndexRebuild,
        uptime: Date.now() - this.lastIndexRebuild.getTime(),
      },
    };
  }

  /**
   * Update service configuration
   */
  updateConfig(newConfig: Partial<AutocompleteConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Update search engine config if provided
    if (newConfig.search) {
      this.searchEngine.updateConfig(newConfig.search);
    }

    // Note: api.debounceMs is accepted for backward compatibility but is not
    // applied on the server request path (see `inflight` docs above).

    console.warn("⚙️ Service configuration updated");
  }

  /**
   * Graceful shutdown
   */
  async shutdown(): Promise<void> {
    console.warn("🛑 Shutting down AutocompleteService...");

    try {
      // Clear scheduled tasks
      if (this.indexRebuildTimer) {
        clearInterval(this.indexRebuildTimer);
      }

      // Clear analytics to free memory
      this.searchEngine.clearAnalytics();

      // Clear cache
      await this.cacheManager.invalidate();

      this.isInitialized = false;

      console.warn("✅ AutocompleteService shutdown complete");
    } catch (error) {
      console.error("❌ Error during shutdown:", error);
      throw error;
    }
  }
}
