import { describe, expect, it, vi } from "vitest";
import {
  findUnlinkedMentions,
  INDEX_CONCURRENCY,
  MetadataCache,
  parseMetadata,
  processInBatches,
} from "../../src/renderer/metadata-cache";
import { FakeVault } from "../helpers/fake-vault";

describe("parseMetadata", () => {
  it("parses YAML frontmatter, including alias/tag shorthand keys", () => {
    const meta = parseMetadata(
      `---\ntags: [intro, geode]\naliases: [Start Here]\ntitle: Welcome\n---\n\n# Hi\n`
    );
    expect(meta.frontmatter).toEqual({
      tags: ["intro", "geode"],
      aliases: ["Start Here"],
      title: "Welcome",
    });
    expect(meta.aliases).toEqual(["Start Here"]);
    expect(meta.tags.map((t) => t.tag)).toEqual(["intro", "geode"]);
  });

  it("accepts singular alias/tag frontmatter keys as scalars", () => {
    const meta = parseMetadata(`---\nalias: Only One\ntag: solo\n---\nBody\n`);
    expect(meta.aliases).toEqual(["Only One"]);
    expect(meta.tags.map((t) => t.tag)).toEqual(["solo"]);
  });

  it("treats malformed frontmatter YAML as body text (frontmatter left undefined, Obsidian-style)", () => {
    const meta = parseMetadata(`---\n: not valid: yaml: at all\n---\nBody\n`);
    expect(meta.frontmatter).toBeUndefined();
  });

  it("has no frontmatter (undefined, not null) when the document doesn't start with a --- block", () => {
    const meta = parseMetadata(`# Just a note\n\nNo frontmatter here.\n`);
    expect(meta.frontmatter).toBeUndefined();
    expect(meta.frontmatterEndOffset).toBe(0);
  });

  it("parses wikilinks with display text and distinguishes embeds", () => {
    const text = `See [[Daily Plan]] and [[Projects/Roadmap|the roadmap]]. Embed: ![[image.png]]`;
    const meta = parseMetadata(text);
    expect(meta.links).toHaveLength(2);
    expect(meta.links[0]).toMatchObject({ link: "Daily Plan", displayText: "Daily Plan", isEmbed: false });
    expect(meta.links[1]).toMatchObject({
      link: "Projects/Roadmap",
      displayText: "the roadmap",
      isEmbed: false,
    });
    expect(meta.embeds).toHaveLength(1);
    expect(meta.embeds[0]).toMatchObject({ link: "image.png", isEmbed: true });
  });

  it("records accurate line/ch positions for links", () => {
    const text = `line one\nline two [[Target]]\n`;
    const meta = parseMetadata(text);
    expect(meta.links[0].position.start.line).toBe(1);
    expect(meta.links[0].position.start.ch).toBe(9);
  });

  it("parses inline tags, including nested tags, and rejects numeric-only tags", () => {
    const text = `Body with #getting-started and #project/geode and not-a #123 tag, but #a1 is fine.`;
    const meta = parseMetadata(text);
    const tagNames = meta.tags.map((t) => t.tag);
    expect(tagNames).toContain("getting-started");
    expect(tagNames).toContain("project/geode");
    expect(tagNames).not.toContain("123");
    expect(tagNames).toContain("a1");
  });

  it("ignores links and tags inside fenced and inline code", () => {
    const text = "Real [[Link]] and #tag.\n```\n[[Not A Link]] #not-a-tag\n```\nInline `[[Also Not]] #nope` done.";
    const meta = parseMetadata(text);
    expect(meta.links.map((l) => l.link)).toEqual(["Link"]);
    expect(meta.tags.map((t) => t.tag)).toEqual(["tag"]);
  });

  it("parses ATX headings with levels, ignoring headings inside code fences", () => {
    const text = "# Title\n\n## Sub\n\n```\n# not a heading\n```\n### Sub sub ###\n";
    const meta = parseMetadata(text);
    expect(meta.headings).toEqual([
      expect.objectContaining({ heading: "Title", level: 1 }),
      expect.objectContaining({ heading: "Sub", level: 2 }),
      // Trailing "###" closing-hash sequence is stripped, matching ATX heading syntax.
      expect.objectContaining({ heading: "Sub sub", level: 3 }),
    ]);
  });
});

