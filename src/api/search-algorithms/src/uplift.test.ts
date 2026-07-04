/**
 * Uplift test suite (Lumen Industries)
 *
 * Regression + correctness coverage for the search-algorithms uplift:
 *   - Soundex phonetic correctness against the canonical reference table
 *   - Levenshtein rolling-buffer parity (incl. Damerau transposition)
 *   - InvertedIndex BM25/TF-IDF equivalence with the stateless functions
 *   - SearchEngine tokenization + offset fixes and n-gram short-query matching
 */

import { PhoneticMatcher } from "./algorithms/phonetic-matching";
import { StringMatcher } from "./algorithms/string-matching";
import { RankingAlgorithms } from "./algorithms/ranking-algorithms";
import { InvertedIndex } from "./algorithms/inverted-index";
import { SearchEngine } from "./search-engine";
import { SearchableItem, FuzzyConfig } from "./types";

const unitCost: FuzzyConfig = {
  maxDistance: 9999,
  insertCost: 1,
  deleteCost: 1,
  substituteCost: 1,
  transpositionCost: 1,
};

describe("Soundex — canonical reference table", () => {
  // Reference values from the Soundex specification (Wikipedia / Rosetta Code).
  const cases: Array<[string, string]> = [
    ["Robert", "R163"],
    ["Rupert", "R163"],
    ["Rubin", "R150"],
    ["Ashcraft", "A261"], // H/W separator: S and C bridged by H code once
    ["Ashcroft", "A261"],
    ["Tymczak", "T522"], // vowel separator: Z and K both coded
    ["Pfister", "P236"], // first-letter dedup: P and F both -> collapse to P
    ["Honeyman", "H555"],
    ["Jackson", "J250"],
    ["Soundex", "S532"],
  ];

  it.each(cases)("soundex(%s) === %s", (name, expected) => {
    expect(PhoneticMatcher.soundex(name)).toBe(expected);
  });

  it("treats a vowel as a separator but H/W as transparent", () => {
    // Tymczak: T,5(M),2(C),Z skipped as dup, A resets, 2(K) => T522 (not T520)
    expect(PhoneticMatcher.soundex("Tymczak")).toBe("T522");
    // Ashcraft: A,2(S),H transparent so C dup-skipped,6(R),1(F) => A261 (not A226)
    expect(PhoneticMatcher.soundex("Ashcraft")).toBe("A261");
  });

  it("collapses same-coded first two letters (Pfister -> P236)", () => {
    expect(PhoneticMatcher.soundex("Pfister")).toBe("P236");
  });

  it("still encodes empty/non-alpha input safely", () => {
    expect(PhoneticMatcher.soundex("")).toBe("0000");
    expect(PhoneticMatcher.soundex("123!@#")).toBe("0000");
    expect(PhoneticMatcher.soundex("Lee")).toBe("L000");
  });

  it("keeps homophones equal (used by phonetic search)", () => {
    expect(PhoneticMatcher.soundex("Smith")).toBe(PhoneticMatcher.soundex("Smyth"));
    expect(PhoneticMatcher.soundex("Jackson")).toBe(PhoneticMatcher.soundex("Jakson"));
  });
});

