/**
 * Advanced Search Engine for Autocomplete System
 *
 * This module implements a sophisticated search engine using Fuse.js
 * for fuzzy searching, with additional features like caching, analytics,
 * and multiple search strategies.
 *
 * Key Features:
 * - Fuzzy search with configurable sensitivity
 * - Multiple search strategies (exact, prefix, fuzzy)
 * - Result highlighting and scoring
 * - Search analytics and performance monitoring
 * - Intelligent query suggestions
 * - Category and tag filtering
 */

import Fuse from "fuse.js";
import {
  AutocompleteItem,
  SearchResult,
  AutocompleteRequest,
  AutocompleteResponse,
  SearchConfig,
  SearchAnalytics,
  IndexStats,
} from "./types.js";
import { SearchLimit } from "./constants";
import { PrefixIndex } from "./prefix-index";

/** Result item shape from Fuse.search() - mirrors Fuse.js FuseResult for ESM compatibility */
interface FuseResultItem {
  item: AutocompleteItem;
  refIndex?: number;
  score?: number;
  matches?: ReadonlyArray<{
    key?: string;
    value?: string;
    indices?: ReadonlyArray<readonly [number, number]>;
  }>;
}
/** Match item from FuseResult.matches */
type FuseResultMatchItem = NonNullable<FuseResultItem["matches"]>[number];

export class SearchEngine {
  private fuseIndex: Fuse<AutocompleteItem> | null = null;
  private prefixIndex: PrefixIndex = new PrefixIndex();
  private items: AutocompleteItem[] = [];
  private config: SearchConfig;
  private analytics: SearchAnalytics[] = [];
  private indexStats: IndexStats;

  constructor(config: SearchConfig) {
    const defaultConfig: SearchConfig = {
      // Default configuration with sensible defaults
      keys: [
        { name: "title", weight: 0.7 },
        { name: "description", weight: 0.3 },
        { name: "tags", weight: 0.2 },
        { name: "category", weight: 0.1 },
      ],
      threshold: 0.3, // 0.0 = perfect match, 1.0 = match anything
      distance: SearchLimit.MAX_LIMIT,
      includeScore: true,
      includeMatches: true,
      minMatchCharLength: 2,
      shouldSort: true,
      findAllMatches: true,
      location: 0,
      ignoreLocation: false,
      ignoreFieldNorm: false,
    };

    this.config = { ...defaultConfig, ...config };

    this.indexStats = {
      totalItems: 0,
      lastUpdated: new Date(),
      indexSize: 0,
      averageSearchTime: 0,
      cacheHitRate: 0,
      popularQueries: [],
    };
  }

  /**
   * Build or rebuild the search index
   * Why: Fuse.js creates an optimized index for fast searching
   */
  buildIndex(items: AutocompleteItem[]): void {
    console.warn(`🔨 Building search index with ${items.length} items`);
    const startTime = Date.now();

    this.items = [...items]; // Create copy to prevent external mutations

    // Create Fuse.js index with our configuration
    this.fuseIndex = new Fuse(this.items, {
      keys: this.config.keys,
      threshold: this.config.threshold,
      distance: this.config.distance,
      includeScore: this.config.includeScore,
      includeMatches: this.config.includeMatches,
      minMatchCharLength: this.config.minMatchCharLength,
      shouldSort: this.config.shouldSort,
      findAllMatches: this.config.findAllMatches,
      location: this.config.location,
      ignoreLocation: this.config.ignoreLocation,
      ignoreFieldNorm: this.config.ignoreFieldNorm,
    });

    // Build the trie for O(|prefix| + k) prefix lookups.
    this.prefixIndex.build(this.items);

    const buildTime = Date.now() - startTime;

    // Update index statistics
    this.indexStats = {
      ...this.indexStats,
      totalItems: items.length,
      lastUpdated: new Date(),
      indexSize: this.estimateIndexSize(),
      averageSearchTime: 0, // Will be calculated from actual searches
    };

    console.warn(`✅ Search index built in ${buildTime}ms`);
  }