describe("MetadataCache.getFirstLinkpathDest", () => {
  async function buildCache(files: Record<string, string>) {
    const fake = new FakeVault(files);
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    return { cache, fake };
  }

  it("resolves an exact vault path, with or without .md extension", async () => {
    const { cache } = await buildCache({ "Projects/Roadmap.md": "" });
    expect(cache.getFirstLinkpathDest("Projects/Roadmap.md", "Welcome.md")?.path).toBe(
      "Projects/Roadmap.md"
    );
    expect(cache.getFirstLinkpathDest("Projects/Roadmap", "Welcome.md")?.path).toBe(
      "Projects/Roadmap.md"
    );
  });

  it("prefers a sibling in the source file's folder over a shorter basename match elsewhere", async () => {
    const { cache } = await buildCache({
      // Shorter path, but not a sibling of the source file.
      "A/Notes.md": "",
      // Sibling of the source file, but a longer path overall.
      "Projects/Notes.md": "",
    });
    // Relative-to-source-folder resolution must win over the basename
    // fallback's shortest-path heuristic.
    expect(cache.getFirstLinkpathDest("Notes", "Projects/Roadmap.md")?.path).toBe(
      "Projects/Notes.md"
    );
  });

  it("resolves a bare basename to the shortest matching path when multiple candidates exist", async () => {
    const { cache } = await buildCache({
      "Deep/Nested/Folder/Target.md": "",
      "Sub/Target.md": "",
    });
    expect(cache.getFirstLinkpathDest("Target", "Welcome.md")?.path).toBe("Sub/Target.md");
  });

  it("resolves an alias when no path/basename match exists", async () => {
    const { cache } = await buildCache({
      "Welcome.md": "---\naliases: [Start Here]\n---\n",
    });
    expect(cache.getFirstLinkpathDest("Start Here", "Other.md")?.path).toBe("Welcome.md");
  });

  it("treats a heading-only link as a self-link to the source file", async () => {
    const { cache } = await buildCache({ "Welcome.md": "" });
    expect(cache.getFirstLinkpathDest("#Some Heading", "Welcome.md")?.path).toBe("Welcome.md");
  });

  it("returns null for an unresolved link target", async () => {
    const { cache } = await buildCache({ "Welcome.md": "" });
    expect(cache.getFirstLinkpathDest("Nonexistent", "Welcome.md")).toBeNull();
  });

  it("is case-insensitive for basename matching", async () => {
    const { cache } = await buildCache({ "Welcome.md": "" });
    expect(cache.getFirstLinkpathDest("welcome", "Other.md")?.path).toBe("Welcome.md");
  });
});

