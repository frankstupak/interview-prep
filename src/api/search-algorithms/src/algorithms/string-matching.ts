/**
 * String Matching Algorithms
 *
 * This module implements various string matching algorithms from scratch,
 * demonstrating different approaches to text search and pattern matching.
 *
 * Algorithms implemented:
 * - Exact matching
 * - Prefix/Suffix matching
 * - Contains matching
 * - Fuzzy matching (Levenshtein distance)
 * - Wildcard matching
 * - Regular expression utilities
 */

import { SearchMatch, FuzzyConfig } from "../types";

export class StringMatcher {
  /**
   * Exact String Matching
   *
   * Why: Perfect for when you need exact matches only
   * When: User IDs, codes, exact product names
   * Time Complexity: O(n) where n is text length
   */
  static exactMatch(text: string, query: string, caseSensitive: boolean = false): SearchMatch[] {
    const searchText = caseSensitive ? text : text.toLowerCase();
    const searchQuery = caseSensitive ? query : query.toLowerCase();

    const matches: SearchMatch[] = [];
    let startIndex = 0;
    let index: number;

    while ((index = searchText.indexOf(searchQuery, startIndex)) !== -1) {
      matches.push({
        field: "text",
        value: text.substring(index, index + query.length),
        startIndex: index,
        endIndex: index + query.length - 1,
        matchType: "exact",
      });
      startIndex = index + 1;
    }

    return matches;
  }

  /**
   * Prefix Matching
   *
   * Why: Great for autocomplete and "starts with" searches
   * When: Search suggestions, command completion, name lookups
   * Time Complexity: O(m) where m is query length
   */
  static prefixMatch(text: string, query: string, caseSensitive: boolean = false): SearchMatch[] {
    const searchText = caseSensitive ? text : text.toLowerCase();
    const searchQuery = caseSensitive ? query : query.toLowerCase();

    if (searchText.startsWith(searchQuery)) {
      return [
        {
          field: "text",
          value: text.substring(0, query.length),
          startIndex: 0,
          endIndex: query.length - 1,
          matchType: "exact",
        },
      ];
    }

    return [];
  }

  /**
   * Suffix Matching
   *
   * Why: Useful for file extensions, domain matching
   * When: File searches, email domain filtering
   * Time Complexity: O(m) where m is query length
   */
  static suffixMatch(text: string, query: string, caseSensitive: boolean = false): SearchMatch[] {
    const searchText = caseSensitive ? text : text.toLowerCase();
    const searchQuery = caseSensitive ? query : query.toLowerCase();

    if (searchText.endsWith(searchQuery)) {
      const startIndex = text.length - query.length;
      return [
        {
          field: "text",
          value: text.substring(startIndex),
          startIndex,
          endIndex: text.length - 1,
          matchType: "exact",
        },
      ];
    }

    return [];
  }

  /**
   * Contains Matching (Substring Search)
   *
   * Why: Most common search pattern for general text search
   * When: General search boxes, content search
   * Time Complexity: O(n*m) naive, O(n+m) with KMP
   */
  static containsMatch(text: string, query: string, caseSensitive: boolean = false): SearchMatch[] {
    return this.exactMatch(text, query, caseSensitive);
  }

  /**
   * Fuzzy Matching using Levenshtein Distance
   *
   * Why: Handles typos and approximate matches
   * When: User input with potential spelling errors
   * Time Complexity: O(n*m) where n,m are string lengths
   */
  static fuzzyMatch(
    text: string,
    query: string,
    config: FuzzyConfig = {
      maxDistance: 2,
      insertCost: 1,
      deleteCost: 1,
      substituteCost: 1,
      transpositionCost: 1,
    }
  ): { distance: number; matches: SearchMatch[] } {
    const distance = this.levenshteinDistance(text, query, config);

    if (distance <= config.maxDistance) {
      // For fuzzy matches, we'll highlight the entire text as a match
      // In a more sophisticated implementation, you'd trace back the optimal alignment
      return {
        distance,
        matches: [
          {
            field: "text",
            value: text,
            startIndex: 0,
            endIndex: text.length - 1,
            matchType: "fuzzy",
          },
        ],
      };
    }

    return { distance, matches: [] };
  }