describe("Levenshtein rolling-buffer parity", () => {
  // Independent full-matrix reference implementation to prove the optimized
  // rolling-buffer version returns identical distances (incl. transposition).
  function referenceDamerau(a: string, b: string, c: FuzzyConfig): number {
    const m = a.length;
    const n = b.length;
    const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
    for (let i = 0; i <= m; i++) dp[i][0] = i * c.deleteCost;
    for (let j = 0; j <= n; j++) dp[0][j] = j * c.insertCost;
    for (let i = 1; i <= m; i++) {
      for (let j = 1; j <= n; j++) {
        if (a[i - 1] === b[j - 1]) {
          dp[i][j] = dp[i - 1][j - 1];
        } else {
          dp[i][j] = Math.min(
            dp[i - 1][j] + c.deleteCost,
            dp[i][j - 1] + c.insertCost,
            dp[i - 1][j - 1] + c.substituteCost
          );
          if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
            dp[i][j] = Math.min(dp[i][j], dp[i - 2][j - 2] + c.transpositionCost);
          }
        }
      }
    }
    return dp[m][n];
  }

  const pairs: Array<[string, string]> = [
    ["", ""],
    ["a", ""],
    ["", "abc"],
    ["kitten", "sitting"],
    ["Saturday", "Sunday"],
    ["ca", "ac"], // transposition
    ["abcdef", "abcfed"],
    ["JavaScript", "Javscript"],
    ["flaw", "lawn"],
    ["aaaabbbb", "bbbbaaaa"],
  ];

  it.each(pairs)("matches full-matrix reference for (%s, %s)", (a, b) => {
    expect(StringMatcher.levenshteinDistance(a, b, unitCost)).toBe(
      referenceDamerau(a, b, unitCost)
    );
  });

  it("counts an adjacent transposition as a single edit", () => {
    expect(StringMatcher.levenshteinDistance("ab", "ba", unitCost)).toBe(1);
  });

  it("honors custom edit costs", () => {
    const cfg: FuzzyConfig = { ...unitCost, substituteCost: 5 };
    // 'a'->'b' via substitute(5) vs delete(1)+insert(1)=2, so min is 2
    expect(StringMatcher.levenshteinDistance("a", "b", cfg)).toBe(2);
  });

  it("handles long inputs and stays parity-correct with the reference", () => {
    const a = "x".repeat(1500) + "abc";
    const b = "x".repeat(1500) + "cba";
    // Shared 1500-char prefix costs nothing; distance is decided by the suffix.
    expect(StringMatcher.levenshteinDistance(a, b, unitCost)).toBe(
      referenceDamerau(a, b, unitCost)
    );
  });
});

describe("InvertedIndex — BM25 / TF-IDF equivalence and incremental updates", () => {
  function corpus(n: number): SearchableItem[] {
    const words = [
      "typescript",
      "javascript",
      "rust",
      "python",
      "fast",
      "safe",
      "concurrent",
      "memory",
      "search",
      "index",
      "query",
      "engine",
      "algorithm",
      "ranking",
      "fuzzy",
      "phonetic",
      "distance",
      "vector",
      "token",
      "document",
    ];
    const docs: SearchableItem[] = [];
    for (let i = 0; i < n; i++) {
      const len = 5 + (i % 20);
      const body: string[] = [];
      for (let j = 0; j < len; j++) body.push(words[(i * 7 + j * 3) % words.length]);
      docs.push({
        id: String(i),
        title: `${words[i % words.length]} ${words[(i * 3) % words.length]}`,
        description: body.join(" "),
        content: body.slice(0, 3).join(" "),
      });
    }
    return docs;
  }

  const docs = corpus(120);
  const queries = [
    "typescript",
    "fast safe",
    "search index query",
    "rust memory",
    "nonexistentterm",
  ];

  it("produces BM25 scores identical to the stateless implementation", () => {
    const idx = new InvertedIndex(docs);
    for (const q of queries) {
      const expected = RankingAlgorithms.calculateBM25(docs, q);
      const actual = idx.bm25(q);
      expect(actual.length).toBe(expected.length);
      const expMap = new Map(expected.map((r) => [r.item.id, r.score]));
      for (const r of actual) {
        expect(r.score).toBeCloseTo(expMap.get(r.item.id) ?? -1, 10);
      }
      // Same ranking order for the top results.
      expect(actual.slice(0, 5).map((r) => r.item.id)).toEqual(
        expected.slice(0, 5).map((r) => r.item.id)
      );
    }
  });

  it("produces TF-IDF scores identical to the stateless implementation", () => {
    const idx = new InvertedIndex(docs);
    for (const q of queries) {
      const expected = RankingAlgorithms.calculateTFIDF(docs, q);
      const actual = idx.tfidf(q);
      expect(actual.length).toBe(expected.length);
      const expMap = new Map(expected.map((r) => [r.item.id, r.score]));
      for (const r of actual) {
        expect(r.score).toBeCloseTo(expMap.get(r.item.id) ?? -1, 10);
      }
    }
  });

  it("reflects incrementally added documents", () => {
    const idx = new InvertedIndex(docs.slice(0, 100));
    expect(idx.size).toBe(100);
    idx.addDocuments(docs.slice(100));
    expect(idx.size).toBe(docs.length);
    // After the add, scores must match a fresh full-corpus stateless run.
    const expected = RankingAlgorithms.calculateBM25(docs, "search index");
    const actual = idx.bm25("search index");
    expect(actual.length).toBe(expected.length);
    const expMap = new Map(expected.map((r) => [r.item.id, r.score]));
    for (const r of actual) expect(r.score).toBeCloseTo(expMap.get(r.item.id) ?? -1, 10);
  });

  it("returns empty for empty query or empty corpus", () => {
    expect(new InvertedIndex(docs).bm25("")).toEqual([]);
    expect(new InvertedIndex([]).bm25("typescript")).toEqual([]);
    expect(new InvertedIndex(docs).tfidf("   ")).toEqual([]);
  });

  it("scores a repeated query term identically to the stateless function", () => {
    // The stateless calculateBM25 iterates query tokens, so a repeated term
    // contributes twice; the index reproduces that behavior exactly to remain
    // a true drop-in replacement.
    const idx = new InvertedIndex(docs);
    const expected = RankingAlgorithms.calculateBM25(docs, "typescript typescript");
    const actual = idx.bm25("typescript typescript");
    const expMap = new Map(expected.map((r) => [r.item.id, r.score]));
    for (const r of actual) expect(r.score).toBeCloseTo(expMap.get(r.item.id) ?? -1, 10);
  });
});

