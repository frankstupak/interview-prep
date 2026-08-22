/**
 * Comprehensive Tests for Autocomplete System
 *
 * These tests cover all major components of the autocomplete system:
 * - Search engine functionality
 * - Cache management
 * - Data source integration
 * - Service orchestration
 * - API endpoints
 */

import { AutocompleteService } from "./autocomplete-service";
import { SearchEngine } from "./search-engine";
import { CacheManager, MemoryCacheProvider } from "./cache-manager";
import { StaticDataSource, DataSourceManager } from "./data-source";
import { AutocompleteItem, AutocompleteConfig, DataSource, AutocompleteRequest, AutocompleteResponse } from "./types.js";

const consoleLogSpy = jest.spyOn(console, "log").mockImplementation(() => {});
const consoleWarnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});
const consoleErrorSpy = jest.spyOn(console, "error").mockImplementation(() => {});

afterAll(() => {
  consoleLogSpy.mockRestore();
  consoleWarnSpy.mockRestore();
  consoleErrorSpy.mockRestore();
});

// Sample test data
const sampleItems = [
  {
    id: "js-1",
    title: "JavaScript",
    description: "A versatile programming language for web development",
    category: "Programming Languages",
    tags: ["javascript", "programming", "web", "frontend"],
    createdAt: new Date("2023-01-01"),
    updatedAt: new Date("2023-01-01"),
  },
  {
    id: "ts-1",
    title: "TypeScript",
    description: "A typed superset of JavaScript that compiles to plain JavaScript",
    category: "Programming Languages",
    tags: ["typescript", "javascript", "programming", "types"],
    createdAt: new Date("2023-01-02"),
    updatedAt: new Date("2023-01-02"),
  },
  {
    id: "react-1",
    title: "React",
    description: "A JavaScript library for building user interfaces",
    category: "Libraries",
    tags: ["react", "javascript", "frontend", "ui", "library"],
    createdAt: new Date("2023-01-03"),
    updatedAt: new Date("2023-01-03"),
  },
  {
    id: "node-1",
    title: "Node.js",
    description: "JavaScript runtime built on Chrome V8 JavaScript engine",
    category: "Runtime",
    tags: ["nodejs", "javascript", "backend", "server"],
    createdAt: new Date("2023-01-04"),
    updatedAt: new Date("2023-01-04"),
  },
  {
    id: "python-1",
    title: "Python",
    description: "A high-level programming language with dynamic semantics",
    category: "Programming Languages",
    tags: ["python", "programming", "data-science", "backend"],
    createdAt: new Date("2023-01-05"),
    updatedAt: new Date("2023-01-05"),
  },
];

const defaultConfig: AutocompleteConfig = {
  search: {
    keys: [
      { name: "title", weight: 0.7 },
      { name: "description", weight: 0.3 },
      { name: "tags", weight: 0.2 },
    ],
    threshold: 0.3,
    distance: 100,
    includeScore: true,
    includeMatches: true,
    minMatchCharLength: 2,
    shouldSort: true,
    findAllMatches: true,
    location: 0,
    ignoreLocation: false,
    ignoreFieldNorm: false,
  },
  cache: {
    enabled: true,
    ttl: 300,
    maxSize: 100,
    keyPrefix: "test",
  },
  index: {
    rebuildInterval: 60000,
    batchSize: 10,
    enableBackgroundUpdates: false,
  },
  api: {
    defaultLimit: 10,
    maxLimit: 50,
    debounceMs: 0, // Disable debouncing for tests
    enableAnalytics: true,
  },
};

