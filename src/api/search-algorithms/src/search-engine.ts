/**
 * Comprehensive Search Engine Implementation
 *
 * This is the main search engine that orchestrates all the different
 * search algorithms and provides a unified interface for searching.
 * It demonstrates how to combine multiple search strategies for
 * optimal results.
 */

import { StringMatcher } from "./algorithms/string-matching";
import { PhoneticMatcher } from "./algorithms/phonetic-matching";
import { NGramMatcher } from "./algorithms/ngram-matching";
import { RankingAlgorithms } from "./algorithms/ranking-algorithms";
import { InvertedIndex } from "./algorithms/inverted-index";
import {
  SearchableItem,
  SearchRequest,
  SearchResponse,
  SearchResult,
  SearchOptions,
  SearchAlgorithm,
  SearchMatch,
  SearchMetrics,
  SearchAnalytics,
} from "./types";
import { SearchEngineLimit, SearchAlgorithmName } from "./constants";

export class SearchEngine {
  private items: SearchableItem[] = [];
  // Lazily-built inverted index for BM25/TF-IDF/semantic ranking. Invalidated
  // whenever the corpus changes and rebuilt on first ranking query so repeated
  // queries against a stable corpus don't re-scan every document each time.
  private rankingIndex: InvertedIndex | null = null;
  private analytics: SearchAnalytics[] = [];
  private maxAnalyticsSize: number = SearchEngineLimit.MAX_ANALYTICS_SIZE; // Configurable limit for analytics buffer
  private metrics: SearchMetrics = {
    totalSearches: 0,
    averageExecutionTime: 0,
    algorithmUsage: {} as Record<SearchAlgorithm, number>,
    popularQueries: [],
    indexSize: 0,
    cacheHitRate: 0,
  };

  constructor(
    items: SearchableItem[] = [],
    maxAnalyticsSize: number = SearchEngineLimit.MAX_ANALYTICS_SIZE
  ) {
    this.items = [...items];
    this.maxAnalyticsSize = maxAnalyticsSize;
    this.updateMetrics();
  }

  /**
   * Add items to the search index
   */
  addItems(newItems: SearchableItem[]): void {
    this.items.push(...newItems);
    this.rankingIndex = null; // corpus changed — drop the cached inverted index
    this.updateMetrics();
    console.warn(`📚 Added ${newItems.length} items to search index`);
  }

  /**
   * Update existing items in the search index
   */
  updateItems(updatedItems: SearchableItem[]): void {
    for (const updatedItem of updatedItems) {
      const index = this.items.findIndex((item) => item.id === updatedItem.id);
      if (index !== -1) {
        this.items[index] = updatedItem;
      }
    }
    this.rankingIndex = null; // corpus changed — drop the cached inverted index
    this.updateMetrics();
    console.warn(`🔄 Updated ${updatedItems.length} items in search index`);
  }

  /**
   * Remove items from the search index
   */
  removeItems(itemIds: string[]): void {
    this.items = this.items.filter((item) => !itemIds.includes(item.id));
    this.rankingIndex = null; // corpus changed — drop the cached inverted index
    this.updateMetrics();
    console.warn(`🗑️ Removed ${itemIds.length} items from search index`);
  }

  /**
   * Return the inverted index for the current corpus, building it on first use
   * and reusing it until the corpus changes. This is what makes repeated BM25 /
   * TF-IDF queries fast: the O(N * L) tokenize-and-count pass runs once, not
   * per query.
   */
  private getRankingIndex(): InvertedIndex {
    if (!this.rankingIndex) {
      this.rankingIndex = new InvertedIndex(this.items);
    }
    return this.rankingIndex;
  }

