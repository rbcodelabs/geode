import { describe, expect, it } from "vitest";
import { MetadataCache } from "../../src/renderer/metadata-cache";
import { FakeVault } from "../helpers/fake-vault";

async function cacheFor(files: Record<string, string>) {
  const vault = new FakeVault(files);
  const cache = new MetadataCache(vault as never);
  await cache.initialize();
  return { vault, cache };
}

describe("MetadataCache.getBacklinksForFile", () => {
  it("returns the Obsidian shape: data Map<sourcePath, Reference[]> plus get/keys", async () => {
    const { vault, cache } = await cacheFor({
      "Target.md": "# T",
      "A.md": "link [[Target|alias]] and ![[Target#H]] and [md](Target.md)",
      "dir/B.md": "[[Target]]",
      "C.md": "no links, [[Missing]]",
    });
    const result = cache.getBacklinksForFile(vault.getFileByPath("Target.md")!);
    expect(result.data).toBeInstanceOf(Map);
    expect([...result.keys()].sort()).toEqual(["A.md", "dir/B.md"]);
    const refs = result.get("A.md")!;
    expect(refs).toHaveLength(3);
    expect(refs.map((r) => r.original).sort()).toEqual(["![[Target#H]]", "[[Target|alias]]", "[md](Target.md)"].sort());
    for (const ref of refs) {
      expect(typeof ref.link).toBe("string");
      expect(typeof ref.displayText).toBe("string");
      expect(ref.position.start.line).toBe(0);
    }
    const seen: string[] = [];
    result.data.forEach((list: Array<{ original: string }>, source: string) => seen.push(`${source}:${list.map((r) => r.original).length}`));
    expect(seen.sort()).toEqual(["A.md:3", "dir/B.md:1"]);
  });

  it("returns an empty map for a file with no backlinks", async () => {
    const { vault, cache } = await cacheFor({ "Lonely.md": "x" });
    const result = cache.getBacklinksForFile(vault.getFileByPath("Lonely.md")!);
    expect(result.data.size).toBe(0);
    expect(result.get("Anything.md")).toBeUndefined();
  });

  it("matches getBacklinks sources exactly", async () => {
    const { vault, cache } = await cacheFor({ "T.md": "", "A.md": "[[T]]", "B.md": "[[T]] [[T]]", "C.md": "[[T]]" });
    const t = vault.getFileByPath("T.md")!;
    expect([...cache.getBacklinksForFile(t).keys()].sort()).toEqual(cache.getBacklinks(t).map((b) => b.source.path).sort());
    expect(cache.getBacklinksForFile(t).get("B.md")).toHaveLength(2);
  });
});
