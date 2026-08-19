import { describe, expect, it, vi } from "vitest";
import { MetadataCache } from "../../src/renderer/metadata-cache";
import { FakeVault } from "../helpers/fake-vault";

/**
 * Regression guard for the incremental per-edit indexing path in
 * `MetadataCache`. The centrepiece is the GOLDEN EQUIVALENCE test: a
 * deterministic randomized sequence of create/modify/delete/rename/
 * alias-change ops is applied through the incremental event path, and the
 * resulting indices are asserted to deep-equal a from-scratch rebuild over
 * the same final vault state. The targeted tests pin the individual
 * behaviours that make that equivalence hold, and the coalescing test proves
 * a burst flushes once with a MINIMAL number of `resolveFile` calls.
 */

/** Wait for the microtask-scheduled flush (and its async reads) to complete. */
const settle = () => new Promise((r) => setTimeout(r, 0));

/**
 * Drives `MetadataCache`'s incremental path by mutating a `FakeVault` exactly
 * the way the real `Vault` does (state changes BEFORE the event fires) and
 * then triggering the matching event.
 */
class Driver {
  constructor(
    readonly fake: FakeVault,
    readonly cache: MetadataCache
  ) {}

  async create(path: string, content: string): Promise<void> {
    this.fake.setFile(path, content);
    this.fake.trigger("create", this.fake.getFileByPath(path));
    await settle();
  }

  async modify(path: string, content: string): Promise<void> {
    this.fake.setFile(path, content);
    this.fake.trigger("modify", this.fake.getFileByPath(path));
    await settle();
  }

  async delete(path: string): Promise<void> {
    const f = this.fake.getFileByPath(path);
    if (!f) return;
    this.fake.removeFile(path);
    this.fake.trigger("delete", f);
    await settle();
  }

  async rename(oldPath: string, newPath: string): Promise<void> {
    const content = this.fake.getCachedContent(oldPath) ?? "";
    this.fake.removeFile(oldPath);
    this.fake.setFile(newPath, content);
    this.fake.trigger("rename", this.fake.getFileByPath(newPath), oldPath);
    await settle();
  }
}

// --- Canonicalizers so comparisons are independent of Map insertion order ---

function normLinks(m: Record<string, Record<string, number>>): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const [k, inner] of Object.entries(m).sort(([a], [b]) => a.localeCompare(b))) {
    const o: Record<string, number> = {};
    for (const [ik, iv] of Object.entries(inner).sort(([a], [b]) => a.localeCompare(b))) o[ik] = iv;
    out[k] = o;
  }
  return out;
}

function normList(m: Map<string, string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [k, v] of [...m.entries()].sort(([a], [b]) => a.localeCompare(b))) out[k] = [...v].sort();
  return out;
}

/** Snapshot all four externally-relevant indices in a comparable form. */
function snapshot(cache: MetadataCache) {
  const c = cache as unknown as { byBasename: Map<string, string[]>; byAlias: Map<string, string[]> };
  return {
    resolved: normLinks(cache.resolvedLinks),
    unresolved: normLinks(cache.unresolvedLinks),
    byBasename: normList(c.byBasename),
    byAlias: normList(c.byAlias),
  };
}