  /**
   * Perform autocomplete search with multiple strategies
   */
  async search(request: AutocompleteRequest): Promise<AutocompleteResponse> {
    const startTime = Date.now();

    if (!this.fuseIndex) {
      throw new Error("Search index not built. Call buildIndex() first.");
    }

    console.warn(`🔍 Searching for: "${request.query}" (limit: ${request.limit || SearchLimit.DEFAULT_LIMIT})`);

    // Validate and sanitize request
    const sanitizedRequest = this.sanitizeRequest(request);

    // Determine search strategy based on query characteristics
    const searchStrategy = this.determineSearchStrategy(sanitizedRequest);

    // Perform the actual search
    const searchResults = await this.performSearch(sanitizedRequest, searchStrategy);

    // Apply post-processing filters, THEN the limit. Limiting before
    // filtering (the old order) silently dropped matching items: a category
    // filter could return 0 results even though matching items existed just
    // past the pre-filter cutoff.
    const filteredResults = this.applyFilters(searchResults, sanitizedRequest).slice(
      0,
      sanitizedRequest.limit || SearchLimit.DEFAULT_LIMIT
    );

    // Generate query suggestions if results are limited
    const suggestions = await this.generateSuggestions(sanitizedRequest, filteredResults);

    const executionTime = Date.now() - startTime;

    // Record analytics
    this.recordAnalytics({
      query: sanitizedRequest.query,
      resultCount: filteredResults.length,
      executionTime,
      timestamp: new Date(),
      cacheHit: false, // Would be true if result came from cache
    });

    // Update average search time
    this.updateAverageSearchTime(executionTime);

    const response: AutocompleteResponse = {
      query: sanitizedRequest.query,
      results: filteredResults,
      totalCount: filteredResults.length,
      executionTime,
      suggestions,
      metadata: {
        searchType: searchStrategy,
        cacheHit: false,
        indexSize: this.indexStats.totalItems,
      },
    };

    console.warn(`✅ Search completed: ${filteredResults.length} results in ${executionTime}ms`);
    return response;
  }

  /**
   * Sanitize and validate search request
   */
  private sanitizeRequest(request: AutocompleteRequest): AutocompleteRequest {
    return {
      query: request.query.trim().toLowerCase(),
      limit: Math.min(request.limit || SearchLimit.DEFAULT_LIMIT, SearchLimit.MAX_LIMIT), // Cap at max results
      category: request.category?.trim(),
      tags: request.tags?.map((tag) => tag.trim().toLowerCase()),
      fuzzy: request.fuzzy !== false, // Default to true
      // ?? (not ||): threshold 0 means "exact matches only" and must survive.
      // `request.threshold || default` silently replaced 0 with the default.
      threshold: Math.max(0, Math.min(1, request.threshold ?? this.config.threshold)),
    };
  }

  /**
   * Determine the best search strategy based on query characteristics
   */
  private determineSearchStrategy(request: AutocompleteRequest): "exact" | "fuzzy" | "prefix" {
    const query = request.query;

    // For very short queries, use prefix matching
    if (query.length <= 2) {
      return "prefix";
    }

    // For queries with special characters or exact phrases, try exact first
    if (query.includes('"') || query.includes("'")) {
      return "exact";
    }

    // For longer queries, use fuzzy search to handle typos
    if (query.length >= 5) {
      return "fuzzy";
    }

    // Default to fuzzy search
    return "fuzzy";
  }

