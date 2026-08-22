import { describe, it, expect } from "@jest/globals";
import { SortingAlgorithms } from "./sorting-algorithms";
import { RankingAlgorithms, BM25Index } from "./ranking-algorithms";
import type { SearchableItem } from "../api/search-algorithms/src/types";

/**
 * Uplift regression tests (Lumen Industries).
 *
 * Locks in fixes for:
 *  - quickSort stack overflow / O(n²) on sorted, reversed, all-equal input
 *  - mergeSort stability + buffered merge + ordered-halves fast path
 *  - customScore recency bias for documents without createdAt
 *  - ASCII-only tokenizer destroying non-English text
 *  - phraseScore punctuation misses + substring false positives
 *  - BM25 negative-IDF clamp (now Lucene-style non-negative IDF)
 *  - BM25Index parity with calculateBM25
 */

const numAsc = (a: number, b: number): number => a - b;

describe("SortingAlgorithms uplift", () => {
  const N = 100_000;
  const sorted = Array.from({ length: N }, (_, i) => i);
  const reversed = sorted.slice().reverse();
  const allEqual = new Array<number>(N).fill(7);

  it("quickSort survives sorted input at n=100k (was RangeError)", () => {
    const out = SortingAlgorithms.quickSort(sorted);
    expect(out.length).toBe(N);
    expect(SortingAlgorithms.isSorted(out)).toBe(true);
    expect(out[0]).toBe(0);
    expect(out[N - 1]).toBe(N - 1);
  });

  it("quickSort survives reverse-sorted input at n=100k (was RangeError)", () => {
    const out = SortingAlgorithms.quickSort(reversed);
    expect(SortingAlgorithms.isSorted(out)).toBe(true);
    expect(out[0]).toBe(0);
    expect(out[N - 1]).toBe(N - 1);
  });

  it("quickSort survives all-equal input at n=100k (was RangeError)", () => {
    const out = SortingAlgorithms.quickSort(allEqual);
    expect(out.length).toBe(N);
    expect(out.every((v) => v === 7)).toBe(true);
  });

  it("quickSort does not mutate its input on pathological shapes", () => {
    const input = reversed.slice();
    SortingAlgorithms.quickSort(input);
    expect(input).toEqual(reversed);
  });

  it("quickSort matches Array.prototype.sort across random fuzz cases", () => {
    for (let round = 0; round < 200; round++) {
      const len = Math.floor(Math.random() * 300);
      const arr = Array.from({ length: len }, () => Math.floor(Math.random() * 50) - 25);
      expect(SortingAlgorithms.quickSort(arr)).toEqual(arr.slice().sort(numAsc));
    }
  });

  it("quickSort matches Array.prototype.sort on duplicate-heavy fuzz cases", () => {
    for (let round = 0; round < 100; round++) {
      const len = 500;
      const arr = Array.from({ length: len }, () => Math.floor(Math.random() * 4));
      expect(SortingAlgorithms.quickSort(arr)).toEqual(arr.slice().sort(numAsc));
    }
  });

  it("quickSort still honors a custom comparator", () => {
    const out = SortingAlgorithms.quickSort([3, 1, 2], (a, b) => b - a);
    expect(out).toEqual([3, 2, 1]);
  });

  it("mergeSort is stable: equal keys keep their input order", () => {
    const items = Array.from({ length: 5_000 }, (_, i) => ({
      key: i % 10,
      seq: i,
    }));
    const out = SortingAlgorithms.mergeSort(items, (a, b) => a.key - b.key);
    for (let i = 1; i < out.length; i++) {
      if (out[i - 1].key === out[i].key) {
        expect(out[i - 1].seq).toBeLessThan(out[i].seq);
      } else {
        expect(out[i - 1].key).toBeLessThan(out[i].key);
      }
    }
  });

  it("mergeSort matches Array.prototype.sort across random fuzz cases", () => {
    for (let round = 0; round < 200; round++) {
      const len = Math.floor(Math.random() * 300);
      const arr = Array.from({ length: len }, () => Math.floor(Math.random() * 1000));
      expect(SortingAlgorithms.mergeSort(arr)).toEqual(arr.slice().sort(numAsc));
    }
  });

  it("mergeSort handles sorted and reversed input at n=100k", () => {
    expect(SortingAlgorithms.isSorted(SortingAlgorithms.mergeSort(sorted))).toBe(true);
    expect(SortingAlgorithms.isSorted(SortingAlgorithms.mergeSort(reversed))).toBe(true);
  });
});