  /**
   * Main search method that orchestrates different algorithms
   */
  async search(request: SearchRequest): Promise<SearchResponse> {
    const startTime = Date.now();
    const { query, options } = request;

    console.warn(`🔍 Searching for: "${query}" using ${options.algorithm} algorithm`);

    // Validate request
    if (!query || query.trim().length === 0) {
      return this.createEmptyResponse(query, options.algorithm, 0);
    }

    let results: SearchResult[] = [];

    try {
      // Route to appropriate search algorithm
      switch (options.algorithm) {
        case "exact":
          results = await this.exactSearch(query, options);
          break;
        case "prefix":
          results = await this.prefixSearch(query, options);
          break;
        case "suffix":
          results = await this.suffixSearch(query, options);
          break;
        case "contains":
          results = await this.containsSearch(query, options);
          break;
        case "fuzzy":
          results = await this.fuzzySearch(query, options);
          break;
        case "phonetic":
          results = await this.phoneticSearch(query, options);
          break;
        case "regex":
          results = await this.regexSearch(query, options);
          break;
        case "wildcard":
          results = await this.wildcardSearch(query, options);
          break;
        case "ngram":
          results = await this.ngramSearch(query, options);
          break;
        case SearchAlgorithmName.BM25:
          results = await this.bm25Search(query, options);
          break;
        case "tfidf":
          results = await this.tfidfSearch(query, options);
          break;
        case "semantic":
          results = await this.semanticSearch(query, options);
          break;
        case "compound":
          results = await this.compoundSearch(query, options);
          break;
        default:
          results = await this.fuzzySearch(query, options);
      }

      // Apply filters if specified
      if (request.filters && request.filters.length > 0) {
        results = this.applyFilters(results, request.filters);
      }

      // Apply result limits and scoring thresholds
      results = this.postProcessResults(results, options);

      const executionTime = Date.now() - startTime;

      // Record analytics
      this.recordAnalytics({
        query,
        algorithm: options.algorithm,
        resultCount: results.length,
        executionTime,
        timestamp: new Date(),
      });

      // Generate suggestions if results are limited
      const suggestions = results.length < 3 ? await this.generateSuggestions(query) : undefined;

      const response: SearchResponse = {
        query,
        results,
        totalCount: results.length,
        executionTime,
        algorithm: options.algorithm,
        suggestions,
        metadata: {
          searchType: options.algorithm,
          resultsFound: results.length,
          maxScore: results.length > 0 ? Math.max(...results.map((r) => r.score)) : 0,
          minScore: results.length > 0 ? Math.min(...results.map((r) => r.score)) : 0,
        },
      };

      console.warn(`✅ Search completed: ${results.length} results in ${executionTime}ms`);
      return response;
    } catch (error) {
      console.warn("❌ Search failed:", error);
      const executionTime = Date.now() - startTime;
      return this.createEmptyResponse(query, options.algorithm, executionTime);
    }
  }

  /**
   * Exact String Matching
   */
  private async exactSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const fields = options.fields || ["title", "description", "content"];