  /**
   * Perform the actual search using the determined strategy
   */
  private async performSearch(
    request: AutocompleteRequest,
    strategy: "exact" | "fuzzy" | "prefix"
  ): Promise<SearchResult[]> {
    const limit = request.limit || SearchLimit.DEFAULT_LIMIT;

    // If category/tag/threshold filters will run AFTER this retrieval, we must
    // retrieve more than `limit` candidates or the filters can starve
    // legitimate matches that sit past the cutoff.
    // (threshold is deliberately excluded: results are score-sorted, so a
    // score cutoff applied to the top-k window can never starve matches)
    const hasPostFilters = !!(request.category || (request.tags && request.tags.length > 0));
    const retrieveLimit = hasPostFilters ? this.items.length : limit;

    let results: SearchResult[];

    switch (strategy) {
      case "exact": {
        // Previously "exact" ran the same fuzzy Fuse search as everything
        // else. Now it is an actual exact phrase match (quotes stripped)
        // over title, description, and tags.
        const phrase = request.query.replace(/["']/g, "").trim();
        results = [];
        for (const item of this.items) {
          const haystacks = [item.title, item.description || "", ...(item.tags || [])];
          if (haystacks.some((h) => h.toLowerCase().includes(phrase))) {
            results.push(this.buildDirectResult(item, phrase));
            if (results.length >= retrieveLimit) break;
          }
        }
        break;
      }

      case "prefix": {
        // Trie lookup: O(|prefix| + k). The old code passed `^query` to
        // Fuse.js, but the `^` operator requires useExtendedSearch: true
        // (never set), so the caret was fuzzy-matched as a literal char.
        const items = this.prefixIndex.search(request.query, retrieveLimit);
        results = items.map((item) => this.buildDirectResult(item, request.query));
        break;
      }

      case "fuzzy":
      default: {
        const fuseResults = this.fuseIndex!.search(request.query, {
          limit: retrieveLimit,
        }) as FuseResultItem[];
        results = fuseResults.map((fuseResult) =>
          this.convertFuseResult(fuseResult, request.query)
        );
        break;
      }
    }
    if (request.query.length >= 4) {
      results.sort((a, b) => {
        const aTitleExact = a.item.title.toLowerCase() === request.query.toLowerCase() ? -1 : 0;
        const bTitleExact = b.item.title.toLowerCase() === request.query.toLowerCase() ? -1 : 0;
        if (aTitleExact !== bTitleExact) return aTitleExact - bTitleExact;
        return (a.score || 0) - (b.score || 0);
      });
    }
    return results;
  }

  /**
   * Convert Fuse.js result to our SearchResult format
   */
  private convertFuseResult(fuseResult: FuseResultItem, _query: string): SearchResult {
    const searchResult: SearchResult = {
      item: fuseResult.item,
      score: fuseResult.score || 0,
      matches: [],
      highlightedTitle: fuseResult.item.title,
      highlightedDescription: fuseResult.item.description,
    };

    // Process matches for highlighting
    if (fuseResult.matches) {
      searchResult.matches = fuseResult.matches.map((match: FuseResultMatchItem) => ({
        field: match.key ?? "",
        value: match.value ?? "",
        indices: [...(match.indices ?? [])] as [number, number][],
      }));

      // Apply highlighting to title and description
      const titleMatch = fuseResult.matches.find((m: FuseResultMatchItem) => m.key === "title");
      searchResult.highlightedTitle = this.highlightMatches(fuseResult.item.title, titleMatch);

      if (fuseResult.item.description) {
        const descMatch = fuseResult.matches.find(
          (m: FuseResultMatchItem) => m.key === "description"
        );
        searchResult.highlightedDescription = this.highlightMatches(
          fuseResult.item.description,
          descMatch
        );
      }
    }

    return searchResult;
  }

  /**
   * Escape HTML special characters. Highlighted fields are HTML fragments
   * (they contain <mark> tags), so item data MUST be escaped before marks
   * are inserted or any item whose title/description contains markup becomes
   * a stored-XSS vector when the frontend renders the fragment.
   */
  private escapeHtml(text: string): string {
    return text
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  /**
   * Build a SearchResult directly from an item (prefix/exact strategies),
   * highlighting the first case-insensitive occurrence of the query.
   */
  private buildDirectResult(item: AutocompleteItem, query: string): SearchResult {
    const highlight = (text: string | undefined): string | undefined => {
      if (text === undefined) return undefined;
      const idx = query ? text.toLowerCase().indexOf(query.toLowerCase()) : -1;
      if (idx < 0) return this.escapeHtml(text);
      return (
        this.escapeHtml(text.slice(0, idx)) +
        `<mark>${this.escapeHtml(text.slice(idx, idx + query.length))}</mark>` +
        this.escapeHtml(text.slice(idx + query.length))
      );
    };

    return {
      item,
      score: 0, // Direct (non-fuzzy) matches are perfect matches in Fuse terms
      matches: [],
      highlightedTitle: highlight(item.title),
      highlightedDescription: highlight(item.description),
    };
  }

  /**
   * Apply highlighting to matched text.
   * Escapes HTML (see escapeHtml) and merges overlapping match ranges so the
   * output never contains nested/broken <mark> tags.
   */
  private highlightMatches(text: string, match?: FuseResultMatchItem): string {
    if (!match || !match.indices || match.indices.length === 0) {
      return this.escapeHtml(text);
    }

    // Sort, then merge overlapping/adjacent ranges
    const sorted = [...match.indices].sort(
      (a: readonly [number, number], b: readonly [number, number]) => a[0] - b[0]
    );
    const merged: Array<[number, number]> = [];
    for (const [start, end] of sorted) {
      const last = merged[merged.length - 1];
      if (last && start <= last[1] + 1) {
        last[1] = Math.max(last[1], end);
      } else {
        merged.push([start, end]);
      }
    }

    let highlightedText = "";
    let lastIndex = 0;

    for (const [start, end] of merged) {
      highlightedText += this.escapeHtml(text.slice(lastIndex, start));
      highlightedText += `<mark>${this.escapeHtml(text.slice(start, end + 1))}</mark>`;
      lastIndex = end + 1;
    }

    highlightedText += this.escapeHtml(text.slice(lastIndex));

    return highlightedText;
  }

  /**
   * Apply additional filters to search results
   */
  private applyFilters(results: SearchResult[], request: AutocompleteRequest): SearchResult[] {
    let filteredResults = results;

    // Filter by category if specified
    if (request.category) {
      filteredResults = filteredResults.filter(
        (result) => result.item.category.toLowerCase() === request.category!.toLowerCase()
      );
    }

    // Filter by tags if specified
    if (request.tags && request.tags.length > 0) {
      filteredResults = filteredResults.filter((result) =>
        request.tags!.some((tag) =>
          result.item.tags.some((itemTag) => itemTag.toLowerCase().includes(tag))
        )
      );
    }

    // Apply score threshold (!== undefined, not truthiness: threshold 0
    // means "perfect matches only" and was previously skipped entirely)
    if (request.threshold !== undefined) {
      filteredResults = filteredResults.filter(
        (result) => result.score <= request.threshold! // Lower score = better match in Fuse.js
      );
    }

    return filteredResults;
  }

  /**
   * Generate intelligent query suggestions
   */
  private async generateSuggestions(
    request: AutocompleteRequest,
    results: SearchResult[]
  ): Promise<string[]> {
    const suggestions: string[] = [];

    // If we have few results, suggest related terms
    if (results.length < 3) {
      // Find items with similar categories
      const relatedItems = this.items.filter(
        (item) =>
          results.some((result) => result.item.category === item.category) &&
          !results.some((result) => result.item.id === item.id)
      );

      // Extract common words from related items
      const commonWords = this.extractCommonWords(relatedItems, request.query);
      suggestions.push(...commonWords.slice(0, 3));
    }

    // Suggest popular queries if available
    const popularQueries = this.getPopularQueries(request.query);
    suggestions.push(...popularQueries.slice(0, 2));

    return [...new Set(suggestions)]; // Remove duplicates
  }

  /**
   * Extract common words from related items
   */
  private extractCommonWords(items: AutocompleteItem[], excludeQuery: string): string[] {
    const wordCounts = new Map<string, number>();
    const excludeWords = new Set(excludeQuery.toLowerCase().split(/\s+/));

    for (const item of items) {
      const words = [
        ...item.title.toLowerCase().split(/\s+/),
        ...item.tags.map((tag) => tag.toLowerCase()),
        ...(item.description?.toLowerCase().split(/\s+/) || []),
      ];

      for (const word of words) {
        if (word.length > 2 && !excludeWords.has(word)) {
          wordCounts.set(word, (wordCounts.get(word) || 0) + 1);
        }
      }
    }

    return Array.from(wordCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([word]) => word)
      .slice(0, 5);
  }

  /**
   * Get popular queries similar to the current query
   */
  private getPopularQueries(currentQuery: string): string[] {
    return this.indexStats.popularQueries
      .filter((pq) => pq.query !== currentQuery && pq.query.includes(currentQuery.slice(0, 3)))
      .sort((a, b) => b.count - a.count)
      .map((pq) => pq.query)
      .slice(0, 3);
  }

  /**
   * Record search analytics
   */
  private recordAnalytics(analytics: SearchAnalytics): void {
    this.analytics.push(analytics);

    // Keep only last N analytics entries to prevent memory issues
    if (this.analytics.length > SearchLimit.MAX_ANALYTICS_SIZE) {
      this.analytics = this.analytics.slice(-SearchLimit.MAX_ANALYTICS_SIZE);
    }

    // Update popular queries
    this.updatePopularQueries(analytics.query);
  }

  /**
   * Update popular queries statistics
   */
  private updatePopularQueries(query: string): void {
    const existing = this.indexStats.popularQueries.find((pq) => pq.query === query);

    if (existing) {
      // True running mean. The old formula ((avg + latest) / 2) is an
      // exponentially-weighted drift, not an average: after N searches the
      // first sample's weight is 1/2^(N-1).
      const latest = this.analytics[this.analytics.length - 1].executionTime;
      existing.avgExecutionTime =
        (existing.avgExecutionTime * existing.count + latest) / (existing.count + 1);
      existing.count++;
    } else {
      this.indexStats.popularQueries.push({
        query,
        count: 1,
        avgExecutionTime: this.analytics[this.analytics.length - 1].executionTime,
      });
    }

    // Keep only top N popular queries
    this.indexStats.popularQueries.sort((a, b) => b.count - a.count);
    this.indexStats.popularQueries = this.indexStats.popularQueries.slice(0, SearchLimit.POPULAR_QUERIES_TOP);
  }

  /**
   * Update average search time
   */
  private updateAverageSearchTime(executionTime: number): void {
    const totalSearches = this.analytics.length;
    if (totalSearches === 1) {
      this.indexStats.averageSearchTime = executionTime;
    } else {
      this.indexStats.averageSearchTime =
        (this.indexStats.averageSearchTime * (totalSearches - 1) + executionTime) / totalSearches;
    }
  }

  /**
   * Estimate index size in bytes (rough approximation)
   */
  private estimateIndexSize(): number {
    return this.items.reduce((size, item) => {
      return (
        size +
        item.title.length * SearchLimit.ESTIMATED_BYTES_PER_CHAR + // UTF-16 encoding
        (item.description?.length || 0) * SearchLimit.ESTIMATED_BYTES_PER_CHAR +
        item.tags.join("").length * SearchLimit.ESTIMATED_BYTES_PER_CHAR +
        item.category.length * SearchLimit.ESTIMATED_BYTES_PER_CHAR +
        SearchLimit.MAX_ITEM_SIZE_BYTES
      ); // Overhead for object structure
    }, 0);
  }

  /**
   * Get search analytics and statistics
   */
  getAnalytics(): {
    recentSearches: SearchAnalytics[];
    indexStats: IndexStats;
    performanceMetrics: {
      totalSearches: number;
      averageExecutionTime: number;
      slowestQuery: string;
      fastestQuery: string;
    };
  } {
    const recentSearches = this.analytics.slice(-SearchLimit.RECENT_SEARCHES_COUNT); // Last N searches

    let slowestQuery = "";
    let fastestQuery = "";
    let slowestTime = 0;
    let fastestTime = Infinity;

    for (const search of this.analytics) {
      if (search.executionTime > slowestTime) {
        slowestTime = search.executionTime;
        slowestQuery = search.query;
      }
      if (search.executionTime < fastestTime) {
        fastestTime = search.executionTime;
        fastestQuery = search.query;
      }
    }

    return {
      recentSearches,
      indexStats: this.indexStats,
      performanceMetrics: {
        totalSearches: this.analytics.length,
        averageExecutionTime: this.indexStats.averageSearchTime,
        slowestQuery,
        fastestQuery,
      },
    };
  }

  /**
   * Update search configuration
   */
  updateConfig(newConfig: Partial<SearchConfig>): void {
    this.config = { ...this.config, ...newConfig };

    // Rebuild index if it exists
    if (this.fuseIndex && this.items.length > 0) {
      console.warn("🔄 Rebuilding index with new configuration");
      this.buildIndex(this.items);
    }
  }

  /**
   * Clear analytics data
   */
  clearAnalytics(): void {
    this.analytics = [];
    this.indexStats.popularQueries = [];
    this.indexStats.averageSearchTime = 0;
    console.warn("🧹 Analytics data cleared");
  }
}