  /**
   * Levenshtein Distance Calculation
   *
   * Why: Measures the minimum number of edits needed to transform one string into another
   * When: Fuzzy matching, spell checking, similarity scoring
   */
  static levenshteinDistance(str1: string, str2: string, config: FuzzyConfig): number {
    const m = str1.length;
    const n = str2.length;

    // Fast paths avoid allocation entirely for trivial inputs.
    if (m === 0) return n * config.insertCost;
    if (n === 0) return m * config.deleteCost;

    // Damerau transposition needs the row two above the current one, so we keep
    // a rolling THREE-row buffer instead of the full (m+1)x(n+1) matrix.
    // Space drops from O(m*n) to O(3n); results are identical.
    const { insertCost, deleteCost, substituteCost, transpositionCost } = config;

    let prevPrev = new Array<number>(n + 1); // row i-2
    let prev = new Array<number>(n + 1); // row i-1
    let curr = new Array<number>(n + 1); // row i

    for (let j = 0; j <= n; j++) prev[j] = j * insertCost;

    for (let i = 1; i <= m; i++) {
      curr[0] = i * deleteCost;
      const c1 = str1[i - 1];

      for (let j = 1; j <= n; j++) {
        if (c1 === str2[j - 1]) {
          curr[j] = prev[j - 1];
        } else {
          let best =
            prev[j] + deleteCost < prev[j - 1] + substituteCost
              ? prev[j] + deleteCost
              : prev[j - 1] + substituteCost;
          const ins = curr[j - 1] + insertCost;
          if (ins < best) best = ins;

          // Damerau-Levenshtein: adjacent transposition (row i-2 needed here).
          if (i > 1 && j > 1 && c1 === str2[j - 2] && str1[i - 2] === str2[j - 1]) {
            const trans = prevPrev[j - 2] + transpositionCost;
            if (trans < best) best = trans;
          }
          curr[j] = best;
        }
      }

      // Rotate the three rows, reusing the oldest buffer to avoid allocation.
      const recycled = prevPrev;
      prevPrev = prev;
      prev = curr;
      curr = recycled;
    }

    return prev[n];
  }