describe("MetadataCache incremental — targeted behaviours", () => {
  async function withCache(files: Record<string, string>) {
    const fake = new FakeVault(files);
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    return new Driver(fake, cache);
  }

  it("create resolves a previously dangling [[F]]", async () => {
    const d = await withCache({ "Home.md": "See [[Target]]." });
    expect(d.cache.unresolvedLinks["Home.md"]?.["Target"]).toBe(1);

    await d.create("Target.md", "");
    expect(d.cache.unresolvedLinks["Home.md"]?.["Target"]).toBeUndefined();
    expect(d.cache.resolvedLinks["Home.md"]?.["Target.md"]).toBe(1);
    expect(d.cache.getBacklinks(d.fake.getFileByPath("Target.md")!).map((b) => b.source.path)).toEqual([
      "Home.md",
    ]);
  });

  it("delete re-resolves a backlink to a same-basename sibling, then to unresolved", async () => {
    const d = await withCache({ "A/Note.md": "", "B/Note.md": "", "Home.md": "[[Note]]" });
    // Shortest-path (tie broken by path sort) → "A/Note.md".
    expect(d.cache.resolvedLinks["Home.md"]?.["A/Note.md"]).toBe(1);

    await d.delete("A/Note.md");
    // Falls back to the surviving sibling.
    expect(d.cache.resolvedLinks["Home.md"]?.["B/Note.md"]).toBe(1);

    await d.delete("B/Note.md");
    // No sibling left → dangling again.
    expect(Object.keys(d.cache.resolvedLinks["Home.md"] ?? {})).toHaveLength(0);
    expect(d.cache.unresolvedLinks["Home.md"]?.["Note"]).toBe(1);
  });

  it("rename (folder move, basename unchanged) updates backlinks AND preserves the renamed file's own outgoing links", async () => {
    const d = await withCache({ "Note.md": "[[Target]]", "Target.md": "", "Home.md": "[[Note]]" });
    expect(d.cache.resolvedLinks["Home.md"]?.["Note.md"]).toBe(1);

    await d.rename("Note.md", "sub/Note.md");

    // Backlink from Home now points at the moved file.
    expect(d.cache.resolvedLinks["Home.md"]?.["sub/Note.md"]).toBe(1);
    expect(Object.hasOwn(d.cache.resolvedLinks, "Note.md")).toBe(false);
    // The moved file's own outgoing link is preserved under the new path.
    expect(d.cache.resolvedLinks["sub/Note.md"]?.["Target.md"]).toBe(1);
    expect(d.cache.getBacklinks(d.fake.getFileByPath("sub/Note.md")!).map((b) => b.source.path)).toEqual(
      ["Home.md"]
    );
  });

  it("frontmatter alias add resolves [[alias]], and removing it unresolves again", async () => {
    const d = await withCache({ "Home.md": "", "Note.md": "[[Start Here]]" });
    expect(d.cache.unresolvedLinks["Note.md"]?.["Start Here"]).toBe(1);

    await d.modify("Home.md", "---\naliases: [Start Here]\n---\n");
    expect(d.cache.resolvedLinks["Note.md"]?.["Home.md"]).toBe(1);
    expect(d.cache.unresolvedLinks["Note.md"]?.["Start Here"]).toBeUndefined();

    await d.modify("Home.md", "no alias anymore");
    expect(Object.keys(d.cache.resolvedLinks["Note.md"] ?? {})).toHaveLength(0);
    expect(d.cache.unresolvedLinks["Note.md"]?.["Start Here"]).toBe(1);
  });

  it("shortest-path basename tiebreak still holds after incremental delete/create", async () => {
    const d = await withCache({
      "Deep/Nested/Folder/Target.md": "",
      "Sub/Target.md": "",
      "Welcome.md": "[[Target]]",
    });
    expect(d.cache.resolvedLinks["Welcome.md"]?.["Sub/Target.md"]).toBe(1);

    await d.delete("Sub/Target.md");
    expect(d.cache.resolvedLinks["Welcome.md"]?.["Deep/Nested/Folder/Target.md"]).toBe(1);

    await d.create("Target.md", "");
    // A brand-new, shorter path wins the tiebreak.
    expect(d.cache.resolvedLinks["Welcome.md"]?.["Target.md"]).toBe(1);
  });

  it("resolves a non-md file by both full name and basename on create, and re-dangles on delete", async () => {
    const d = await withCache({ "Home.md": "[[image.png]] and [[image]]" });
    expect(d.cache.unresolvedLinks["Home.md"]?.["image.png"]).toBe(1);
    expect(d.cache.unresolvedLinks["Home.md"]?.["image"]).toBe(1);

    await d.create("image.png", "");
    expect(d.cache.resolvedLinks["Home.md"]?.["image.png"]).toBe(2);
    expect(Object.keys(d.cache.unresolvedLinks["Home.md"] ?? {})).toHaveLength(0);

    await d.delete("image.png");
    expect(Object.keys(d.cache.resolvedLinks["Home.md"] ?? {})).toHaveLength(0);
    expect(d.cache.unresolvedLinks["Home.md"]?.["image.png"]).toBe(1);
    expect(d.cache.unresolvedLinks["Home.md"]?.["image"]).toBe(1);
  });
});