describe("MetadataCache backlinks and tag index", () => {
  it("tracks resolved backlinks and unresolved links after initialize()", async () => {
    const fake = new FakeVault({
      "Welcome.md": "Links to [[Daily Plan]] and [[Ghost Note]].",
      "Daily Plan.md": "# Daily Plan",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const welcome = fake.getFileByPath("Welcome.md")!;
    const dailyPlan = fake.getFileByPath("Daily Plan.md")!;

    const backlinks = cache.getBacklinks(dailyPlan);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0].source.path).toBe("Welcome.md");

    expect(cache.unresolvedLinks[welcome.path]?.["Ghost Note"]).toBe(1);
  });

  it("aggregates tag usage counts across the vault via getAllTags", async () => {
    const fake = new FakeVault({
      "A.md": "#shared #onlyA",
      "B.md": "#shared",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    const tags = cache.getAllTags();
    expect(tags.get("shared")).toBe(2);
    expect(tags.get("onlyA")).toBe(1);
  });

  it("re-indexes a file and refreshes links when the vault emits 'modify'", async () => {
    const fake = new FakeVault({ "A.md": "no links here" });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    fake.setFile("A.md", "now links to [[B]]");
    fake.setFile("B.md", "");
    // MetadataCache subscribes to vault 'modify'/'create' in its constructor.
    fake.trigger("modify", fake.getFileByPath("A.md"));
    fake.trigger("create", fake.getFileByPath("B.md"));
    // indexFile() is async; flush microtasks.
    await new Promise((r) => setTimeout(r, 0));

    const b = fake.getFileByPath("B.md")!;
    const backlinks = cache.getBacklinks(b);
    expect(backlinks.map((bl) => bl.source.path)).toEqual(["A.md"]);
  });

  it("silently ignores a benign ENOENT race (file deleted between the event and the read)", async () => {
    const fake = new FakeVault({ "A.md": "content" });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    const aFile = fake.getFileByPath("A.md")!;

    // File is gone by the time indexFile's cachedRead runs — FakeVault's
    // cachedRead throws a wrapped-IPC-shaped ENOENT message for a missing file.
    fake.removeFile("A.md");
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.trigger("modify", aFile);
    await new Promise((r) => setTimeout(r, 0));

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("still logs a genuine, non-ENOENT indexing failure", async () => {
    const fake = new FakeVault({ "A.md": "content" });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    const aFile = fake.getFileByPath("A.md")!;

    (fake as any).cachedRead = async () => {
      throw new Error("disk exploded");
    };
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    fake.trigger("modify", aFile);
    await new Promise((r) => setTimeout(r, 0));

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain("Failed to index");
    errorSpy.mockRestore();
  });
});

describe("findUnlinkedMentions", () => {
  it("finds a whole-word, case-insensitive plain-text mention", () => {
    const out = findUnlinkedMentions("I should read the Daily Plan tomorrow.", ["Daily Plan"]);
    expect(out).toEqual([{ line: 0, snippet: "I should read the Daily Plan tomorrow.", count: 1 }]);
  });

  it("does not match a substring inside a longer word", () => {
    const out = findUnlinkedMentions("Dailyplanner is not a mention of Daily Plan's name.", ["Daily"]);
    expect(out).toHaveLength(1); // only the real "Daily Plan's" occurrence, not "Dailyplanner"
    expect(out[0].snippet).toContain("Daily Plan's");
  });

  it("ignores occurrences already inside a [[wikilink]] or ![[embed]], even if unresolved", () => {
    const text = "See [[Daily Plan]] and ![[Daily Plan#Section]] and [[Daily Plan|aliased]].";
    expect(findUnlinkedMentions(text, ["Daily Plan"])).toEqual([]);
  });

  it("ignores occurrences inside fenced or inline code", () => {
    const text = "Real mention of Target here.\n```\nTarget in code\n```\nInline `Target` too.";
    const out = findUnlinkedMentions(text, ["Target"]);
    expect(out).toHaveLength(1);
    expect(out[0].snippet).toBe("Real mention of Target here.");
  });

  it("groups multiple occurrences on the same line into one entry with a count", () => {
    const out = findUnlinkedMentions("Target and Target again.", ["Target"]);
    expect(out).toEqual([{ line: 0, snippet: "Target and Target again.", count: 2 }]);
  });

  it("matches any of several candidate names (e.g. basename + aliases)", () => {
    const text = "Line one mentions Home Base.\nLine two mentions HQ.\nLine three mentions neither.";
    const out = findUnlinkedMentions(text, ["Home Base", "HQ"]);
    expect(out.map((m) => m.line)).toEqual([0, 1]);
  });

  it("returns an empty array when there are no candidate names or no matches", () => {
    expect(findUnlinkedMentions("Some text.", [])).toEqual([]);
    expect(findUnlinkedMentions("Some text.", ["Nonexistent"])).toEqual([]);
  });
});

describe("MetadataCache.getBacklinksWithContext", () => {
  it("attaches a trimmed line snippet for each resolved link occurrence", async () => {
    const fake = new FakeVault({
      "Welcome.md": "Intro line.\nSee [[Daily Plan]] for today's tasks.",
      "Daily Plan.md": "# Daily Plan",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const dailyPlan = fake.getFileByPath("Daily Plan.md")!;
    const backlinks = cache.getBacklinksWithContext(dailyPlan);
    expect(backlinks).toHaveLength(1);
    expect(backlinks[0]).toMatchObject({
      count: 1,
      snippets: ["See [[Daily Plan]] for today's tasks."],
    });
  });

  it("collects one snippet per occurrence when a source links the same target multiple times", async () => {
    const fake = new FakeVault({
      "A.md": "First [[B]] mention.\nSecond [[B]] mention.",
      "B.md": "",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const b = fake.getFileByPath("B.md")!;
    const backlinks = cache.getBacklinksWithContext(b);
    expect(backlinks[0].snippets).toEqual(["First [[B]] mention.", "Second [[B]] mention."]);
  });
});

describe("MetadataCache.getUnlinkedMentions", () => {
  it("detects a plain-text mention of the target's basename in another file", async () => {
    const fake = new FakeVault({
      "Welcome.md": "Remember to check the Daily Plan before lunch.",
      "Daily Plan.md": "# Daily Plan",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const dailyPlan = fake.getFileByPath("Daily Plan.md")!;
    const mentions = cache.getUnlinkedMentions(dailyPlan);
    expect(mentions).toHaveLength(1);
    expect(mentions[0].source.path).toBe("Welcome.md");
    expect(mentions[0].mentions[0].snippet).toBe("Remember to check the Daily Plan before lunch.");
  });

  it("excludes the target file itself and any occurrence already inside a wikilink", async () => {
    const fake = new FakeVault({
      "Welcome.md": "Linked: [[Daily Plan]]. Unlinked: Daily Plan mentioned again in prose.",
      "Daily Plan.md": "This note is called Daily Plan too, but that doesn't count against itself.",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const dailyPlan = fake.getFileByPath("Daily Plan.md")!;
    const mentions = cache.getUnlinkedMentions(dailyPlan);
    expect(mentions.map((m) => m.source.path)).toEqual(["Welcome.md"]); // not "Daily Plan.md" itself
    expect(mentions[0].mentions).toHaveLength(1); // the [[Daily Plan]] occurrence is excluded
    expect(mentions[0].mentions[0].snippet).toContain("Unlinked: Daily Plan mentioned again");
  });

  it("also matches the target's frontmatter aliases", async () => {
    const fake = new FakeVault({
      "Welcome.md": "Start Here is where new users begin.",
      "Home.md": "---\naliases: [Start Here]\n---\n",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const home = fake.getFileByPath("Home.md")!;
    const mentions = cache.getUnlinkedMentions(home);
    expect(mentions.map((m) => m.source.path)).toEqual(["Welcome.md"]);
  });

  it("returns an empty array when every mention is already linked", async () => {
    const fake = new FakeVault({
      "Welcome.md": "See [[Daily Plan]].",
      "Daily Plan.md": "",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const dailyPlan = fake.getFileByPath("Daily Plan.md")!;
    expect(cache.getUnlinkedMentions(dailyPlan)).toEqual([]);
  });
});

describe("processInBatches", () => {
  const noopYield = () => Promise.resolve();

  it("never runs more than `concurrency` callbacks concurrently, and every item is still processed exactly once", async () => {
    const items = Array.from({ length: 23 }, (_, i) => i);
    const concurrency = 4;
    let inFlight = 0;
    let maxInFlight = 0;
    const processed: number[] = [];

    await processInBatches(
      items,
      concurrency,
      async (item) => {
        inFlight++;
        maxInFlight = Math.max(maxInFlight, inFlight);
        await Promise.resolve();
        processed.push(item);
        inFlight--;
      },
      noopYield
    );

    expect(maxInFlight).toBeLessThanOrEqual(concurrency);
    expect(processed.slice().sort((a, b) => a - b)).toEqual(items);
    expect(processed).toHaveLength(items.length);
  });

  it("yields exactly once between each batch, and not after the final batch", async () => {
    const items = Array.from({ length: 10 }, (_, i) => i);
    let yieldCount = 0;
    const countingYield = () => {
      yieldCount++;
      return Promise.resolve();
    };

    await processInBatches(items, 3, async () => {}, countingYield);

    // 10 items / batch size 3 -> batches of [3,3,3,1] -> 3 boundaries -> 3 yields.
    expect(yieldCount).toBe(3);
  });

  it("does not yield at all when everything fits in a single batch", async () => {
    const items = [1, 2, 3];
    let yieldCount = 0;
    const countingYield = () => {
      yieldCount++;
      return Promise.resolve();
    };

    await processInBatches(items, 5, async () => {}, countingYield);

    expect(yieldCount).toBe(0);
  });
});

describe("MetadataCache.initialize batching", () => {
  it("indexes correctly across multiple concurrency batches (real yieldToEventLoop)", async () => {
    const fileCount = INDEX_CONCURRENCY * 3 + 5; // spans several batches
    const files: Record<string, string> = {};
    for (let i = 0; i < fileCount; i++) files[`Note${i}.md`] = `Note number ${i}.`;
    // A cross-file wikilink so we can confirm resolution/name-index rebuild
    // happened only after every batch finished.
    files["Linker.md"] = "See [[Note0]] for details.";

    const fake = new FakeVault(files);
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    expect(cache.initialized).toBe(true);

    const note0 = fake.getFileByPath("Note0.md")!;
    expect(cache.getFirstLinkpathDest("Note0", "Linker.md")?.path).toBe("Note0.md");

    const resolved = cache.resolvedLinks["Linker.md"];
    expect(resolved?.["Note0.md"]).toBe(1);

    const backlinks = cache.getBacklinks(note0);
    expect(backlinks.map((bl) => bl.source.path)).toEqual(["Linker.md"]);
  });

  it("isolates a genuine read failure on a file in a later batch: logs once, doesn't abort the rest, and initialized still ends up true", async () => {
    const fileCount = INDEX_CONCURRENCY * 2 + 3;
    const files: Record<string, string> = {};
    for (let i = 0; i < fileCount; i++) files[`Note${i}.md`] = `Note number ${i}.`;

    const fake = new FakeVault(files);
    // Pick a file whose index lands at/after INDEX_CONCURRENCY (a later batch).
    const failingIndex = INDEX_CONCURRENCY + 1;
    const failingPath = `Note${failingIndex}.md`;
    const realCachedRead = fake.cachedRead.bind(fake);
    (fake as any).cachedRead = async (file: { path: string }) => {
      if (file.path === failingPath) throw new Error("disk exploded");
      return realCachedRead(file as any);
    };

    const cache = new MetadataCache(fake.asVault());
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await cache.initialize();

    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorSpy.mock.calls[0][0]).toContain(`Failed to index ${failingPath}`);
    expect(cache.initialized).toBe(true);

    // Every other file was still indexed despite the one failure.
    const okFile = fake.getFileByPath("Note0.md")!;
    expect(cache.getFirstLinkpathDest("Note0", "Note1.md")?.path).toBe("Note0.md");
    expect(fake.getFileByPath(failingPath)).not.toBeNull();

    errorSpy.mockRestore();
  });
});
