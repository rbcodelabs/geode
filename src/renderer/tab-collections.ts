export const COLLECTION_COLORS = ["gray", "blue", "cyan", "green", "yellow", "orange", "red", "purple"] as const;
export type CollectionColor = typeof COLLECTION_COLORS[number];

export interface TabCollection {
  id: string;
  name: string;
  color: CollectionColor;
  collapsed: boolean;
}

export interface CollectionLeaf {
  id: string;
  collectionId?: string;
}

export function normalizeCollectionName(value: unknown): string {
  const trimmed = typeof value === "string" ? value.trim() : "";
  const name = trimmed || "New collection";
  return [...name].slice(0, 80).join("");
}

export function isCollectionColor(value: unknown): value is CollectionColor {
  return typeof value === "string" && (COLLECTION_COLORS as readonly string[]).includes(value);
}

export function nextCollectionColor(collections: readonly TabCollection[]): CollectionColor {
  const used = new Set(collections.map((collection) => collection.color));
  const unused = COLLECTION_COLORS.find((color) => !used.has(color));
  return unused ?? COLLECTION_COLORS[collections.length % COLLECTION_COLORS.length];
}

export function normalizeTabCollections<TLeaf extends CollectionLeaf>(
  inputLeaves: readonly TLeaf[],
  inputCollections: readonly TabCollection[] = [],
): { leaves: TLeaf[]; collections: TabCollection[] } {
  const seen = new Set<string>();
  const registry: TabCollection[] = [];
  for (const candidate of inputCollections) {
    if (!candidate || typeof candidate.id !== "string" || !candidate.id || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    registry.push({
      ...candidate,
      id: candidate.id,
      name: normalizeCollectionName(candidate.name),
      color: isCollectionColor(candidate.color) ? candidate.color : "gray",
      collapsed: candidate.collapsed === true,
    });
  }

  const valid = new Set(registry.map((collection) => collection.id));
  const sanitized = inputLeaves.map((leaf) => {
    if (!leaf.collectionId || valid.has(leaf.collectionId)) return { ...leaf };
    const { collectionId: _ignored, ...rest } = leaf;
    return rest as TLeaf;
  });

  const first = new Map<string, number>();
  sanitized.forEach((leaf, index) => {
    if (leaf.collectionId && !first.has(leaf.collectionId)) first.set(leaf.collectionId, index);
  });
  const orderedCollections = registry
    .filter((collection) => first.has(collection.id))
    .sort((a, b) => first.get(a.id)! - first.get(b.id)!);

  const inserted = new Set<string>();
  const leaves: TLeaf[] = [];
  for (const leaf of sanitized) {
    const id = leaf.collectionId;
    if (!id) {
      leaves.push(leaf);
      continue;
    }
    if (inserted.has(id)) continue;
    inserted.add(id);
    leaves.push(...sanitized.filter((candidate) => candidate.collectionId === id));
  }
  return { leaves, collections: orderedCollections };
}

export function moveLeafToCollection<TLeaf extends CollectionLeaf>(
  leaves: readonly TLeaf[],
  collections: readonly TabCollection[],
  leafId: string,
  collectionId: string | undefined,
  memberIndex?: number,
): { leaves: TLeaf[]; collections: TabCollection[] } {
  const moving = leaves.find((leaf) => leaf.id === leafId);
  if (!moving) return normalizeTabCollections(leaves, collections);
  const remaining = leaves.filter((leaf) => leaf.id !== leafId).map((leaf) => ({ ...leaf }));
  const updated = { ...moving, collectionId };
  if (!collectionId) {
    remaining.push(updated);
  } else {
    const members = remaining.filter((leaf) => leaf.collectionId === collectionId);
    const desired = Math.max(0, Math.min(memberIndex ?? members.length, members.length));
    if (!members.length) remaining.push(updated);
    else {
      const anchor = remaining.indexOf(members[Math.min(desired, members.length - 1)]);
      remaining.splice(desired === members.length ? remaining.indexOf(members[members.length - 1]) + 1 : anchor, 0, updated);
    }
  }
  return normalizeTabCollections(remaining, collections);
}

export function collectionBlocks(leaves: readonly CollectionLeaf[]): Array<
  { kind: "leaf"; leafIds: string[] } | { kind: "collection"; collectionId: string; leafIds: string[] }
> {
  const blocks: Array<{ kind: "leaf"; leafIds: string[] } | { kind: "collection"; collectionId: string; leafIds: string[] }> = [];
  for (const leaf of leaves) {
    if (!leaf.collectionId) blocks.push({ kind: "leaf", leafIds: [leaf.id] });
    else {
      const previous = blocks[blocks.length - 1];
      if (previous?.kind === "collection" && previous.collectionId === leaf.collectionId) previous.leafIds.push(leaf.id);
      else blocks.push({ kind: "collection", collectionId: leaf.collectionId, leafIds: [leaf.id] });
    }
  }
  return blocks;
}

export function moveCollectionBlock<TLeaf extends CollectionLeaf>(
  leaves: readonly TLeaf[],
  collectionId: string,
  insertionIndex: number,
): TLeaf[] {
  const members = leaves.filter((leaf) => leaf.collectionId === collectionId);
  if (!members.length) return [...leaves];
  const first = leaves.findIndex((leaf) => leaf.collectionId === collectionId);
  const remaining = leaves.filter((leaf) => leaf.collectionId !== collectionId);
  let adjusted = Math.max(0, Math.min(insertionIndex, leaves.length));
  if (adjusted > first) adjusted -= members.length;
  remaining.splice(Math.max(0, Math.min(adjusted, remaining.length)), 0, ...members);
  return remaining;
}

export function tabStripNavigationIndex(key: string, current: number, length: number): number {
  if (length <= 0) return -1;
  if (key === "Home") return 0;
  if (key === "End") return length - 1;
  if (key === "ArrowLeft") return Math.max(0, current - 1);
  if (key === "ArrowRight") return Math.min(length - 1, current + 1);
  return current;
}

export type MemberDrop =
  | { kind: "ungrouped-before" }
  | { kind: "ungrouped-after" }
  | { kind: "join"; memberIndex: number };

export function classifyMemberDrop(memberIndex: number, memberCount: number, fraction: number): MemberDrop {
  if (memberIndex === 0 && fraction <= 0.2) return { kind: "ungrouped-before" };
  if (memberIndex === memberCount - 1 && fraction >= 0.8) return { kind: "ungrouped-after" };
  return { kind: "join", memberIndex: memberIndex + (fraction >= 0.5 ? 1 : 0) };
}

export function normalizeSerializedCollectionSubset<TLeaf extends CollectionLeaf>(
  leaves: readonly TLeaf[],
  collections: readonly TabCollection[],
): { leaves: TLeaf[]; collections: TabCollection[] } {
  return normalizeTabCollections(leaves, collections);
}

export async function runAllSettled<T>(items: readonly T[], action: (item: T) => void | Promise<void>): Promise<Error[]> {
  const errors: Error[] = [];
  for (const item of items) {
    try {
      await action(item);
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  return errors;
}

export function uniqueCollectionId(existing: ReadonlySet<string>, createCandidate: () => string): string {
  const candidate = createCandidate();
  if (!existing.has(candidate)) return candidate;
  let suffix = Math.max(2, existing.size);
  while (existing.has(`${candidate}-${suffix}`)) suffix += 1;
  return `${candidate}-${suffix}`;
}

export function selectNearestSurvivor<T extends { sourceIndex: number }>(survivors: readonly T[], activeIndex: number): T | undefined {
  return survivors.find((entry) => entry.sourceIndex === activeIndex)
    ?? survivors.find((entry) => entry.sourceIndex > activeIndex)
    ?? [...survivors].reverse().find((entry) => entry.sourceIndex < activeIndex);
}
