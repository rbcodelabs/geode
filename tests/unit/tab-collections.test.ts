import { describe, expect, it } from "vitest";
import {
  COLLECTION_COLORS,
  collectionBlocks,
  classifyMemberDrop,
  moveLeafToCollection,
  moveCollectionBlock,
  nextCollectionColor,
  normalizeCollectionName,
  normalizeTabCollections,
  normalizeSerializedCollectionSubset,
  runAllSettled,
  selectNearestSurvivor,
  tabStripNavigationIndex,
  uniqueCollectionId,
  type CollectionLeaf,
  type TabCollection,
} from "../../src/renderer/tab-collections";

const leaves = (...values: Array<[string, string?]>): CollectionLeaf[] =>
  values.map(([id, collectionId]) => ({ id, collectionId }));

describe("tab collections", () => {
  it("normalizes names by trimming, defaulting, and limiting Unicode code points", () => {
    expect(normalizeCollectionName("  Research  ")).toBe("Research");
    expect(normalizeCollectionName("   ")).toBe("New collection");
    expect([...normalizeCollectionName("😀".repeat(81))]).toHaveLength(80);
  });

  it("selects the first unused palette color, then deterministically cycles", () => {
    expect(nextCollectionColor([{ id: "a", name: "A", color: "gray", collapsed: false }])).toBe("blue");
    const all = COLLECTION_COLORS.map((color, index) => ({ id: `${index}`, name: `${index}`, color, collapsed: false }));
    expect(nextCollectionColor(all)).toBe("gray");
    expect(nextCollectionColor([...all, { ...all[0], id: "again" }])).toBe("blue");
  });

  it("repairs registries, orphans, and non-contiguous members idempotently", () => {
    const collections = [
      { id: "x", name: " ", color: "bad", collapsed: true },
      { id: "x", name: "dupe", color: "blue", collapsed: false },
      { id: "empty", name: "empty", color: "red", collapsed: false },
    ] as unknown as TabCollection[];
    const result = normalizeTabCollections(leaves(["a", "x"], ["b"], ["c", "x"], ["d", "ghost"]), collections);
    expect(result.collections).toEqual([{ id: "x", name: "New collection", color: "gray", collapsed: true }]);
    expect(result.leaves).toEqual(leaves(["a", "x"], ["c", "x"], ["b"], ["d"]));
    expect(normalizeTabCollections(result.leaves, result.collections)).toEqual(result);
  });

  it("moves members without nesting and removes empty collections", () => {
    const collections: TabCollection[] = [
      { id: "a", name: "A", color: "gray", collapsed: false },
      { id: "b", name: "B", color: "blue", collapsed: false },
    ];
    const result = moveLeafToCollection(leaves(["1", "a"], ["2", "b"], ["3", "b"]), collections, "1", "b", 1);
    expect(result.leaves).toEqual(leaves(["2", "b"], ["1", "b"], ["3", "b"]));
    expect(result.collections.map((collection) => collection.id)).toEqual(["b"]);
  });

  it("keeps one-member collections and removes them only after the last member leaves", () => {
    const collections: TabCollection[] = [{ id: "a", name: "A", color: "green", collapsed: true }];
    expect(normalizeTabCollections(leaves(["1", "a"]), collections).collections).toEqual(collections);
    expect(moveLeafToCollection(leaves(["1", "a"]), collections, "1", undefined).collections).toEqual([]);
  });

  it("projects a flat order into collection blocks without duplicating order state", () => {
    expect(collectionBlocks(leaves(["a"], ["b", "x"], ["c", "x"], ["d"]))).toEqual([
      { kind: "leaf", leafIds: ["a"] },
      { kind: "collection", collectionId: "x", leafIds: ["b", "c"] },
      { kind: "leaf", leafIds: ["d"] },
    ]);
  });

  it("moves an entire collection block without splitting members", () => {
    expect(moveCollectionBlock(leaves(["a"], ["b", "x"], ["c", "x"], ["d"]), "x", 0)).toEqual(
      leaves(["b", "x"], ["c", "x"], ["a"], ["d"])
    );
    expect(moveCollectionBlock(leaves(["a"], ["b", "x"], ["c", "x"], ["d"]), "x", 4)).toEqual(
      leaves(["a"], ["d"], ["b", "x"], ["c", "x"])
    );
  });

  it("navigates visible strip items with arrows and Home/End", () => {
    expect(tabStripNavigationIndex("ArrowLeft", 2, 5)).toBe(1);
    expect(tabStripNavigationIndex("ArrowRight", 2, 5)).toBe(3);
    expect(tabStripNavigationIndex("Home", 2, 5)).toBe(0);
    expect(tabStripNavigationIndex("End", 2, 5)).toBe(4);
    expect(tabStripNavigationIndex("ArrowLeft", 0, 5)).toBe(0);
  });

  it("classifies member drops without making collection-edge membership ambiguous", () => {
    expect(classifyMemberDrop(0, 3, 0.1)).toEqual({ kind: "ungrouped-before" });
    expect(classifyMemberDrop(0, 3, 0.4)).toEqual({ kind: "join", memberIndex: 0 });
    expect(classifyMemberDrop(1, 3, 0.75)).toEqual({ kind: "join", memberIndex: 2 });
    expect(classifyMemberDrop(2, 3, 0.9)).toEqual({ kind: "ungrouped-after" });
    expect(classifyMemberDrop(2, 3, 0.4)).toEqual({ kind: "join", memberIndex: 2 });
  });

  it("filters collection metadata against the persisted leaf subset without mutating input", () => {
    const registry: TabCollection[] = [
      { id: "a", name: "A", color: "gray", collapsed: true },
      { id: "b", name: "B", color: "blue", collapsed: false },
    ];
    const original = leaves(["1", "a"], ["2", "a"], ["3", "b"]);
    expect(normalizeSerializedCollectionSubset([], registry)).toEqual({ leaves: [], collections: [] });
    expect(normalizeSerializedCollectionSubset([original[0]], registry)).toEqual({
      leaves: [original[0]], collections: [registry[0]],
    });
    expect(normalizeSerializedCollectionSubset([original[0], original[1]], registry)).toEqual({
      leaves: [original[0], original[1]], collections: [registry[0]],
    });
    expect(original).toEqual(leaves(["1", "a"], ["2", "a"], ["3", "b"]));
  });

  it("attempts every close target and collects failures at the beginning, middle, and end", async () => {
    const attempted: string[] = [];
    const errors = await runAllSettled(["first", "ok-1", "middle", "ok-2", "last"], async (value) => {
      attempted.push(value);
      if (["first", "middle", "last"].includes(value)) throw new Error(value);
    });
    expect(attempted).toEqual(["first", "ok-1", "middle", "ok-2", "last"]);
    expect(errors.map((error) => error.message)).toEqual(["first", "middle", "last"]);
  });

  it("generates a split-local id that cannot collide with restored ids", () => {
    expect(uniqueCollectionId(new Set(["collection-1", "collection-2"]), () => "collection-1")).toBe("collection-1-2");
  });

  it("selects exact, next, then previous survivors across zero/one/many missing leaves", () => {
    expect(selectNearestSurvivor([], 2)).toBeUndefined();
    expect(selectNearestSurvivor([{ sourceIndex: 3, value: "only" }], 0)?.value).toBe("only");
    expect(selectNearestSurvivor([{ sourceIndex: 0, value: "before" }, { sourceIndex: 2, value: "after" }], 1)?.value).toBe("after");
    expect(selectNearestSurvivor([{ sourceIndex: 0, value: "before" }], 2)?.value).toBe("before");
    expect(selectNearestSurvivor([{ sourceIndex: 1, value: "exact" }], 1)?.value).toBe("exact");
  });
});