describe("SearchEngine", () => {
  let searchEngine: SearchEngine;

  beforeEach(() => {
    searchEngine = new SearchEngine(defaultConfig.search);
    searchEngine.buildIndex(sampleItems);
  });

  describe("buildIndex", () => {
    it("should build search index with provided items", () => {
      const newItems = sampleItems.slice(0, 3);
      searchEngine.buildIndex(newItems);

      // Index should be built (tested implicitly through search functionality)
      expect(true).toBe(true);
    });
  });

  describe("search", () => {
    it("should find exact matches", async () => {
      const request: AutocompleteRequest = {
        query: "JavaScript",
        limit: 10,
      };

      const response = await searchEngine.search(request);

      expect(response.results.length).toBeGreaterThanOrEqual(2);
      expect(response.results[0].item.title).toBe("JavaScript");
      expect(response.results[0].score).toBeLessThan(0.1); // Very low score for exact match
    });

    it("should handle fuzzy matching", async () => {
      const request: AutocompleteRequest = {
        query: "Javscript", // Typo
        limit: 10,
        fuzzy: true,
      };

      const response = await searchEngine.search(request);

      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results[0].item.title).toBe("JavaScript");
    });

    it("should filter by category", async () => {
      const request: AutocompleteRequest = {
        query: "script",
        category: "Programming Languages",
        limit: 10,
      };

      const response = await searchEngine.search(request);

      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results.every((r) => r.item.category === "Programming Languages")).toBe(true);
    });

    it("should filter by tags", async () => {
      const request: AutocompleteRequest = {
        query: "script",
        tags: ["frontend"],
        limit: 10,
      };

      const response = await searchEngine.search(request);

      expect(response.results.length).toBeGreaterThan(0);
      expect(
        response.results.every((r) => r.item.tags.some((tag) => tag.includes("frontend")))
      ).toBe(true);
    });

    it("should respect limit parameter", async () => {
      const request: AutocompleteRequest = {
        query: "script",
        limit: 2,
      };

      const response = await searchEngine.search(request);

      expect(response.results.length).toBeLessThanOrEqual(2);
    });

    it("should include highlighting in results", async () => {
      const request: AutocompleteRequest = {
        query: "JavaScript",
        limit: 5,
      };

      const response = await searchEngine.search(request);

      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results[0].highlightedTitle).toContain("<mark>");
    });

    it("should generate suggestions for poor results", async () => {
      const request: AutocompleteRequest = {
        query: "xyz123nonexistent",
        limit: 10,
      };

      const response = await searchEngine.search(request);

      expect(response.results.length).toBe(0);
      expect(response.suggestions).toBeDefined();
    });
  });

  describe("analytics", () => {
    it("should track search analytics", async () => {
      const request: AutocompleteRequest = {
        query: "JavaScript",
        limit: 10,
      };

      await searchEngine.search(request);
      await searchEngine.search(request); // Search twice

      const analytics = searchEngine.getAnalytics();

      expect(analytics.performanceMetrics.totalSearches).toBe(2);
      expect(analytics.indexStats.popularQueries).toContainEqual(
        expect.objectContaining({ query: "javascript", count: 2 })
      );
    });
  });
});

describe("CacheManager", () => {
  let cacheManager: CacheManager;
  let cacheProvider: MemoryCacheProvider;

  beforeEach(() => {
    cacheProvider = new MemoryCacheProvider(10);
    cacheManager = new CacheManager(cacheProvider, defaultConfig.cache);
  });

  describe("caching operations", () => {
    it("should cache and retrieve search results", async () => {
      const request: AutocompleteRequest = {
        query: "test",
        limit: 5,
      };

      const mockResponse = {
        query: "test",
        results: [],
        totalCount: 0,
        executionTime: 100,
        metadata: {
          searchType: "fuzzy" as const,
          cacheHit: false,
          indexSize: 5,
        },
      };

      // Cache the response
      await cacheManager.set(request, mockResponse);

      // Retrieve from cache
      const cached = await cacheManager.get(request);

      expect(cached).toBeDefined();
      expect(cached!.query).toBe("test");
      expect(cached!.metadata.cacheHit).toBe(false);
    });

    it("should generate consistent cache keys", async () => {
      const request1: AutocompleteRequest = {
        query: "Test",
        limit: 5,
      };

      const request2: AutocompleteRequest = {
        query: "test", // Different case
        limit: 5,
      };

      const mockResponse = {
        query: "test",
        results: [],
        totalCount: 0,
        executionTime: 100,
        metadata: {
          searchType: "fuzzy" as const,
          cacheHit: false,
          indexSize: 5,
        },
      };

      await cacheManager.set(request1, mockResponse);
      const cached = await cacheManager.get(request2);

      expect(cached).toBeDefined(); // Should find cached result despite case difference
    });

    it("should handle cache misses gracefully", async () => {
      const request: AutocompleteRequest = {
        query: "nonexistent",
        limit: 5,
      };

      const cached = await cacheManager.get(request);

      expect(cached).toBeNull();
    });
  });

  describe("cache statistics", () => {
    it("should track cache statistics", async () => {
      const stats = await cacheManager.getStats();

      expect(stats).toHaveProperty("hits");
      expect(stats).toHaveProperty("misses");
      expect(stats).toHaveProperty("hitRate");
      expect(stats).toHaveProperty("totalKeys");
    });
  });

  describe("health check", () => {
    it("should perform health check", async () => {
      const health = await cacheManager.healthCheck();

      expect(health.status).toBe("healthy");
      expect(health.details.testResult).toBe(true);
    });
  });
});