    for (const item of this.items) {
      let totalScore = 0;
      const allMatches: SearchMatch[] = [];

      for (const field of fields) {
        const fieldValue = this.getFieldValue(item, field);
        if (!fieldValue) continue;

        const matches = StringMatcher.exactMatch(fieldValue, query, options.caseSensitive);
        if (matches.length > 0) {
          allMatches.push(...matches.map((match) => ({ ...match, field })));
          totalScore += matches.length;
        }
      }

      if (totalScore > 0) {
        results.push({
          item,
          score: totalScore,
          matches: allMatches,
          highlightedFields: options.highlightMatches
            ? this.highlightMatches(item, allMatches)
            : undefined,
          algorithm: "exact",
          executionTime: 0,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Prefix Matching
   */
  private async prefixSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const fields = options.fields || ["title", "description", "content"];

    for (const item of this.items) {
      let totalScore = 0;
      const allMatches: SearchMatch[] = [];

      for (const field of fields) {
        const fieldValue = this.getFieldValue(item, field);
        if (!fieldValue) continue;

        const matches = StringMatcher.prefixMatch(fieldValue, query, options.caseSensitive);
        if (matches.length > 0) {
          allMatches.push(...matches.map((match) => ({ ...match, field })));
          totalScore += matches.length * 2; // Prefix matches get higher score
        }
      }

      if (totalScore > 0) {
        results.push({
          item,
          score: totalScore,
          matches: allMatches,
          highlightedFields: options.highlightMatches
            ? this.highlightMatches(item, allMatches)
            : undefined,
          algorithm: "prefix",
          executionTime: 0,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Suffix Matching
   */
  private async suffixSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const fields = options.fields || ["title", "description", "content"];

    for (const item of this.items) {
      let totalScore = 0;
      const allMatches: SearchMatch[] = [];

      for (const field of fields) {
        const fieldValue = this.getFieldValue(item, field);
        if (!fieldValue) continue;

        const matches = StringMatcher.suffixMatch(fieldValue, query, options.caseSensitive);
        if (matches.length > 0) {
          allMatches.push(...matches.map((match) => ({ ...match, field })));
          totalScore += matches.length;
        }
      }

      if (totalScore > 0) {
        results.push({
          item,
          score: totalScore,
          matches: allMatches,
          highlightedFields: options.highlightMatches
            ? this.highlightMatches(item, allMatches)
            : undefined,
          algorithm: "suffix",
          executionTime: 0,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Contains Matching
   */
  private async containsSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const fields = options.fields || ["title", "description", "content"];

    for (const item of this.items) {
      let totalScore = 0;
      const allMatches: SearchMatch[] = [];

      for (const field of fields) {
        const fieldValue = this.getFieldValue(item, field);
        if (!fieldValue) continue;

        const matches = StringMatcher.containsMatch(fieldValue, query, options.caseSensitive);
        if (matches.length > 0) {
          allMatches.push(...matches.map((match) => ({ ...match, field })));
          totalScore += matches.length;
        }
      }

      if (totalScore > 0) {
        results.push({
          item,
          score: totalScore,
          matches: allMatches,
          highlightedFields: options.highlightMatches
            ? this.highlightMatches(item, allMatches)
            : undefined,
          algorithm: "contains",
          executionTime: 0,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Fuzzy Matching using Levenshtein Distance
   */
  private async fuzzySearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const fields = options.fields || ["title", "description", "content"];
    const threshold = options.fuzzyThreshold || 0.7;

    for (const item of this.items) {
      let bestScore = 0;
      const allMatches: SearchMatch[] = [];

      for (const field of fields) {
        const fieldValue = this.getFieldValue(item, field);
        if (!fieldValue) continue;

        // For fuzzy search, compare the query against each field word.
        // tokenizeWithOffsets strips punctuation and gives the exact position of
        // every word, so repeated words highlight correctly.
        const words = this.tokenizeWithOffsets(fieldValue);

        for (const { word, start } of words) {
          // Optimize: skip words with drastically different lengths
          const lengthDiff = Math.abs(word.length - query.length);
          const maxLengthDiff = Math.ceil(query.length * (1 - threshold));
          if (lengthDiff > maxLengthDiff) continue;

          const similarity = StringMatcher.calculateSimilarity(word, query, "levenshtein");

          if (similarity >= threshold) {
            allMatches.push({
              field,
              value: word,
              startIndex: start,
              endIndex: start + word.length - 1,
              matchType: "fuzzy",
            });
            bestScore = Math.max(bestScore, similarity);
          }
        }
      }

      if (bestScore > 0) {
        results.push({
          item,
          score: bestScore,
          matches: allMatches,
          highlightedFields: options.highlightMatches
            ? this.highlightMatches(item, allMatches)
            : undefined,
          algorithm: "fuzzy",
          executionTime: 0,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Phonetic Matching
   */
  private async phoneticSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const fields = options.fields || ["title", "description", "content"];
    const threshold = options.phoneticThreshold || 0.8;

    for (const item of this.items) {
      let bestScore = 0;
      const allMatches: SearchMatch[] = [];

      for (const field of fields) {
        const fieldValue = this.getFieldValue(item, field);
        if (!fieldValue) continue;

        const words = this.tokenizeWithOffsets(fieldValue);

        for (const { word, start } of words) {
          const similarity = PhoneticMatcher.phoneticSimilarity(word, query, "metaphone");

          if (similarity >= threshold) {
            allMatches.push({
              field,
              value: word,
              startIndex: start,
              endIndex: start + word.length - 1,
              matchType: "phonetic",
            });
            bestScore = Math.max(bestScore, similarity);
          }
        }
      }

      if (bestScore > 0) {
        results.push({
          item,
          score: bestScore,
          matches: allMatches,
          highlightedFields: options.highlightMatches
            ? this.highlightMatches(item, allMatches)
            : undefined,
          algorithm: "phonetic",
          executionTime: 0,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Regular Expression Search
   */
  private async regexSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const fields = options.fields || ["title", "description", "content"];

    try {
      const flags = options.caseSensitive ? "g" : "gi";
      const regex = new RegExp(query, flags);

      for (const item of this.items) {
        let totalScore = 0;
        const allMatches: SearchMatch[] = [];

        for (const field of fields) {
          const fieldValue = this.getFieldValue(item, field);
          if (!fieldValue) continue;

          let match;
          while ((match = regex.exec(fieldValue)) !== null) {
            allMatches.push({
              field,
              value: match[0],
              startIndex: match.index,
              endIndex: match.index + match[0].length - 1,
              matchType: "exact",
            });
            totalScore++;
          }
        }

        if (totalScore > 0) {
          results.push({
            item,
            score: totalScore,
            matches: allMatches,
            highlightedFields: options.highlightMatches
              ? this.highlightMatches(item, allMatches)
              : undefined,
            algorithm: "regex",
            executionTime: 0,
          });
        }
      }
    } catch {
      console.warn("Invalid regex pattern:", query);
      return [];
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Wildcard Search
   */
  private async wildcardSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const fields = options.fields || ["title", "description", "content"];

    for (const item of this.items) {
      let totalScore = 0;
      const allMatches: SearchMatch[] = [];

      for (const field of fields) {
        const fieldValue = this.getFieldValue(item, field);
        if (!fieldValue) continue;

        const words = this.tokenizeWithOffsets(fieldValue);

        for (const { word, start } of words) {
          const searchWord = options.caseSensitive ? word : word.toLowerCase();
          const searchQuery = options.caseSensitive ? query : query.toLowerCase();

          if (StringMatcher.wildcardMatch(searchWord, searchQuery)) {
            allMatches.push({
              field,
              value: word,
              startIndex: start,
              endIndex: start + word.length - 1,
              matchType: "exact",
            });
            totalScore++;
          }
        }
      }

      if (totalScore > 0) {
        results.push({
          item,
          score: totalScore,
          matches: allMatches,
          highlightedFields: options.highlightMatches
            ? this.highlightMatches(item, allMatches)
            : undefined,
          algorithm: "wildcard",
          executionTime: 0,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * N-gram Based Search
   */
  private async ngramSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const results: SearchResult[] = [];
    const fields = options.fields || ["title", "description", "content"];
    const threshold = options.fuzzyThreshold || 0.3;

    for (const item of this.items) {
      let bestScore = 0;
      const allMatches: SearchMatch[] = [];

      for (const field of fields) {
        const fieldValue = this.getFieldValue(item, field);
        if (!fieldValue) continue;

        // Whole-field Jaccard collapses toward zero when the query is much
        // shorter than a multi-word field (their padded bigram sets barely
        // overlap in proportion to their union), so a one-word query rarely
        // clears the threshold against a real document. Compare the query
        // against each field WORD as well and keep the best match, so ngram
        // search actually finds short queries inside long fields. The
        // whole-field score is retained as a floor for cross-word similarity.
        const wholeFieldSim = NGramMatcher.jaccardSimilarity(
          fieldValue,
          query,
          2,
          !options.caseSensitive
        );

        let fieldBest = wholeFieldSim;
        let bestWord: { word: string; start: number } | null = null;

        for (const token of this.tokenizeWithOffsets(fieldValue)) {
          const wordSim = NGramMatcher.jaccardSimilarity(
            token.word,
            query,
            2,
            !options.caseSensitive
          );
          if (wordSim > fieldBest) {
            fieldBest = wordSim;
            bestWord = token;
          }
        }

        if (fieldBest >= threshold) {
          // Highlight the best-matching word when one beat the whole-field
          // score; otherwise fall back to marking the whole field.
          if (bestWord) {
            allMatches.push({
              field,
              value: bestWord.word,
              startIndex: bestWord.start,
              endIndex: bestWord.start + bestWord.word.length - 1,
              matchType: "fuzzy",
            });
          } else {
            allMatches.push({
              field,
              value: fieldValue,
              startIndex: 0,
              endIndex: fieldValue.length - 1,
              matchType: "fuzzy",
            });
          }
          bestScore = Math.max(bestScore, fieldBest);
        }
      }

      if (bestScore > 0) {
        results.push({
          item,
          score: bestScore,
          matches: allMatches,
          highlightedFields: options.highlightMatches
            ? this.highlightMatches(item, allMatches)
            : undefined,
          algorithm: "ngram",
          executionTime: 0,
        });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * BM25 Ranking Search
   */
  private async bm25Search(query: string, options: SearchOptions): Promise<SearchResult[]> {
    // Use the cached inverted index instead of re-scanning every document.
    const bm25Results = this.getRankingIndex().bm25(query);

    return bm25Results.map((result) => ({
      item: result.item,
      score: result.score,
      matches: this.createMatchesFromTerms(result.item, query, Object.keys(result.termScores)),
      highlightedFields: options.highlightMatches
        ? this.highlightQuery(result.item, query)
        : undefined,
      algorithm: SearchAlgorithmName.BM25 as SearchAlgorithm,
      executionTime: 0,
    }));
  }

  /**
   * TF-IDF Search
   */
  private async tfidfSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    // Use the cached inverted index instead of re-scanning every document.
    const tfidfResults = this.getRankingIndex().tfidf(query);

    return tfidfResults.map((result) => ({
      item: result.item,
      score: result.score,
      matches: this.createMatchesFromTerms(result.item, query, Object.keys(result.termScores)),
      highlightedFields: options.highlightMatches
        ? this.highlightQuery(result.item, query)
        : undefined,
      algorithm: "tfidf" as SearchAlgorithm,
      executionTime: 0,
    }));
  }

  /**
   * Semantic Search (simplified cosine similarity)
   */
  private async semanticSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    const semanticResults = RankingAlgorithms.calculateCosineSimilarity(this.items, query);

    return semanticResults.map((result) => ({
      item: result.item,
      score: result.score,
      matches: this.createMatchesFromTerms(result.item, query, query.split(/\s+/)),
      highlightedFields: options.highlightMatches
        ? this.highlightQuery(result.item, query)
        : undefined,
      algorithm: "semantic" as SearchAlgorithm,
      executionTime: 0,
    }));
  }

  /**
   * Compound Search (combines multiple algorithms)
   */
  private async compoundSearch(query: string, options: SearchOptions): Promise<SearchResult[]> {
    // Run multiple search algorithms and combine results
    const [exactResults, fuzzyResults, bm25Results] = await Promise.all([
      this.exactSearch(query, { ...options, algorithm: "exact" }),
      this.fuzzySearch(query, { ...options, algorithm: "fuzzy" }),
      this.bm25Search(query, { ...options, algorithm: SearchAlgorithmName.BM25 }),
    ]);

    // Combine and deduplicate results
    const combinedResults = new Map<string, SearchResult>();

    // Add exact matches with highest weight
    for (const result of exactResults) {
      combinedResults.set(result.item.id, {
        ...result,
        score: result.score * 3, // Boost exact matches
        algorithm: "compound",
      });
    }

    // Add fuzzy matches
    for (const result of fuzzyResults) {
      const existing = combinedResults.get(result.item.id);
      if (existing) {
        existing.score += result.score * 1.5;
        existing.matches.push(...result.matches);
      } else {
        combinedResults.set(result.item.id, {
          ...result,
          score: result.score * 1.5,
          algorithm: "compound",
        });
      }
    }

    // Add BM25 results
    for (const result of bm25Results) {
      const existing = combinedResults.get(result.item.id);
      if (existing) {
        existing.score += result.score;
        existing.matches.push(...result.matches);
      } else {
        combinedResults.set(result.item.id, {
          ...result,
          algorithm: "compound",
        });
      }
    }

    return Array.from(combinedResults.values()).sort((a, b) => b.score - a.score);
  }

  /**
   * Helper Methods
   */

  /**
   * Split a field into words while recording each word's true start offset.
   *
   * The frozen implementation used `fieldValue.split(/\s+/)` and then
   * `fieldValue.indexOf(word)` to recover positions. That has two bugs:
   *   1. Punctuation stays glued to words ("TypeScript," never equals the query
   *      "TypeScript"), hurting fuzzy/phonetic/wildcard recall.
   *   2. `indexOf` from the start returns the FIRST occurrence, so every repeat
   *      of a word reports the same (wrong) offset — corrupting highlighting.
   * Tracking offsets during a single regex scan fixes both.
   */
  private tokenizeWithOffsets(text: string): Array<{ word: string; start: number }> {
    const tokens: Array<{ word: string; start: number }> = [];
    // Unicode-aware word matcher: letters/numbers/underscore/apostrophes.
    const re = /[\p{L}\p{N}_']+/gu;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      tokens.push({ word: match[0], start: match.index });
    }
    return tokens;
  }

  private getFieldValue(item: SearchableItem, field: string): string {
    switch (field) {
      case "title":
        return item.title;
      case "description":
        return item.description || "";
      case "content":
        return item.content || "";
      case "tags":
        return (item.tags || []).join(" ");
      case "category":
        return item.category || "";
      default: {
        const v = item.metadata?.[field];
        return typeof v === "string" ? v : "";
      }
    }
  }

  private highlightMatches(item: SearchableItem, matches: SearchMatch[]): Record<string, string> {
    const highlighted: Record<string, string> = {};

    for (const match of matches) {
      const fieldValue = this.getFieldValue(item, match.field);
      if (!highlighted[match.field]) {
        highlighted[match.field] = fieldValue;
      }

      // Simple highlighting - replace matched text with <mark> tags
      const before = highlighted[match.field].substring(0, match.startIndex);
      const matchText = highlighted[match.field].substring(match.startIndex, match.endIndex + 1);
      const after = highlighted[match.field].substring(match.endIndex + 1);

      highlighted[match.field] = before + `<mark>${matchText}</mark>` + after;
    }

    return highlighted;
  }

  private highlightQuery(item: SearchableItem, query: string): Record<string, string> {
    const highlighted: Record<string, string> = {};
    const queryTerms = query.toLowerCase().split(/\s+/);

    const fields = ["title", "description", "content"];
    for (const field of fields) {
      const fieldValue = this.getFieldValue(item, field);
      if (!fieldValue) continue;

      let highlightedValue = fieldValue;
      for (const term of queryTerms) {
        const regex = new RegExp(`\\b${term}\\b`, "gi");
        highlightedValue = highlightedValue.replace(regex, `<mark>$&</mark>`);
      }

      highlighted[field] = highlightedValue;
    }

    return highlighted;
  }

  private createMatchesFromTerms(
    item: SearchableItem,
    query: string,
    terms: string[]
  ): SearchMatch[] {
    const matches: SearchMatch[] = [];
    const fields = ["title", "description", "content"];

    for (const field of fields) {
      const fieldValue = this.getFieldValue(item, field);
      if (!fieldValue) continue;

      for (const term of terms) {
        const index = fieldValue.toLowerCase().indexOf(term.toLowerCase());
        if (index !== -1) {
          matches.push({
            field,
            value: term,
            startIndex: index,
            endIndex: index + term.length - 1,
            matchType: "exact",
          });
        }
      }
    }

    return matches;
  }

  private applyFilters(results: SearchResult[], filters: unknown[]): SearchResult[] {
    // Apply filters to results
    return results.filter((result) => {
      return filters.every((filter: unknown) => {
        const f = filter as { field: string; operator: string; value: unknown };
        const fieldValue = this.getFieldValue(result.item, f.field);

        switch (f.operator) {
          case "equals":
            return fieldValue === f.value;
          case "contains":
            return fieldValue.toLowerCase().includes(String(f.value).toLowerCase());
          case "startsWith":
            return fieldValue.toLowerCase().startsWith(String(f.value).toLowerCase());
          case "endsWith":
            return fieldValue.toLowerCase().endsWith(String(f.value).toLowerCase());
          case "in":
            return Array.isArray(f.value) && f.value.includes(fieldValue);
          default:
            return true;
        }
      });
    });
  }

  private postProcessResults(results: SearchResult[], options: SearchOptions): SearchResult[] {
    let processedResults = results;

    // Apply minimum score threshold
    if (options.minScore !== undefined) {
      processedResults = processedResults.filter((result) => result.score >= options.minScore!);
    }

    // Apply maximum results limit
    if (options.maxResults !== undefined) {
      processedResults = processedResults.slice(0, options.maxResults);
    }

    return processedResults;
  }

  private async generateSuggestions(query: string): Promise<string[]> {
    // Simple suggestion generation based on existing items
    const suggestions = new Set<string>();

    for (const item of this.items) {
      const words = [
        ...item.title.split(/\s+/),
        ...(item.description || "").split(/\s+/),
        ...(item.tags || []),
      ];

      for (const word of words) {
        if (word.toLowerCase().includes(query.toLowerCase()) && word.length > query.length) {
          suggestions.add(word.toLowerCase());
        }
      }

      if (suggestions.size >= 5) break;
    }

    return Array.from(suggestions).slice(0, 5);
  }

  private createEmptyResponse(
    query: string,
    algorithm: SearchAlgorithm,
    executionTime: number
  ): SearchResponse {
    return {
      query,
      results: [],
      totalCount: 0,
      executionTime,
      algorithm,
      metadata: {
        searchType: algorithm,
        resultsFound: 0,
        maxScore: 0,
        minScore: 0,
      },
    };
  }

  private recordAnalytics(analytics: SearchAnalytics): void {
    // Implement circular buffer by removing oldest entry when at capacity
    if (this.analytics.length >= this.maxAnalyticsSize) {
      this.analytics.shift(); // Remove oldest entry (FIFO)
    }

    this.analytics.push(analytics);
    this.metrics.totalSearches++;
    this.metrics.algorithmUsage[analytics.algorithm] =
      (this.metrics.algorithmUsage[analytics.algorithm] || 0) + 1;

    // Update average execution time
    const totalTime = this.analytics.reduce((sum, a) => sum + a.executionTime, 0);
    this.metrics.averageExecutionTime = totalTime / this.analytics.length;

    // Update popular queries
    this.updatePopularQueries(analytics.query, analytics.executionTime);
  }

  private updatePopularQueries(query: string, executionTime: number): void {
    const normalized = query.toLowerCase();
    const existing = this.metrics.popularQueries.find((pq) => pq.query === normalized);

    if (existing) {
      existing.count++;
      existing.avgExecutionTime = (existing.avgExecutionTime + executionTime) / 2;
    } else {
      this.metrics.popularQueries.push({
        query: normalized,
        count: 1,
        avgExecutionTime: executionTime,
      });
    }

    // Keep only top 20 popular queries
    this.metrics.popularQueries.sort((a, b) => b.count - a.count);
    this.metrics.popularQueries = this.metrics.popularQueries.slice(
      0,
      SearchEngineLimit.POPULAR_QUERIES_TOP
    );
  }

  private updateMetrics(): void {
    this.metrics.indexSize = this.items.length;
  }

  /**
   * Get search metrics and analytics
   */
  getMetrics(): SearchMetrics {
    return { ...this.metrics };
  }

  /**
   * Get recent search analytics
   */
  getAnalytics(limit: number = SearchEngineLimit.DEFAULT_ANALYTICS_LIMIT): SearchAnalytics[] {
    return this.analytics.slice(-limit);
  }

  /**
   * Clear analytics data
   */
  clearAnalytics(): void {
    this.analytics = [];
    this.metrics.totalSearches = 0;
    this.metrics.averageExecutionTime = 0;
    this.metrics.algorithmUsage = {} as Record<SearchAlgorithm, number>;
    this.metrics.popularQueries = [];
  }
}