  /**
   * Wildcard Pattern Matching
   *
   * Why: Flexible pattern matching with * and ? wildcards
   * When: File path matching, flexible search patterns
   * Time Complexity: O(n*m) worst case, often much better
   */
  static wildcardMatch(text: string, pattern: string): boolean {
    const m = text.length;
    const n = pattern.length;

    // dp[i][j] represents if text[0...i-1] matches pattern[0...j-1]
    const dp: boolean[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(false));

    // Empty pattern matches empty text
    dp[0][0] = true;

    // Handle patterns starting with *
    for (let j = 1; j <= n; j++) {
      if (pattern[j - 1] === "*") {
        dp[0][j] = dp[0][j - 1];
      }
    }

    // Fill the DP table
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        const textChar = text[i - 1];
        const patternChar = pattern[j - 1];

        if (patternChar === "*") {
          // * can match empty string or any character
          dp[i][j] = dp[i][j - 1] || dp[i - 1][j];
        } else if (patternChar === "?" || patternChar === textChar) {
          // ? matches any single character, or exact match
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = false;
        }
      }
    }

    // Strict single-character match for '?': ensure the number of pattern chars equals text length when no '*'
    if (!pattern.includes("*") && pattern.length !== m) {
      return false;
    }

    return !!dp[m][n];
  }

  /**
   * Word Boundary Matching
   *
   * Why: Match whole words only, avoiding partial matches within words
   * When: Searching for complete terms, avoiding false positives
   */
  static wordBoundaryMatch(
    text: string,
    query: string,
    caseSensitive: boolean = false
  ): SearchMatch[] {
    const searchText = caseSensitive ? text : text.toLowerCase();
    const searchQuery = caseSensitive ? query : query.toLowerCase();

    // Create word boundary regex
    const regex = new RegExp(`\\b${this.escapeRegex(searchQuery)}\\b`, "g");
    const matches: SearchMatch[] = [];
    let match;

    while ((match = regex.exec(searchText)) !== null) {
      matches.push({
        field: "text",
        value: text.substring(match.index, match.index + query.length),
        startIndex: match.index,
        endIndex: match.index + query.length - 1,
        matchType: "exact",
      });
    }

    return matches;
  }

  /**
   * Multi-pattern Matching (Aho-Corasick inspired)
   *
   * Why: Efficiently search for multiple patterns simultaneously
   * When: Keyword filtering, content moderation, multiple term search
   */
  static multiPatternMatch(
    text: string,
    patterns: string[],
    caseSensitive: boolean = false
  ): Map<string, SearchMatch[]> {
    const results = new Map<string, SearchMatch[]>();
    const searchText = caseSensitive ? text : text.toLowerCase();

    for (const pattern of patterns) {
      const searchPattern = caseSensitive ? pattern : pattern.toLowerCase();
      const matches = this.exactMatch(searchText, searchPattern, true);

      // Restore original case for matches
      const originalMatches = matches.map((match) => ({
        ...match,
        value: text.substring(match.startIndex, match.endIndex + 1),
      }));

      if (originalMatches.length > 0) {
        results.set(pattern, originalMatches);
      }
    }

    return results;
  }

  /**
   * Longest Common Subsequence (LCS)
   *
   * Why: Find the longest sequence of characters that appear in both strings
   * When: Similarity measurement, diff algorithms
   */
  static longestCommonSubsequence(str1: string, str2: string): number {
    const m = str1.length;
    const n = str2.length;
    const dp: number[][] = Array(m + 1)
      .fill(null)
      .map(() => Array(n + 1).fill(0));

    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (str1[i - 1] === str2[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
        }
      }
    }

    return dp[m][n];
  }

  /**
   * Jaro-Winkler Distance
   *
   * Why: String similarity metric that gives more weight to common prefixes
   * When: Name matching, record linkage, fuzzy deduplication
   */
  static jaroWinklerDistance(str1: string, str2: string): number {
    if (str1 === str2) return 1.0;

    const len1 = str1.length;
    const len2 = str2.length;

    if (len1 === 0 || len2 === 0) return 0.0;

    const matchWindow = Math.floor(Math.max(len1, len2) / 2) - 1;
    if (matchWindow < 0) return 0.0;

    const str1Matches = new Array(len1).fill(false);
    const str2Matches = new Array(len2).fill(false);

    let matches = 0;
    let transpositions = 0;

    // Find matches
    for (let i = 0; i < len1; i++) {
      const start = Math.max(0, i - matchWindow);
      const end = Math.min(i + matchWindow + 1, len2);

      for (let j = start; j < end; j++) {
        if (str2Matches[j] || str1[i] !== str2[j]) continue;

        str1Matches[i] = true;
        str2Matches[j] = true;
        matches++;
        break;
      }
    }

    if (matches === 0) return 0.0;

    // Count transpositions
    let k = 0;
    for (let i = 0; i < len1; i++) {
      if (!str1Matches[i]) continue;

      while (!str2Matches[k]) k++;

      if (str1[i] !== str2[k]) transpositions++;
      k++;
    }

    const jaro = (matches / len1 + matches / len2 + (matches - transpositions / 2) / matches) / 3;

    // Jaro-Winkler modification
    let prefix = 0;
    for (let i = 0; i < Math.min(len1, len2, 4); i++) {
      if (str1[i] === str2[i]) prefix++;
      else break;
    }

    return jaro + 0.1 * prefix * (1 - jaro);
  }

  /**
   * Utility function to escape special regex characters
   */
  private static escapeRegex(str: string): string {
    return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  /**
   * Calculate similarity score between two strings
   *
   * Why: Provides a normalized score (0-1) for string similarity
   * When: Ranking search results, similarity thresholds
   */
  static calculateSimilarity(
    str1: string,
    str2: string,
    algorithm: "levenshtein" | "jaro-winkler" | "lcs" = "levenshtein"
  ): number {
    switch (algorithm) {
      case "levenshtein": {
        const maxLen = Math.max(str1.length, str2.length);
        if (maxLen === 0) return 1.0;
        const distance = this.levenshteinDistance(str1, str2, {
          maxDistance: maxLen,
          insertCost: 1,
          deleteCost: 1,
          substituteCost: 1,
          transpositionCost: 1,
        });
        const score = 1 - distance / maxLen;
        // Guard against tiny floating point errors
        if (score > 0.999999) return 1.0;
        return score;
      }
      case "jaro-winkler":
        return this.jaroWinklerDistance(str1, str2);

      case "lcs": {
        const lcs = this.longestCommonSubsequence(str1, str2);
        const maxLength = Math.max(str1.length, str2.length);
        return maxLength === 0 ? 1.0 : lcs / maxLength;
      }
      default:
        return 0;
    }
  }
}