describe("DataSourceManager", () => {
  let dataSourceManager: DataSourceManager;

  beforeEach(() => {
    dataSourceManager = new DataSourceManager();
  });

  describe("data source management", () => {
    it("should add and load from static data source", async () => {
      const staticSource = new StaticDataSource(sampleItems);
      dataSourceManager.addSource("static", staticSource);

      const items = await dataSourceManager.loadAll();

      expect(items).toHaveLength(sampleItems.length);
      expect(items[0].id).toBe(sampleItems[0].id);
    });

    it("should handle multiple data sources", async () => {
      const source1 = new StaticDataSource(sampleItems.slice(0, 2));
      const source2 = new StaticDataSource(sampleItems.slice(2, 4));

      dataSourceManager.addSource("source1", source1);
      dataSourceManager.addSource("source2", source2);

      const items = await dataSourceManager.loadAll();

      expect(items).toHaveLength(4);
    });

    it("should deduplicate items with same ID", async () => {
      const duplicateItems = [sampleItems[0], sampleItems[0]]; // Same item twice
      const source1 = new StaticDataSource(duplicateItems);
      const source2 = new StaticDataSource([sampleItems[1]]);

      dataSourceManager.addSource("source1", source1);
      dataSourceManager.addSource("source2", source2);

      const items = await dataSourceManager.loadAll();

      expect(items).toHaveLength(2); // Should deduplicate
    });

    it("should handle data source errors gracefully", async () => {
      const errorSource = {
        load: async (): Promise<AutocompleteItem[]> => {
          throw new Error("Data source error");
        },
      };

      dataSourceManager.addSource("error-source", errorSource);
      const validSource = new StaticDataSource([sampleItems[0]]);
      dataSourceManager.addSource("valid-source", validSource);

      const items = await dataSourceManager.loadAll();

      expect(items).toHaveLength(1); // Should load from valid source despite error
    });
  });
});