const doc = (partial: Partial<SearchableItem> & { id: string; title: string }): SearchableItem =>
  ({ content: "", ...partial }) as SearchableItem;

describe("RankingAlgorithms uplift", () => {
  it("customScore gives ZERO recency boost to documents without createdAt (was max boost)", () => {
    const docs = [
      doc({ id: "undated", title: "search engine", content: "search engine ".repeat(10) }),
      doc({
        id: "dated-old",
        title: "search engine",
        content: "search engine ".repeat(10),
        createdAt: new Date("2019-01-01"),
      }),
    ];
    const results = RankingAlgorithms.customScore(docs, "search engine");
    const undated = results.find((r) => r.item.id === "undated")!;
    const datedOld = results.find((r) => r.item.id === "dated-old")!;
    expect(undated.components.recencyBoost).toBe(0);
    expect(datedOld.components.recencyBoost).toBeGreaterThan(0);
  });

  it("customScore recency still favors newer dated documents", () => {
    const docs = [
      doc({ id: "new", title: "cache", content: "cache", createdAt: new Date() }),
      doc({ id: "old", title: "cache", content: "cache", createdAt: new Date("2015-01-01") }),
    ];
    const results = RankingAlgorithms.customScore(docs, "cache");
    const fresh = results.find((r) => r.item.id === "new")!;
    const stale = results.find((r) => r.item.id === "old")!;
    expect(fresh.components.recencyBoost).toBeGreaterThan(stale.components.recencyBoost);
  });

  it("tokenizer preserves accented terms: 'café' is searchable and distinct from 'cafe'", () => {
    const docs = [
      doc({ id: "fr", title: "le café parisien", content: "café café café" }),
      doc({ id: "en", title: "the cafe downtown", content: "cafe cafe cafe" }),
    ];
    const cafeAccent = RankingAlgorithms.calculateBM25(docs, "café");
    expect(cafeAccent.length).toBe(1);
    expect(cafeAccent[0].item.id).toBe("fr");
    const cafePlain = RankingAlgorithms.calculateBM25(docs, "cafe");
    expect(cafePlain.length).toBe(1);
    expect(cafePlain[0].item.id).toBe("en");
  });

  it("tokenizer preserves CJK and Cyrillic text (was deleted entirely)", () => {
    const docs = [
      doc({ id: "jp", title: "東京 ガイド", content: "東京 の 観光" }),
      doc({ id: "ru", title: "москва", content: "москва путеводитель" }),
      doc({ id: "en", title: "london guide", content: "london travel" }),
    ];
    expect(RankingAlgorithms.calculateBM25(docs, "東京")[0]?.item.id).toBe("jp");
    expect(RankingAlgorithms.calculateBM25(docs, "москва")[0]?.item.id).toBe("ru");
  });

  it("phraseScore matches phrases across punctuation/whitespace differences", () => {
    const docs = [
      doc({ id: "punct", title: "greeting", content: "hello,   world! and more" }),
      doc({ id: "plain", title: "greeting", content: "world hello" }),
    ];
    const results = RankingAlgorithms.phraseScore(docs, "hello world");
    const punct = results.find((r) => r.item.id === "punct")!;
    const plain = results.find((r) => r.item.id === "plain")!;
    expect(punct.hasPhrase).toBe(true);
    expect(plain.hasPhrase).toBe(false);
    expect(punct.score).toBeGreaterThan(plain.score);
  });

  it("phraseScore does not substring-match inside larger tokens", () => {
    const docs = [doc({ id: "a", title: "terrain", content: "yellow lowland low tide" })];
    // "low" appears as its own token -> phrase hit is legitimate
    expect(RankingAlgorithms.phraseScore(docs, "low")[0].hasPhrase).toBe(true);
    // "ell" only appears inside "yellow" -> must NOT phrase-match
    const noHit = RankingAlgorithms.phraseScore(docs, "ellow lowl");
    expect(noHit.every((r) => !r.hasPhrase)).toBe(true);
  });

  it("BM25 IDF stays positive and rarer terms outscore ubiquitous ones", () => {
    const docs = [
      doc({ id: "1", title: "x", content: "common rare" }),
      doc({ id: "2", title: "x", content: "common" }),
      doc({ id: "3", title: "x", content: "common" }),
      doc({ id: "4", title: "x", content: "common" }),
    ];
    const results = RankingAlgorithms.calculateBM25(docs, "common rare");
    const withRare = results.find((r) => r.item.id === "1")!;
    // "common" is in every doc (df = N): old clamp flattened it to 0.001,
    // Lucene-style IDF keeps it small but meaningfully positive.
    expect(withRare.termScores.common).toBeGreaterThan(0);
    expect(withRare.termScores.rare).toBeGreaterThan(withRare.termScores.common);
    // Every doc containing only the ubiquitous term still gets a positive score.
    for (const r of results) expect(r.score).toBeGreaterThan(0);
  });
});