describe("SearchEngine — tokenization, offset, and n-gram fixes", () => {
  const items: SearchableItem[] = [
    {
      id: "1",
      title: "Node.js, TypeScript & Rust",
      description: "systems programming",
      content: "fast, safe, concurrent.",
    },
    {
      id: "2",
      title: "plain",
      description: "the word appears word twice and word thrice here",
      content: "",
    },
    {
      id: "3",
      title: "JavaScript Programming Language",
      description: "a long multi word field for ngram testing",
      content: "",
    },
  ];

  it("reports correct offsets for a repeated word (no first-occurrence bug)", async () => {
    const engine = new SearchEngine(items);
    const res = await engine.search({
      query: "word",
      options: { algorithm: "fuzzy", fuzzyThreshold: 0.99 },
    });
    const doc2 = res.results.find((r) => r.item.id === "2");
    expect(doc2).toBeDefined();
    const starts = (doc2!.matches || []).map((m) => m.startIndex).sort((a, b) => a - b);
    // Three distinct occurrences of "word" -> three distinct offsets.
    expect(new Set(starts).size).toBe(3);
    // Each reported offset must actually point at "word" in the field.
    const field = doc2!.item.description!;
    for (const s of starts) {
      expect(field.substring(s, s + 4)).toBe("word");
    }
  });

  it("strips punctuation so glued words still match (fuzzy)", async () => {
    const engine = new SearchEngine(items);
    // "TypeScript" is glued to "&" via spaces in the title, but "Rust" follows
    // punctuation directly. An exact-token match should be found cleanly.
    const res = await engine.search({
      query: "TypeScript",
      options: { algorithm: "fuzzy", fuzzyThreshold: 0.9, highlightMatches: true },
    });
    const doc1 = res.results.find((r) => r.item.id === "1");
    expect(doc1).toBeDefined();
    const m = (doc1!.matches || [])[0];
    expect(m.value).toBe("TypeScript");
    // Offset points at the real position of "TypeScript" in the title.
    expect(doc1!.item.title.substring(m.startIndex, m.endIndex + 1)).toBe("TypeScript");
  });

  it("finds a short query inside a long multi-word field (ngram)", async () => {
    const engine = new SearchEngine(items);
    // Whole-field Jaccard of "JavaScript" vs the 3-word title is low; the
    // per-word comparison recovers the match.
    const res = await engine.search({
      query: "JavaScript",
      options: { algorithm: "ngram", fuzzyThreshold: 0.5 },
    });
    const doc3 = res.results.find((r) => r.item.id === "3");
    expect(doc3).toBeDefined();
    expect(doc3!.score).toBeGreaterThanOrEqual(0.5);
    // The highlighted match should be the specific word, not the whole field.
    const m = (doc3!.matches || [])[0];
    expect(m.value.toLowerCase()).toBe("javascript");
  });

  it("keeps BM25 results correct after the corpus changes (index invalidation)", async () => {
    const engine = new SearchEngine(items.slice(0, 1));
    const before = await engine.search({ query: "systems", options: { algorithm: "bm25" } });
    expect(before.results.length).toBeGreaterThan(0);

    engine.addItems([
      { id: "99", title: "systems design", description: "systems systems systems", content: "" },
    ]);
    const after = await engine.search({ query: "systems", options: { algorithm: "bm25" } });
    // The freshly added, systems-dense doc should now rank first.
    expect(after.results[0].item.id).toBe("99");
  });
});