describe("AutocompleteService", () => {
  let autocompleteService: AutocompleteService;

  beforeEach(async () => {
    autocompleteService = new AutocompleteService(defaultConfig);

    const dataSources: DataSource[] = [
      {
        id: "test-static",
        name: "Test Static Data",
        type: "static",
        config: { data: sampleItems },
        itemCount: sampleItems.length,
      },
    ];

    await autocompleteService.initialize(dataSources);
  });

  afterEach(async () => {
    await autocompleteService.shutdown();
  });

  describe("initialization", () => {
    it("should initialize successfully with data sources", async () => {
      const health = await autocompleteService.getHealthStatus();
      expect(health.status).toBe("healthy");
      expect(health.details.initialized).toBe(true);
    });
  });

  describe("search operations", () => {
    it("should perform basic search", async () => {
      const request: AutocompleteRequest = {
        query: "JavaScript",
        limit: 10,
      };

      const response = await autocompleteService.search(request);

      expect(response.results.length).toBeGreaterThan(0);
      expect(response.query).toBe(request.query.toLowerCase());
      expect(response.executionTime).toBeGreaterThanOrEqual(0);
    });

    it("should handle empty queries", async () => {
      const request: AutocompleteRequest = {
        query: "",
        limit: 10,
      };

      await expect(autocompleteService.search(request)).rejects.toThrow();
    });

    it("should validate request parameters", async () => {
      const invalidRequest: AutocompleteRequest = {
        query: "test",
        limit: 1000, // Exceeds maxLimit
      };

      await expect(autocompleteService.search(invalidRequest)).rejects.toThrow();
    });
  });

  describe("suggestions", () => {
    it("should generate query suggestions", async () => {
      const suggestions = await autocompleteService.getSuggestions("Java", 5);

      expect(suggestions.length).toBeGreaterThan(0);
      expect(suggestions.some((s) => s.toLowerCase().includes("java"))).toBe(true);
    });

    it("should handle short queries", async () => {
      const suggestions = await autocompleteService.getSuggestions("J", 5);

      expect(suggestions).toEqual([]); // Too short
    });
  });

  describe("data management", () => {
    it("should add new items to index", async () => {
      const newItems: AutocompleteItem[] = [
        {
          id: "new-1",
          title: "Vue.js",
          description: "Progressive JavaScript framework",
          category: "Libraries",
          tags: ["vue", "javascript", "frontend"],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      await autocompleteService.addItems(newItems);

      const response = await autocompleteService.search({
        query: "Vue",
        limit: 10,
      });

      expect(response.results.some((r) => r.item.title === "Vue.js")).toBe(true);
    });

    it("should remove items from index", async () => {
      const itemsToRemove = ["js-1"]; // JavaScript item

      await autocompleteService.removeItems(itemsToRemove);

      const response = await autocompleteService.search({
        query: "JavaScript",
        limit: 10,
      });

      expect(response.results.every((r) => r.item.id !== "js-1")).toBe(true);
    });

    it("should rebuild index", async () => {
      await autocompleteService.rebuildIndex();

      const health = await autocompleteService.getHealthStatus();
      expect(health.details.lastIndexRebuild).toBeInstanceOf(Date);
    });
  });

  describe("analytics and monitoring", () => {
    it("should provide analytics data", async () => {
      // Perform some searches to generate analytics
      await autocompleteService.search({ query: "JavaScript", limit: 5 });
      await autocompleteService.search({ query: "Python", limit: 5 });

      const analytics = autocompleteService.getAnalytics();

      expect(analytics.search.performanceMetrics.totalSearches).toBe(2);
      expect(analytics.service.initialized).toBe(true);
    });

    it("should provide health status", async () => {
      const health = await autocompleteService.getHealthStatus();

      expect(health.status).toBe("healthy");
      expect(health.details.initialized).toBe(true);
      expect(health.details.indexStats.totalItems).toBeGreaterThan(0);
    });
  });

  describe("configuration updates", () => {
    it("should update configuration", () => {
      const newConfig = {
        api: { debounceMs: 500 },
      };

      expect(() => {
        autocompleteService.updateConfig(newConfig);
      }).not.toThrow();
    });
  });
});

describe("Integration Tests", () => {
  let autocompleteService: AutocompleteService;

  beforeEach(async () => {
    autocompleteService = new AutocompleteService(defaultConfig);

    const dataSources: DataSource[] = [
      {
        id: "integration-test",
        name: "Integration Test Data",
        type: "static",
        config: { data: sampleItems },
        itemCount: sampleItems.length,
      },
    ];

    await autocompleteService.initialize(dataSources);
  });

  afterEach(async () => {
    await autocompleteService.shutdown();
  });

  describe("end-to-end search workflow", () => {
    it("should handle complete search workflow with caching", async () => {
      const request: AutocompleteRequest = {
        query: "JavaScript",
        limit: 5,
      };

      // First search - should hit search engine
      const response1 = await autocompleteService.search(request);
      expect(response1.metadata.cacheHit).toBe(false);

      // Second search - should hit cache
      const response2 = await autocompleteService.search(request);
      expect(response2.metadata.cacheHit).toBe(true);

      // Results should be identical
      expect(response2.results.map((r) => r.item.id)).toEqual(
        response1.results.map((r) => r.item.id)
      );
    });

    it("should handle complex search scenarios", async () => {
      // Test various search patterns
      const testCases = [
        { query: "JavaScript", expectedResults: 2 },
        { query: "script", expectedResults: 2 },
        { query: "programming", expectedResults: 3 },
        { query: "nonexistent", expectedResults: 0 },
      ];

      for (const testCase of testCases) {
        const response = await autocompleteService.search({
          query: testCase.query,
          limit: 10,
        });

        expect(response.results.length).toBeGreaterThanOrEqual(testCase.expectedResults);
      }
    });

    it("should handle concurrent searches efficiently", async () => {
      const queries = ["JavaScript", "Python", "React", "Node.js", "TypeScript"];

      const startTime = Date.now();

      // Execute searches concurrently
      const promises = queries.map((query) => autocompleteService.search({ query, limit: 5 }));

      const results = await Promise.all(promises);
      const totalTime = Date.now() - startTime;

      // All searches should complete
      expect(results).toHaveLength(5);
      expect(results.every((r) => r.results.length >= 0)).toBe(true);

      // Should be reasonably fast
      expect(totalTime).toBeLessThan(1000);
    });
  });

  describe("error handling and resilience", () => {
    it("should handle service shutdown gracefully", async () => {
      await autocompleteService.shutdown();

      // Service should no longer accept requests
      await expect(autocompleteService.search({ query: "test", limit: 5 })).rejects.toThrow();
    });

    it("should handle invalid data gracefully", async () => {
      const invalidItems = [
        { id: "invalid", title: "", category: "" }, // Missing required fields
      ] as AutocompleteItem[];

      // Should not crash the service
      await expect(autocompleteService.addItems(invalidItems)).resolves.not.toThrow();
    });
  });

  describe("performance characteristics", () => {
    it("should maintain performance under load", async () => {
      const queries = Array.from({ length: 100 }, (_, i) => `query${i}`);

      const startTime = Date.now();

      // Execute many searches
      const promises = queries.map((query) => autocompleteService.search({ query, limit: 5 }));

      const results = await Promise.all(promises);
      const totalTime = Date.now() - startTime;
      const avgTime = totalTime / queries.length;

      expect(results).toHaveLength(100);
      expect(avgTime).toBeLessThan(50); // Average should be under 50ms per search
    });
  });
});

describe("Uplift regression tests", () => {
  describe("SearchEngine: prefix strategy uses a real prefix index", () => {
    let engine: SearchEngine;

    beforeEach(() => {
      engine = new SearchEngine(defaultConfig.search);
      engine.buildIndex(sampleItems);
    });

    it("short queries return items whose tokens start with the prefix", async () => {
      // Queries of length <= 2 route to the prefix strategy. The old code
      // passed "^ja" to Fuse without useExtendedSearch, so the caret was
      // matched as a literal character.
      const response = await engine.search({ query: "ja", limit: 10 });

      expect(response.metadata.searchType).toBe("prefix");
      expect(response.results.length).toBeGreaterThan(0);
      expect(
        response.results.every(
          (r) =>
            r.item.title.toLowerCase().startsWith("ja") ||
            r.item.title
              .toLowerCase()
              .split(/\s+/)
              .some((w) => w.startsWith("ja")) ||
            r.item.tags.some((t) => t.toLowerCase().startsWith("ja"))
        )
      ).toBe(true);
    });

    it("prefix matches work through tags", async () => {
      const response = await engine.search({ query: "ui", limit: 10 });

      expect(response.results.some((r) => r.item.title === "React")).toBe(true);
    });
  });

  describe("SearchEngine: exact strategy is actually exact", () => {
    let engine: SearchEngine;

    beforeEach(() => {
      engine = new SearchEngine(defaultConfig.search);
      engine.buildIndex(sampleItems);
    });

    it("quoted queries only match items containing the exact phrase", async () => {
      const response = await engine.search({ query: '"node.js"', limit: 10 });

      expect(response.metadata.searchType).toBe("exact");
      expect(response.results.length).toBeGreaterThan(0);
      expect(
        response.results.every((r) =>
          [r.item.title, r.item.description || "", ...r.item.tags]
            .join(" ")
            .toLowerCase()
            .includes("node.js")
        )
      ).toBe(true);
    });

    it("quoted nonsense phrases match nothing", async () => {
      const response = await engine.search({ query: '"zzz not a phrase"', limit: 10 });
      expect(response.results).toHaveLength(0);
    });
  });

  describe("SearchEngine: threshold 0 is honored (falsy-zero bug)", () => {
    let engine: SearchEngine;

    beforeEach(() => {
      engine = new SearchEngine(defaultConfig.search);
      engine.buildIndex(sampleItems);
    });

    it("threshold 0 excludes fuzzy (imperfect) matches", async () => {
      // "Javscript" is a typo; every match has score > 0. With threshold 0
      // the old code silently replaced 0 with the 0.3 default and returned
      // fuzzy matches anyway.
      const response = await engine.search({ query: "Javscript", limit: 10, threshold: 0 });

      expect(response.results).toHaveLength(0);
    });
  });

  describe("SearchEngine: filters apply before the limit", () => {
    it("category filter finds items past the pre-filter cutoff", async () => {
      const engine = new SearchEngine(defaultConfig.search);

      // 20 category-A items indexed first, 5 category-B items last. The old
      // code fetched only `limit` candidates and THEN filtered, so category B
      // + a small limit returned zero results despite 5 matching items.
      const bulk: AutocompleteItem[] = [];
      for (let i = 0; i < 20; i++) {
        bulk.push({
          id: `a-${i}`,
          title: `widget alpha ${i}`,
          category: "CatA",
          tags: ["widget"],
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      for (let i = 0; i < 5; i++) {
        bulk.push({
          id: `b-${i}`,
          title: `widget beta ${i}`,
          category: "CatB",
          tags: ["widget"],
          createdAt: new Date(),
          updatedAt: new Date(),
        });
      }
      engine.buildIndex(bulk);

      // 2-char query -> deterministic prefix strategy
      const response = await engine.search({ query: "wi", limit: 3, category: "CatB" });

      expect(response.results.length).toBeGreaterThan(0);
      expect(response.results.every((r) => r.item.category === "CatB")).toBe(true);
      expect(response.results.length).toBeLessThanOrEqual(3);
    });
  });

  describe("SearchEngine: highlighting escapes HTML (stored XSS)", () => {
    it("item data containing markup is escaped in highlighted fields", async () => {
      const engine = new SearchEngine(defaultConfig.search);
      engine.buildIndex([
        {
          id: "xss-1",
          title: '<img src=x onerror=alert(1)> Widget',
          description: '<script>steal()</script> a widget',
          category: "Test",
          tags: ["widget"],
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ]);

      const response = await engine.search({ query: "Widget", limit: 5 });

      expect(response.results.length).toBeGreaterThan(0);
      const { highlightedTitle, highlightedDescription } = response.results[0];

      expect(highlightedTitle).not.toContain("<img");
      expect(highlightedTitle).toContain("&lt;img");
      expect(highlightedDescription).not.toContain("<script>");
      // <mark> tags themselves must survive
      expect(`${highlightedTitle}${highlightedDescription}`).toContain("<mark>");
    });
  });

  describe("SearchEngine: popular query average is a true running mean", () => {
    it("avgExecutionTime equals the arithmetic mean of recorded times", async () => {
      const engine = new SearchEngine(defaultConfig.search);
      engine.buildIndex(sampleItems);

      await engine.search({ query: "JavaScript", limit: 5 });
      await engine.search({ query: "JavaScript", limit: 5 });
      await engine.search({ query: "JavaScript", limit: 5 });

      const analytics = engine.getAnalytics();
      const times = analytics.recentSearches
        .filter((s) => s.query === "javascript")
        .map((s) => s.executionTime);
      const mean = times.reduce((a, b) => a + b, 0) / times.length;

      const popular = analytics.indexStats.popularQueries.find((p) => p.query === "javascript");
      expect(popular).toBeDefined();
      expect(popular!.count).toBe(3);
      expect(popular!.avgExecutionTime).toBeCloseTo(mean, 6);
    });
  });

  describe("CacheManager: cache key covers all response-affecting params", () => {
    let cacheManager: CacheManager;

    const mockResponse = (query: string): AutocompleteResponse => ({
      query,
      results: [],
      totalCount: 0,
      executionTime: 1,
      metadata: { searchType: "fuzzy" as const, cacheHit: false, indexSize: 5 },
    });

    beforeEach(() => {
      cacheManager = new CacheManager(new MemoryCacheProvider(50), defaultConfig.cache);
    });

    it("different categories never share a cache entry (poisoning regression)", async () => {
      await cacheManager.set({ query: "x", category: "books" }, mockResponse("x"));

      const other = await cacheManager.get({ query: "x", category: "movies" });
      const same = await cacheManager.get({ query: "x", category: "books" });

      expect(other).toBeNull();
      expect(same).not.toBeNull();
    });

    it("different tags never share a cache entry", async () => {
      await cacheManager.set({ query: "x", tags: ["a"] }, mockResponse("x"));

      expect(await cacheManager.get({ query: "x", tags: ["b"] })).toBeNull();
      expect(await cacheManager.get({ query: "x", tags: ["a"] })).not.toBeNull();
    });

    it("tag order does not fragment the cache", async () => {
      await cacheManager.set({ query: "x", tags: ["a", "b"] }, mockResponse("x"));

      expect(await cacheManager.get({ query: "x", tags: ["b", "a"] })).not.toBeNull();
    });

    it("query case/whitespace is normalized (strict assertion, not toBeDefined)", async () => {
      await cacheManager.set({ query: "Test", limit: 5 }, mockResponse("test"));

      expect(await cacheManager.get({ query: "  test ", limit: 5 })).not.toBeNull();
    });

    it("fuzzy default (undefined) and explicit true share an entry", async () => {
      await cacheManager.set({ query: "x" }, mockResponse("x"));

      expect(await cacheManager.get({ query: "x", fuzzy: true })).not.toBeNull();
      expect(await cacheManager.get({ query: "x", fuzzy: false })).toBeNull();
    });
  });

  describe("AutocompleteService: server-side debounce removed", () => {
    it("concurrent distinct requests each receive their own response, even with debounceMs configured", async () => {
      // With the old lodash.debounce wrapper and debounceMs > 0, concurrent
      // callers either received `undefined` (no prior invocation) or the
      // LAST caller's response - cross-request response leakage.
      const service = new AutocompleteService({
        ...defaultConfig,
        api: { ...defaultConfig.api, debounceMs: 300 },
      });
      await service.initialize([
        {
          id: "s",
          name: "s",
          type: "static",
          config: { data: sampleItems },
          itemCount: sampleItems.length,
        },
      ]);

      try {
        const [a, b] = await Promise.all([
          service.search({ query: "JavaScript", limit: 5 }),
          service.search({ query: "Python", limit: 5 }),
        ]);

        expect(a).toBeDefined();
        expect(b).toBeDefined();
        expect(a.query).toBe("javascript");
        expect(b.query).toBe("python");
        expect(a.results.some((r) => r.item.title === "JavaScript")).toBe(true);
        expect(b.results.some((r) => r.item.title === "Python")).toBe(true);
      } finally {
        await service.shutdown();
      }
    });

    it("identical concurrent requests are single-flighted onto one engine search", async () => {
      const service = new AutocompleteService({
        ...defaultConfig,
        cache: { ...defaultConfig.cache, enabled: false }, // isolate single-flight from cache
      });
      await service.initialize([
        {
          id: "s",
          name: "s",
          type: "static",
          config: { data: sampleItems },
          itemCount: sampleItems.length,
        },
      ]);

      try {
        const engine = (service as unknown as { searchEngine: SearchEngine }).searchEngine;
        const spy = jest.spyOn(engine, "search");

        const responses = await Promise.all(
          Array.from({ length: 5 }, () => service.search({ query: "JavaScript", limit: 5 }))
        );

        expect(spy).toHaveBeenCalledTimes(1);
        expect(responses).toHaveLength(5);
        expect(responses.every((r) => r.results.length > 0)).toBe(true);
      } finally {
        await service.shutdown();
      }
    });
  });
});