describe("BM25Index", () => {
  const corpus: SearchableItem[] = Array.from({ length: 50 }, (_, i) =>
    doc({
      id: String(i),
      title: `document ${i % 5 === 0 ? "engine" : "note"} ${i}`,
      description: i % 3 === 0 ? "fast search engine internals" : "general notes",
      content: `body text ${i % 2 === 0 ? "search ranking" : "storage layout"} item ${i}`,
      tags: i % 4 === 0 ? ["search"] : ["misc"],
    })
  );

  it("returns identical scores and order to calculateBM25", () => {
    const index = new BM25Index(corpus);
    const viaIndex = index.search("fast search engine");
    const viaStatic = RankingAlgorithms.calculateBM25(corpus, "fast search engine");
    expect(viaIndex.length).toBe(viaStatic.length);
    for (let i = 0; i < viaStatic.length; i++) {
      expect(viaIndex[i].item.id).toBe(viaStatic[i].item.id);
      expect(viaIndex[i].score).toBeCloseTo(viaStatic[i].score, 10);
      expect(Object.keys(viaIndex[i].termScores).sort()).toEqual(
        Object.keys(viaStatic[i].termScores).sort()
      );
    }
  });

  it("parity holds across many query shapes", () => {
    const index = new BM25Index(corpus);
    for (const q of ["engine", "search ranking", "storage", "note item", "engine engine"]) {
      const a = index.search(q);
      const b = RankingAlgorithms.calculateBM25(corpus, q);
      expect(a.map((r) => r.item.id)).toEqual(b.map((r) => r.item.id));
      a.forEach((r, i) => expect(r.score).toBeCloseTo(b[i].score, 10));
    }
  });

  it("respects custom k1/b config", () => {
    const cfg = { k1: 2.0, b: 0.25 };
    const a = new BM25Index(corpus, cfg).search("search engine");
    const b = RankingAlgorithms.calculateBM25(corpus, "search engine", cfg);
    a.forEach((r, i) => expect(r.score).toBeCloseTo(b[i].score, 10));
  });

  it("handles empty query, unknown terms, and empty corpus", () => {
    const index = new BM25Index(corpus);
    expect(index.search("")).toEqual([]);
    expect(index.search("zzzquux")).toEqual([]);
    expect(new BM25Index([]).search("anything")).toEqual([]);
    expect(index.size).toBe(50);
  });

  it("indexes unicode content", () => {
    const uni = new BM25Index([doc({ id: "jp", title: "東京", content: "東京 観光" })]);
    expect(uni.search("東京")[0]?.item.id).toBe("jp");
  });
});
