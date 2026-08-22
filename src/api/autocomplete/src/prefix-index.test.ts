/**
 * Unit tests for PrefixIndex (trie-backed prefix autocomplete).
 */

import { PrefixIndex } from "./prefix-index";
import { AutocompleteItem } from "./types.js";

function item(id: string, title: string, tags: string[] = [], category = "Test"): AutocompleteItem {
  return {
    id,
    title,
    category,
    tags,
    createdAt: new Date("2023-01-01"),
    updatedAt: new Date("2023-01-01"),
  };
}

describe("PrefixIndex", () => {
  let index: PrefixIndex;

  beforeEach(() => {
    index = new PrefixIndex();
  });

  it("matches items by title prefix", () => {
    index.build([item("1", "JavaScript"), item("2", "Java"), item("3", "Python")]);

    const results = index.search("jav", 10);
    const titles = results.map((r) => r.title).sort();

    expect(titles).toEqual(["Java", "JavaScript"]);
  });

  it("matches items by individual title-word prefix", () => {
    index.build([item("1", "Node.js Runtime"), item("2", "Deno Runtime"), item("3", "Python")]);

    const results = index.search("run", 10);
    const ids = results.map((r) => r.id).sort();

    expect(ids).toEqual(["1", "2"]);
  });

  it("matches items by tag prefix", () => {
    index.build([
      item("1", "React", ["frontend", "ui"]),
      item("2", "Express", ["backend"]),
    ]);

    const results = index.search("ui", 10);

    expect(results.map((r) => r.id)).toEqual(["1"]);
  });

  it("is case-insensitive on both sides", () => {
    index.build([item("1", "TypeScript")]);

    expect(index.search("TYPE", 10)).toHaveLength(1);
    expect(index.search("tYpEsC", 10)).toHaveLength(1);
  });

  it("returns distinct items even when multiple tokens match", () => {
    // "java" matches the full title AND the first word of "Java Virtual Machine"
    index.build([item("1", "Java Virtual Machine", ["java"])]);

    const results = index.search("java", 10);

    expect(results).toHaveLength(1);
    expect(results[0].id).toBe("1");
  });

  it("respects the limit", () => {
    const items = Array.from({ length: 50 }, (_, i) => item(`id-${i}`, `alpha${i}`));
    index.build(items);

    expect(index.search("alpha", 7)).toHaveLength(7);
    expect(index.search("alpha", 0)).toHaveLength(0);
  });

  it("ranks exact token matches before longer completions", () => {
    index.build([item("long", "golang"), item("exact", "go")]);

    const results = index.search("go", 10);

    expect(results[0].id).toBe("exact");
    expect(results[1].id).toBe("long");
  });

  it("handles unicode queries without splitting characters", () => {
    index.build([item("1", "Héllo Wörld"), item("2", "🚀 Rocket")]);

    expect(index.search("hé", 10).map((r) => r.id)).toEqual(["1"]);
    expect(index.search("wö", 10).map((r) => r.id)).toEqual(["1"]);
    expect(index.search("🚀", 10).map((r) => r.id)).toEqual(["2"]);
  });

  it("does NOT treat the query as a fuzzy pattern or regex", () => {
    index.build([item("1", "abc"), item("2", "^ab")]);

    // "^a" must only match the literal title "^ab", never "abc"
    expect(index.search("^a", 10).map((r) => r.id)).toEqual(["2"]);
    // "a." must not regex-match "ab"/"abc"
    expect(index.search("a.", 10)).toHaveLength(0);
  });

  it("returns empty results for empty or unmatched prefixes", () => {
    index.build([item("1", "JavaScript")]);

    expect(index.search("", 10)).toEqual([]);
    expect(index.search("   ", 10)).toEqual([]);
    expect(index.search("zzz", 10)).toEqual([]);
  });

  it("supports has() prefix membership checks", () => {
    index.build([item("1", "JavaScript", ["web"])]);

    expect(index.has("java")).toBe(true);
    expect(index.has("we")).toBe(true);
    expect(index.has("xyz")).toBe(false);
    expect(index.has("")).toBe(false);
  });

  it("rebuild replaces previous contents entirely", () => {
    index.build([item("1", "OldEntry")]);
    index.build([item("2", "NewEntry")]);

    expect(index.search("old", 10)).toHaveLength(0);
    expect(index.search("new", 10).map((r) => r.id)).toEqual(["2"]);
    expect(index.size).toBe(1);
  });

  it("reports token statistics", () => {
    index.build([item("1", "Node.js Runtime", ["backend"])]);

    // tokens: "node.js runtime", "node.js", "runtime", "backend"
    expect(index.tokens).toBe(4);
    expect(index.size).toBe(1);
  });

  it("stays correct on a 10k-item dataset", () => {
    const vocab = ["alpha", "beta", "gamma", "delta", "omega", "sigma"];
    const items = Array.from({ length: 10000 }, (_, i) =>
      item(`id-${i}`, `${vocab[i % vocab.length]} tool ${i}`)
    );
    index.build(items);

    const results = index.search("gam", 25);

    expect(results).toHaveLength(25);
    expect(results.every((r) => r.title.startsWith("gamma"))).toBe(true);
  });
});
