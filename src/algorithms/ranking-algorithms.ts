/**
 * Text Ranking and Scoring Algorithms
 *
 * This module implements various algorithms for ranking and scoring text documents
 * based on relevance to search queries. These are fundamental to search engines
 * and information retrieval systems.
 *
 * Algorithms implemented:
 * - TF-IDF (Term Frequency-Inverse Document Frequency)
 * - BM25 (Best Matching 25)
 * - Cosine Similarity
 * - Custom scoring functions
 */

import { SearchableItem, BM25Config, TFIDFConfig } from "@/api/search-algorithms/src/types";

/** Base shape for any ranking result: item + score. */
export interface RankedItemBase<T = SearchableItem> {
  item: T;
  score: number;
}

/** TF-IDF / BM25 result with per-term scores. */
export type TFIDFOrBM25Result<T = SearchableItem> = RankedItemBase<T> & {
  termScores: Record<string, number>;
};

/** Cosine similarity result (score in [0, 1]). */
export type CosineSimilarityResult<T = SearchableItem> = RankedItemBase<T>;

/** Custom multi-signal score result with component breakdown. */
export type CustomScoreResult<T = SearchableItem> = RankedItemBase<T> & {
  components: Record<string, number>;
};

/** Phrase score result with exact-phrase flag. */
export type PhraseScoreResult<T = SearchableItem> = RankedItemBase<T> & {
  hasPhrase: boolean;
};

/** Field-weighted score result with per-field scores. */
export type FieldWeightedResult<T = SearchableItem> = RankedItemBase<T> & {
  fieldScores: Record<string, number>;
};

/** Weights for custom scoring (must sum to 1 for normalized behavior). */
export interface CustomScoreWeights {
  textRelevance: number;
  titleBoost: number;
  recencyBoost: number;
  popularityBoost: number;
}

/**
 * Unicode-aware tokenizer shared by every scorer in this module.
 * \p{L}/\p{N} keep letters and digits in ANY script. The old [^\w\s] class
 * was ASCII-only — it silently destroyed accented terms ("café" -> "caf")
 * and deleted CJK/Cyrillic/Arabic text entirely, so non-English documents
 * could never match their own words.
 */
function tokenizeText(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((token) => token.length > 0);
}

/** Flatten a document's searchable fields into one text blob. */
function extractDocText(doc: SearchableItem): string {
  return [doc.title, doc.description || "", doc.content || "", (doc.tags || []).join(" ")].join(
    " "
  );
}

