/**
 * PrefixIndex - character trie for true prefix autocomplete.
 *
 * Why this exists: the previous "prefix" strategy passed `^query` to Fuse.js,
 * but the `^` prefix operator only works when `useExtendedSearch: true` is set
 * (https://www.fusejs.io/extended-search.html). It never was, so the caret was
 * fuzzy-matched as a literal character. Even with the operator enabled, Fuse
 * scans every indexed string per query (bitap), i.e. O(n * m). A trie answers
 * prefix queries in O(|prefix| + k) - independent of dataset size.
 *
 * Indexed tokens per item: full lowercase title, each whitespace-separated
 * title word, and each tag. Lookup returns distinct items, exact-token
 * matches first, then lexicographic DFS order (deterministic).
 *
 * Unicode: iteration uses for..of (code points), so surrogate pairs are not
 * split mid-character.
 */

import { AutocompleteItem } from "./types.js";

interface TrieNode {
  children: Map<string, TrieNode>;
  /** Indices into the items array for items with an indexed token ending here. */
  itemIndices: number[] | null;
}

function newNode(): TrieNode {
  return { children: new Map(), itemIndices: null };
}

export class PrefixIndex {
  private root: TrieNode = newNode();
  private items: AutocompleteItem[] = [];
  private tokenCount = 0;

  /** Build (or rebuild) the trie from a list of items. */
  build(items: AutocompleteItem[]): void {
    this.root = newNode();
    this.items = items;
    this.tokenCount = 0;

    for (let idx = 0; idx < items.length; idx++) {
      const item = items[idx];
      const tokens = new Set<string>();

      const title = (item.title || "").toLowerCase().trim();
      if (title) {
        tokens.add(title);
        for (const word of title.split(/\s+/)) {
          if (word) tokens.add(word);
        }
      }
      for (const tag of item.tags || []) {
        const t = (tag || "").toLowerCase().trim();
        if (t) tokens.add(t);
      }

      for (const token of tokens) {
        this.insert(token, idx);
      }
    }
  }

  private insert(token: string, itemIdx: number): void {
    let node = this.root;
    for (const ch of token) {
      let next = node.children.get(ch);
      if (!next) {
        next = newNode();
        node.children.set(ch, next);
      }
      node = next;
    }
    if (!node.itemIndices) {
      node.itemIndices = [];
      this.tokenCount++;
    }
    // Distinct tokens per item guarantee no duplicate push for the same token;
    // guard against repeated calls anyway.
    if (node.itemIndices[node.itemIndices.length - 1] !== itemIdx) {
      node.itemIndices.push(itemIdx);
    }
  }

  /**
   * Return up to `limit` distinct items having any indexed token that starts
   * with `prefix`. Case-insensitive. O(|prefix| + limit * branch) time.
   */
  search(prefix: string, limit: number = 10): AutocompleteItem[] {
    const p = prefix.toLowerCase().trim();
    if (!p || limit <= 0) return [];

    // Walk down to the node for the prefix.
    let node: TrieNode = this.root;
    for (const ch of p) {
      const next = node.children.get(ch);
      if (!next) return [];
      node = next;
    }

    const seen = new Set<number>();
    const out: AutocompleteItem[] = [];

    const collect = (indices: number[] | null): void => {
      if (!indices) return;
      for (const i of indices) {
        if (seen.has(i)) continue;
        seen.add(i);
        out.push(this.items[i]);
        if (out.length >= limit) return;
      }
    };

    // Exact token matches rank first.
    collect(node.itemIndices);
    if (out.length >= limit) return out;

    // Then lexicographic depth-first over the subtree.
    const stack: TrieNode[] = [];
    const pushChildren = (n: TrieNode): void => {
      const keys = [...n.children.keys()].sort().reverse(); // reverse so pop() yields ascending
      for (const k of keys) stack.push(n.children.get(k)!);
    };
    pushChildren(node);

    while (stack.length > 0 && out.length < limit) {
      const n = stack.pop()!;
      collect(n.itemIndices);
      if (out.length >= limit) break;
      pushChildren(n);
    }

    return out;
  }

  /** Whether any indexed token starts with the given prefix. */
  has(prefix: string): boolean {
    const p = prefix.toLowerCase().trim();
    if (!p) return false;
    let node: TrieNode = this.root;
    for (const ch of p) {
      const next = node.children.get(ch);
      if (!next) return false;
      node = next;
    }
    return true;
  }

  /** Number of indexed items. */
  get size(): number {
    return this.items.length;
  }

  /** Number of distinct indexed tokens. */
  get tokens(): number {
    return this.tokenCount;
  }
}
