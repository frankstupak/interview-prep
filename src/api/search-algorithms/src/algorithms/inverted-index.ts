/**
 * Inverted Index for BM25 / TF-IDF Ranking
 *
 * The stateless helpers in `ranking-algorithms.ts` re-tokenize every document
 * and rebuild document-frequency tables on EVERY query. That is O(N * L) work
 * per query (N documents, L average length) regardless of how selective the
 * query is — fine for a one-shot demo, pathological for a search endpoint that
 * answers many queries against a stable corpus.
 *
 * `InvertedIndex` does the tokenizing and DF counting ONCE at build time, then
 * answers each query by walking only the postings lists of the query terms.
 * Query cost becomes O(sum of df(t) for t in query) — typically far smaller
 * than the corpus — which is exactly why real engines (Lucene/Elasticsearch)
 * are built on inverted indexes rather than per-query scans.
 *
 * Scores are numerically identical to `RankingAlgorithms.calculateBM25` /
 * `.calculateTFIDF` with the same config, so this is a drop-in acceleration.
 */

import { SearchableItem, BM25Config, TFIDFConfig } from "../types";

interface Posting {
  docIndex: number; // index into the internal documents array
  termFrequency: number;
}

interface RankedResult {
  item: SearchableItem;
  score: number;
  termScores: Record<string, number>;
}

const DEFAULT_BM25: Required<Omit<BM25Config, "avgDocLength">> = {
  k1: 1.2,
  b: 0.75,
};

const DEFAULT_TFIDF: TFIDFConfig = {
  useLogNormalization: true,
  useSublinearScaling: false,
  smoothIdf: true,
};

export class InvertedIndex {
  private documents: SearchableItem[] = [];
  private docLengths: number[] = [];
  private postings = new Map<string, Posting[]>();
  private avgDocLength = 0;

  constructor(documents: SearchableItem[] = []) {
    if (documents.length > 0) this.addDocuments(documents);
  }

  /** Number of documents currently indexed. */
  get size(): number {
    return this.documents.length;
  }

  /**
   * Index one or more documents. Postings and length statistics are updated
   * incrementally, so adding documents never requires a full rebuild.
   */
  addDocuments(docs: SearchableItem[]): void {
    for (const doc of docs) {
      const docIndex = this.documents.length;
      this.documents.push(doc);

      const terms = InvertedIndex.tokenize(InvertedIndex.extractText(doc));
      this.docLengths.push(terms.length);

      // Count term frequencies for this doc, then append to postings lists.
      const tf = new Map<string, number>();
      for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);

      for (const [term, freq] of tf) {
        let list = this.postings.get(term);
        if (!list) {
          list = [];
          this.postings.set(term, list);
        }
        list.push({ docIndex, termFrequency: freq });
      }
    }

    this.recomputeAverageLength();
  }

  /**
   * BM25 ranking over the indexed corpus.
   *
   * Formula: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * |d|/avgdl))
   * with IDF = log((N - df + 0.5) / (df + 0.5)), floored at 0.001 — matching
   * `RankingAlgorithms.calculateBM25` exactly.
   */
  bm25(query: string, config: BM25Config = DEFAULT_BM25): RankedResult[] {
    const queryTerms = InvertedIndex.tokenize(query);
    if (queryTerms.length === 0 || this.documents.length === 0) return [];

    const k1 = config.k1 ?? DEFAULT_BM25.k1;
    const b = config.b ?? DEFAULT_BM25.b;
    const avgdl = config.avgDocLength ?? this.avgDocLength;
    const totalDocuments = this.documents.length;

    // Accumulate per-document scores by walking only the query terms' postings.
    // A repeated query term contributes once per occurrence, matching
    // RankingAlgorithms.calculateBM25 exactly (which iterates query tokens).
    const scores = new Map<number, number>();
    const termScores = new Map<number, Record<string, number>>();

    for (const term of queryTerms) {
      const list = this.postings.get(term);
      if (!list || list.length === 0) continue;

      const df = list.length;
      const rawIdf = Math.log((totalDocuments - df + 0.5) / (df + 0.5));
      const idf = Math.max(0.001, rawIdf);

      for (const { docIndex, termFrequency: tf } of list) {
        const len = this.docLengths[docIndex];
        const denom = tf + k1 * (1 - b + b * (len / avgdl));
        const contribution = idf * ((tf * (k1 + 1)) / denom);

        scores.set(docIndex, (scores.get(docIndex) || 0) + contribution);

        let ts = termScores.get(docIndex);
        if (!ts) {
          ts = {};
          termScores.set(docIndex, ts);
        }
        ts[term] = contribution;
      }
    }

    return this.collect(scores, termScores);
  }

  /**
   * TF-IDF ranking over the indexed corpus. Matches
   * `RankingAlgorithms.calculateTFIDF` for the same config.
   */
  tfidf(query: string, config: TFIDFConfig = DEFAULT_TFIDF): RankedResult[] {
    const queryTerms = InvertedIndex.tokenize(query);
    if (queryTerms.length === 0 || this.documents.length === 0) return [];

    const totalDocuments = this.documents.length;
    const scores = new Map<number, number>();
    const termScores = new Map<number, Record<string, number>>();

    for (const term of queryTerms) {
      const list = this.postings.get(term);
      if (!list || list.length === 0) continue;

      const df = list.length;
      const idf = config.smoothIdf
        ? Math.log(totalDocuments / (1 + df)) + 1
        : Math.log(totalDocuments / Math.max(1, df));

      for (const { docIndex, termFrequency: tf } of list) {
        let tfComponent: number;
        if (config.useLogNormalization) {
          tfComponent = Math.log(1 + tf);
        } else if (config.useSublinearScaling) {
          tfComponent = 1 + Math.log(tf);
        } else {
          tfComponent = tf;
        }

        const contribution = tfComponent * idf;
        scores.set(docIndex, (scores.get(docIndex) || 0) + contribution);

        let ts = termScores.get(docIndex);
        if (!ts) {
          ts = {};
          termScores.set(docIndex, ts);
        }
        ts[term] = contribution;
      }
    }

    return this.collect(scores, termScores);
  }

  private collect(
    scores: Map<number, number>,
    termScores: Map<number, Record<string, number>>
  ): RankedResult[] {
    const results: RankedResult[] = [];
    for (const [docIndex, score] of scores) {
      if (score > 0) {
        results.push({
          item: this.documents[docIndex],
          score,
          termScores: termScores.get(docIndex) || {},
        });
      }
    }
    return results.sort((a, b) => b.score - a.score);
  }

  private recomputeAverageLength(): void {
    if (this.docLengths.length === 0) {
      this.avgDocLength = 0;
      return;
    }
    let total = 0;
    for (const len of this.docLengths) total += len;
    this.avgDocLength = total / this.docLengths.length;
  }

  private static tokenize(text: string): string[] {
    return text
      .toLowerCase()
      .replace(/[^\w\s]/g, " ")
      .split(/\s+/)
      .filter((token) => token.length > 0);
  }

  private static extractText(doc: SearchableItem): string {
    return [doc.title, doc.description || "", doc.content || "", (doc.tags || []).join(" ")].join(
      " "
    );
  }
}