describe("MetadataCache incremental — burst coalescing", () => {
  it("flushes a synchronous burst ONCE, fires changed per changed file, and calls resolveFile the minimal number of times", async () => {
    const fake = new FakeVault({
      "A.md": "",
      "B.md": "",
      "C.md": "",
      "T1.md": "",
      "T2.md": "",
      "T3.md": "",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const flushSpy = vi.spyOn(cache as unknown as { flush: () => Promise<void> }, "flush");
    const resolveSpy = vi.spyOn(cache as unknown as { resolveFile: (p: string) => void }, "resolveFile");
    const changed: string[] = [];
    cache.on("changed", (f: { path: string }) => changed.push(f.path));

    // Three modifies fired synchronously — one burst, no awaits between them.
    fake.setFile("A.md", "[[T1]]");
    fake.trigger("modify", fake.getFileByPath("A.md"));
    fake.setFile("B.md", "[[T2]]");
    fake.trigger("modify", fake.getFileByPath("B.md"));
    fake.setFile("C.md", "[[T3]]");
    fake.trigger("modify", fake.getFileByPath("C.md"));

    await settle();

    // One coalesced flush for the whole burst.
    expect(flushSpy).toHaveBeenCalledTimes(1);
    // `changed` still fires once per changed file (plugin contract + BaseView).
    expect(changed.sort()).toEqual(["A.md", "B.md", "C.md"]);
    // Minimal resolution: exactly the 3 modified files, NOT the whole vault.
    expect(resolveSpy).toHaveBeenCalledTimes(3);
    expect(resolveSpy.mock.calls.map((c) => c[0]).sort()).toEqual(["A.md", "B.md", "C.md"]);
    // Proof it isn't O(files): the vault has 6 files, we resolved 3.
    expect(fake.getMarkdownFiles().length).toBe(6);

    // And the resolution is correct afterwards.
    expect(cache.resolvedLinks["A.md"]?.["T1.md"]).toBe(1);
    expect(cache.resolvedLinks["B.md"]?.["T2.md"]).toBe(1);
    expect(cache.resolvedLinks["C.md"]?.["T3.md"]).toBe(1);

    flushSpy.mockRestore();
    resolveSpy.mockRestore();
  });
});

// --- Deterministic PRNG (mulberry32) for a reproducible op sequence ---------
function mulberry32(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) | 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe("MetadataCache incremental — golden equivalence", () => {
  const UNIVERSE = ["Alpha.md", "Beta.md", "Gamma.md", "sub/Delta.md", "sub/Alpha.md", "deep/Epsilon.md"];
  const LINK_TARGETS = ["Alpha", "Beta", "Gamma", "Delta", "Epsilon", "Ghost", "AKA", "Nick"];
  const ALIASES = ["AKA", "Nick", "Handle"];

  function genContent(rng: () => number): string {
    const pick = <T,>(arr: T[], n: number): T[] => {
      const out: T[] = [];
      for (let i = 0; i < n; i++) out.push(arr[Math.floor(rng() * arr.length)]);
      return out;
    };
    const nAliases = Math.floor(rng() * 3); // 0..2
    const aliases = [...new Set(pick(ALIASES, nAliases))];
    const links = pick(LINK_TARGETS, 1 + Math.floor(rng() * 3)); // 1..3
    const fm = aliases.length ? `---\naliases: [${aliases.join(", ")}]\n---\n` : "";
    return `${fm}Body ${links.map((l) => `[[${l}]]`).join(" ")}.`;
  }

  it.each([0xc0ffee, 0x12345, 0xabcd, 0xbeef, 0x99, 0x2718281])(
    "a randomized op sequence through the incremental path matches a from-scratch rebuild (seed 0x%s)",
    async (SEED) => {
    const rng = mulberry32(SEED);
    const fake = new FakeVault({});
    const cache = new MetadataCache(fake.asVault());
    // Start from an empty vault so the whole final state is built purely
    // through the incremental event path.
    const d = new Driver(fake, cache);

    const log: string[] = [];
    for (let i = 0; i < 90; i++) {
      const existing = fake.getMarkdownFiles().map((f) => f.path);
      const missing = UNIVERSE.filter((p) => !existing.includes(p));

      if (existing.length === 0 || (missing.length > 0 && rng() < 0.35)) {
        const path = missing[Math.floor(rng() * missing.length)];
        const content = genContent(rng);
        log.push(`create ${path}`);
        await d.create(path, content);
      } else {
        const path = existing[Math.floor(rng() * existing.length)];
        const a = rng();
        if (a < 0.5) {
          const content = genContent(rng);
          log.push(`modify ${path}`);
          await d.modify(path, content);
        } else if (a < 0.75 && missing.length > 0) {
          const to = missing[Math.floor(rng() * missing.length)];
          log.push(`rename ${path} -> ${to}`);
          await d.rename(path, to);
        } else {
          log.push(`delete ${path}`);
          await d.delete(path);
        }
      }
    }

    // Oracle: a fresh cache built from scratch over the SAME final vault state.
    const oracle = new MetadataCache(fake.asVault());
    await oracle.initialize();

    try {
      expect(snapshot(cache)).toEqual(snapshot(oracle));
    } catch (err) {
      // Surface the exact sequence so any failure is reproducible.
      console.error(`Golden equivalence FAILED. seed=0x${SEED.toString(16)} sequence:\n${log.join("\n")}`);
      throw err;
    }
  }
  );
});