export class RankingAlgorithms {
  /**
   * TF-IDF (Term Frequency-Inverse Document Frequency)
   *
   * Why: Classic information retrieval algorithm that balances term frequency with rarity
   * When: Document ranking, keyword extraction, content similarity
   * Formula: TF(t,d) * IDF(t) where IDF(t) = log(N / df(t))
   */
  static calculateTFIDF(
    documents: SearchableItem[],
    query: string,
    config: TFIDFConfig = {
      useLogNormalization: true,
      useSublinearScaling: false,
      smoothIdf: true,
    }
  ): TFIDFOrBM25Result[] {
    // Tokenize query
    const queryTerms = this.tokenize(query.toLowerCase());
    if (queryTerms.length === 0) return [];

    // Build document term frequencies
    const documentTerms = documents.map((doc) => {
      const text = this.extractText(doc).toLowerCase();
      const terms = this.tokenize(text);
      return { doc, terms, termFreq: this.calculateTermFrequency(terms) };
    });

    // Calculate document frequencies for each term
    const documentFrequencies = this.calculateDocumentFrequencies(
      documentTerms.map((d) => d.terms)
    );
    const totalDocuments = documents.length;

    const results: TFIDFOrBM25Result[] = [];

    for (const { doc, termFreq } of documentTerms) {
      let totalScore = 0;
      const termScores: Record<string, number> = {};

      for (const queryTerm of queryTerms) {
        const tf = termFreq[queryTerm] || 0;
        if (tf === 0) continue;

        // Calculate TF component
        let tfComponent: number;
        if (config.useLogNormalization) {
          tfComponent = Math.log(1 + tf);
        } else if (config.useSublinearScaling) {
          tfComponent = 1 + Math.log(tf);
        } else {
          tfComponent = tf;
        }

        // Calculate IDF component
        const df = documentFrequencies[queryTerm] || 0;
        let idfComponent: number;

        if (config.smoothIdf) {
          idfComponent = Math.log(totalDocuments / (1 + df)) + 1;
        } else {
          idfComponent = Math.log(totalDocuments / Math.max(1, df));
        }

        const tfidfScore = tfComponent * idfComponent;
        termScores[queryTerm] = tfidfScore;
        totalScore += tfidfScore;
      }

      if (totalScore > 0) {
        results.push({ item: doc, score: totalScore, termScores });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * BM25 (Best Matching 25)
   *
   * Why: Improved version of TF-IDF that handles term frequency saturation better
   * When: Modern search engines, better ranking than TF-IDF for most cases
   * Formula: IDF * (tf * (k1 + 1)) / (tf + k1 * (1 - b + b * |d|/avgdl))
   */
  static calculateBM25(
    documents: SearchableItem[],
    query: string,
    config: BM25Config = {
      k1: 1.2, // Controls term frequency saturation
      b: 0.75, // Controls length normalization
    }
  ): TFIDFOrBM25Result[] {
    const queryTerms = this.tokenize(query.toLowerCase());
    if (queryTerms.length === 0) return [];

    // Prepare document data
    const documentData = documents.map((doc) => {
      const text = this.extractText(doc).toLowerCase();
      const terms = this.tokenize(text);
      return {
        doc,
        terms,
        length: terms.length,
        termFreq: this.calculateTermFrequency(terms),
      };
    });

    // Calculate average document length
    const avgDocLength =
      config.avgDocLength ||
      documentData.reduce((sum, d) => sum + d.length, 0) / documentData.length;

    // Calculate document frequencies
    const documentFrequencies = this.calculateDocumentFrequencies(documentData.map((d) => d.terms));
    const totalDocuments = documents.length;

    const results: TFIDFOrBM25Result[] = [];

    for (const { doc, length, termFreq } of documentData) {
      let totalScore = 0;
      const termScores: Record<string, number> = {};

      for (const queryTerm of queryTerms) {
        const tf = termFreq[queryTerm] || 0;
        if (tf === 0) continue;

        // Lucene-style non-negative IDF: log(1 + (N - df + 0.5) / (df + 0.5)).
        // The raw Robertson IDF goes NEGATIVE when a term appears in more than
        // half the corpus; the old Math.max(0.001, ...) clamp flattened all
        // common terms to one arbitrary constant. Adding 1 inside the log
        // (Lucene's fix) keeps the score positive while preserving order.
        const df = documentFrequencies[queryTerm] || 0;
        const idf = Math.log(1 + (totalDocuments - df + 0.5) / (df + 0.5));

        // Calculate BM25 score for this term
        const numerator = tf * (config.k1 + 1);
        const denominator = tf + config.k1 * (1 - config.b + config.b * (length / avgDocLength));
        const bm25Score = idf * (numerator / denominator);

        termScores[queryTerm] = bm25Score;
        totalScore += bm25Score;
      }

      if (totalScore > 0) {
        results.push({ item: doc, score: totalScore, termScores });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Cosine Similarity with TF-IDF Vectors
   *
   * Why: Measures angle between query and document vectors, good for similarity
   * When: Document similarity, clustering, recommendation systems
   */
  static calculateCosineSimilarity(
    documents: SearchableItem[],
    query: string
  ): CosineSimilarityResult[] {
    const queryTerms = this.tokenize(query.toLowerCase());
    if (queryTerms.length === 0) return [];

    // Tokenize documents once.
    const documentTerms = documents.map((doc) => {
      const text = this.extractText(doc).toLowerCase();
      return { doc, terms: this.tokenize(text) };
    });

    // Calculate document frequencies for IDF
    const allTerms = documentTerms.map((d) => d.terms);
    const documentFrequencies = this.calculateDocumentFrequencies(allTerms);
    const totalDocuments = documents.length;

    // Smoothed IDF avoids log(0) and provides non-zero scores.
    const idfOf = (term: string): number => {
      const df = documentFrequencies[term] || 0;
      return Math.log((totalDocuments + 1) / (df + 1)) + 1;
    };

    // SPARSE query vector: only the query's own terms carry weight, so
    // there is no need to materialize a dense vector over the whole corpus
    // vocabulary. The old implementation built a |vocab|-length array for
    // the query AND for every document — O(docs × vocab) work and memory
    // where the dot product only ever has non-zeros on shared terms.
    const queryTermFreq = this.calculateTermFrequency(queryTerms);
    const queryVec = new Map<string, number>();
    let queryMagSq = 0;
    for (const [term, tf] of Object.entries(queryTermFreq)) {
      const w = tf * idfOf(term);
      queryVec.set(term, w);
      queryMagSq += w * w;
    }
    const queryMag = Math.sqrt(queryMagSq);
    if (queryMag === 0) return [];

    const results: CosineSimilarityResult[] = [];

    for (const { doc, terms } of documentTerms) {
      const termFreq = this.calculateTermFrequency(terms);

      // Document magnitude over its OWN terms; dot product over the (tiny)
      // query vector only. Same mathematical result as the dense version.
      let docMagSq = 0;
      for (const [term, tf] of Object.entries(termFreq)) {
        const w = tf * idfOf(term);
        docMagSq += w * w;
      }
      if (docMagSq === 0) continue;

      let dot = 0;
      for (const [term, qw] of queryVec) {
        const tf = termFreq[term] || 0;
        if (tf > 0) dot += qw * tf * idfOf(term);
      }

      const similarity = dot / (queryMag * Math.sqrt(docMagSq));

      if (similarity > 0) {
        results.push({ item: doc, score: similarity });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Custom Scoring Function
   *
   * Why: Combine multiple signals for more sophisticated ranking
   * When: You need domain-specific ranking that considers multiple factors
   */
  static customScore(
    documents: SearchableItem[],
    query: string,
    weights: CustomScoreWeights = {
      textRelevance: 0.7,
      titleBoost: 0.2,
      recencyBoost: 0.05,
      popularityBoost: 0.05,
    }
  ): CustomScoreResult[] {
    const queryTerms = this.tokenize(query.toLowerCase());
    if (queryTerms.length === 0) return [];

    // Get BM25 scores for text relevance
    const bm25Results = this.calculateBM25(documents, query);
    const bm25Map = new Map(bm25Results.map((r) => [r.item.id, r.score]));

    // Normalize BM25 scores. Loop instead of Math.max(...spread): spreading a
    // large result set onto the call stack throws RangeError past ~100k args.
    let maxBM25 = 0;
    for (const r of bm25Results) if (r.score > maxBM25) maxBM25 = r.score;

    const results: CustomScoreResult[] = [];

    for (const doc of documents) {
      const components: Record<string, number> = {};

      // Text relevance (normalized BM25)
      const bm25Score = bm25Map.get(doc.id) || 0;
      components.textRelevance = maxBM25 > 0 ? bm25Score / maxBM25 : 0;

      // Title boost (if query terms appear in title)
      components.titleBoost = this.calculateTitleBoost(doc.title, queryTerms);

      // Recency boost (newer documents get higher scores). Documents WITHOUT
      // a createdAt get 0 — the old `|| new Date()` fallback treated every
      // undated document as created *right now*, silently handing missing
      // data the maximum possible recency score and ranking it above every
      // genuinely dated document.
      components.recencyBoost = doc.createdAt ? this.calculateRecencyBoost(doc.createdAt) : 0;

      // Popularity boost (based on metadata if available)
      components.popularityBoost = this.calculatePopularityBoost(doc.metadata);

      // Calculate weighted final score
      const finalScore =
        components.textRelevance * weights.textRelevance +
        components.titleBoost * weights.titleBoost +
        components.recencyBoost * weights.recencyBoost +
        components.popularityBoost * weights.popularityBoost;

      if (finalScore > 0) {
        results.push({ item: doc, score: finalScore, components });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Phrase Scoring
   *
   * Why: Give higher scores to documents containing exact phrases
   * When: Query contains phrases that should be matched exactly
   */
  static phraseScore(
    documents: SearchableItem[],
    query: string,
    phraseBoost: number = 2.0
  ): PhraseScoreResult[] {
    const results: PhraseScoreResult[] = [];

    // Get base BM25 scores
    const bm25Results = this.calculateBM25(documents, query);
    const bm25Map = new Map(bm25Results.map((r) => [r.item.id, r.score]));

    // Normalize BOTH sides through the same tokenizer before matching.
    // Raw `text.includes(query)` missed phrases across punctuation and
    // whitespace differences: query "hello world" failed against
    // "hello,  world" even though every scorer in this class treats those
    // as identical token streams.
    const phrase = this.tokenize(query).join(" ");

    for (const doc of documents) {
      const text = this.tokenize(this.extractText(doc)).join(" ");
      const baseScore = bm25Map.get(doc.id) || 0;

      // Check if document contains the exact query phrase (token-normalized).
      // Space-padding both sides keeps the match on whole-token boundaries:
      // phrase "low" must not match inside "yellow lowland".
      const hasPhrase = phrase.length > 0 && ` ${text} `.includes(` ${phrase} `);
      const finalScore = hasPhrase ? baseScore * phraseBoost : baseScore;

      if (finalScore > 0) {
        results.push({ item: doc, score: finalScore, hasPhrase });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Field-weighted Scoring
   *
   * Why: Different fields have different importance (title > content > tags)
   * When: You want to boost matches in certain fields
   */
  static fieldWeightedScore(
    documents: SearchableItem[],
    query: string,
    fieldWeights: Record<string, number> = {
      title: 3.0,
      description: 2.0,
      content: 1.0,
      tags: 1.5,
    }
  ): FieldWeightedResult[] {
    const queryTerms = this.tokenize(query.toLowerCase());
    if (queryTerms.length === 0) return [];

    const results: FieldWeightedResult[] = [];

    for (const doc of documents) {
      const fieldScores: Record<string, number> = {};
      let totalScore = 0;

      // Score each field separately
      for (const [fieldName, weight] of Object.entries(fieldWeights)) {
        let fieldText = "";

        switch (fieldName) {
          case "title":
            fieldText = doc.title || "";
            break;
          case "description":
            fieldText = doc.description || "";
            break;
          case "content":
            fieldText = doc.content || "";
            break;
          case "tags":
            fieldText = (doc.tags || []).join(" ");
            break;
        }

        if (fieldText) {
          const fieldScore = this.calculateFieldScore(fieldText.toLowerCase(), queryTerms);
          fieldScores[fieldName] = fieldScore * weight;
          totalScore += fieldScores[fieldName];
        }
      }

      if (totalScore > 0) {
        results.push({ item: doc, score: totalScore, fieldScores });
      }
    }

    return results.sort((a, b) => b.score - a.score);
  }

  /**
   * Helper Methods
   */

  private static tokenize(text: string): string[] {
    return tokenizeText(text);
  }

  private static extractText(doc: SearchableItem): string {
    return extractDocText(doc);
  }

  private static calculateTermFrequency(terms: string[]): Record<string, number> {
    const freq: Record<string, number> = {};
    for (const term of terms) {
      freq[term] = (freq[term] || 0) + 1;
    }
    return freq;
  }

  private static calculateDocumentFrequencies(documentTerms: string[][]): Record<string, number> {
    const df: Record<string, number> = {};

    for (const terms of documentTerms) {
      const uniqueTerms = new Set(terms);
      for (const term of uniqueTerms) {
        df[term] = (df[term] || 0) + 1;
      }
    }

    return df;
  }

  private static cosineSimilarityVectors(vec1: number[], vec2: number[]): number {
    if (vec1.length !== vec2.length) return 0;

    let dotProduct = 0;
    let magnitude1 = 0;
    let magnitude2 = 0;

    for (let i = 0; i < vec1.length; i++) {
      dotProduct += vec1[i] * vec2[i];
      magnitude1 += vec1[i] * vec1[i];
      magnitude2 += vec2[i] * vec2[i];
    }

    if (magnitude1 === 0 || magnitude2 === 0) return 0;
    return dotProduct / (Math.sqrt(magnitude1) * Math.sqrt(magnitude2));
  }

  private static calculateTitleBoost(title: string, queryTerms: string[]): number {
    const titleTerms = this.tokenize(title.toLowerCase());
    const titleTermSet = new Set(titleTerms);

    let matches = 0;
    for (const queryTerm of queryTerms) {
      if (titleTermSet.has(queryTerm)) {
        matches++;
      }
    }

    return queryTerms.length > 0 ? matches / queryTerms.length : 0;
  }

  private static calculateRecencyBoost(createdAt: Date): number {
    const now = new Date();
    const ageInDays = (now.getTime() - createdAt.getTime()) / (1000 * 60 * 60 * 24);

    // Exponential decay: newer documents get higher scores
    return Math.exp(-ageInDays / 365); // Half-life of 1 year
  }

  private static calculatePopularityBoost(
    metadata?: Record<string, string | number | boolean>
  ): number {
    if (!metadata) return 0;

    // Example: use view count, likes, or other popularity signals
    const views = (metadata.views as number) || 0;
    const likes = (metadata.likes as number) || 0;
    const shares = (metadata.shares as number) || 0;

    // Simple popularity score (could be more sophisticated)
    const popularityScore = Math.log(1 + views + likes * 2 + shares * 3);

    // Normalize to 0-1 range (assuming max popularity score of ~10)
    return Math.min(1, popularityScore / 10);
  }

  private static calculateFieldScore(fieldText: string, queryTerms: string[]): number {
    const fieldTerms = this.tokenize(fieldText);
    const termFreq = this.calculateTermFrequency(fieldTerms);

    let score = 0;
    for (const queryTerm of queryTerms) {
      const tf = termFreq[queryTerm] || 0;
      if (tf > 0) {
        // Simple TF scoring for individual field
        score += Math.log(1 + tf);
      }
    }

    return score;
  }
}

/**
 * BM25Index — build the corpus statistics ONCE, score queries in O(matching docs).
 *
 * Every static scorer above re-tokenizes the entire corpus on every call,
 * which is O(total corpus text) per query. Real search engines (Lucene,
 * Elasticsearch) tokenize at index time and keep an inverted index of
 * term -> (doc, tf) postings so query time only touches documents that
 * actually contain a query term. This class brings that shape here.
 *
 * Scores are identical to RankingAlgorithms.calculateBM25 (same tokenizer,
 * same Lucene-style non-negative IDF); only the work moves from query time
 * to construction time.
 *
 * Usage:
 *   const index = new BM25Index(documents);        // once
 *   const hits = index.search("query terms");      // many times, fast
 */
export class BM25Index<T extends SearchableItem = SearchableItem> {
  private readonly docs: T[];
  private readonly docLengths: number[];
  private readonly avgDocLength: number;
  /** term -> array of [docIndex, termFrequency] postings */
  private readonly postings = new Map<string, Array<[number, number]>>();
  private readonly k1: number;
  private readonly b: number;

  constructor(documents: T[], config: BM25Config = { k1: 1.2, b: 0.75 }) {
    this.docs = documents;
    this.k1 = config.k1;
    this.b = config.b;
    this.docLengths = new Array<number>(documents.length);

    let totalLength = 0;
    for (let d = 0; d < documents.length; d++) {
      const terms = tokenizeText(extractDocText(documents[d]));
      this.docLengths[d] = terms.length;
      totalLength += terms.length;

      const tf = new Map<string, number>();
      for (const term of terms) tf.set(term, (tf.get(term) || 0) + 1);
      for (const [term, count] of tf) {
        let list = this.postings.get(term);
        if (!list) {
          list = [];
          this.postings.set(term, list);
        }
        list.push([d, count]);
      }
    }
    this.avgDocLength =
      config.avgDocLength || (documents.length > 0 ? totalLength / documents.length : 0);
  }

  /** Number of indexed documents. */
  get size(): number {
    return this.docs.length;
  }

  /**
   * BM25-score the query against the index. Only documents containing at
   * least one query term are visited; documents with score 0 are omitted,
   * matching RankingAlgorithms.calculateBM25 output shape.
   */
  search(query: string): TFIDFOrBM25Result<T>[] {
    const queryTerms = tokenizeText(query);
    if (queryTerms.length === 0 || this.docs.length === 0) return [];

    const totalDocuments = this.docs.length;
    const scores = new Map<number, { score: number; termScores: Record<string, number> }>();

    // Deduplicate query terms but preserve per-term contribution semantics
    // of the static scorer: repeated query terms add their score again.
    for (const term of queryTerms) {
      const list = this.postings.get(term);
      if (!list) continue;

      const df = list.length;
      // Lucene-style non-negative IDF (see calculateBM25).
      const idf = Math.log(1 + (totalDocuments - df + 0.5) / (df + 0.5));

      for (const [d, tf] of list) {
        const numerator = tf * (this.k1 + 1);
        const denominator =
          tf + this.k1 * (1 - this.b + this.b * (this.docLengths[d] / this.avgDocLength));
        const termScore = idf * (numerator / denominator);

        let entry = scores.get(d);
        if (!entry) {
          entry = { score: 0, termScores: {} };
          scores.set(d, entry);
        }
        // Assign (not accumulate) so a repeated query term reports its
        // single-occurrence score while still adding to the total — same
        // semantics as RankingAlgorithms.calculateBM25.
        entry.termScores[term] = termScore;
        entry.score += termScore;
      }
    }

    const results: TFIDFOrBM25Result<T>[] = [];
    for (const [d, { score, termScores }] of scores) {
      if (score > 0) results.push({ item: this.docs[d], score, termScores });
    }
    return results.sort((a, b) => b.score - a.score);
  }
}
