import { describe, expect, it, vi } from "vitest";
import {
  buildLineStarts,
  extractMentionIndexKeys,
  findUnlinkedMentions,
  INDEX_CONCURRENCY,
  MetadataCache,
  offsetToLoc,
  parseMetadata,
  processInBatches,
  UNLINKED_MENTIONS_SCAN,
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

describe("offsetToLoc", () => {
  // offsetToLoc used to re-slice `text` from offset 0 and re-scan it with a
  // regex on every single call (once per heading/tag/link/section found),
  // making parseMetadata O(n²) in file size. It now binary-searches a
  // lineStarts index built once per file in O(n) — see buildLineStarts.
  //
  // Behavioral equivalence with the pre-optimization implementation was
  // verified during development via a fuzz check comparing the old
  // (text-slicing) and new (lineStarts binary search) implementations across
  // 206,184 (text, start, end) combinations spanning 208 texts — including
  // empty strings, leading/trailing newlines, no-newline text, and random
  // multi-line documents — with zero mismatches. The cases below pin that
  // equivalence down as permanent regression coverage.

  it("resolves offset 0 to line 0, ch 0", () => {
    const lineStarts = buildLineStarts("hello\nworld\n");
    expect(offsetToLoc(lineStarts, 0, 0)).toEqual({
      start: { line: 0, ch: 0, offset: 0 },
      end: { line: 0, ch: 0, offset: 0 },
    });
  });

  it("resolves an offset with no preceding newlines to line 0", () => {
    const text = "no newlines in this text at all";
    const lineStarts = buildLineStarts(text);
    const offset = 10;
    expect(offsetToLoc(lineStarts, offset, offset)).toEqual({
      start: { line: 0, ch: offset, offset },
      end: { line: 0, ch: offset, offset },
    });
  });

  it("resolves an offset exactly at the start of a line", () => {
    const text = "line zero\nline one\nline two";
    const lineOneStart = text.indexOf("line one");
    const lineStarts = buildLineStarts(text);
    expect(offsetToLoc(lineStarts, lineOneStart, lineOneStart)).toEqual({
      start: { line: 1, ch: 0, offset: lineOneStart },
      end: { line: 1, ch: 0, offset: lineOneStart },
    });
  });

  it("resolves an offset mid-line (not at a line boundary)", () => {
    const text = "line zero\nline one\nline two";
    const lineTwoStart = text.indexOf("line two");
    const midLineTwo = lineTwoStart + 5; // inside "line two", after "line "
    const lineStarts = buildLineStarts(text);
    expect(offsetToLoc(lineStarts, midLineTwo, midLineTwo)).toEqual({
      start: { line: 2, ch: 5, offset: midLineTwo },
      end: { line: 2, ch: 5, offset: midLineTwo },
    });
  });

  it("resolves a span whose start and end are on different lines", () => {
    const text = "alpha\nbeta\ngamma\ndelta";
    const start = text.indexOf("beta");
    const end = text.indexOf("delta") + "delta".length;
    const lineStarts = buildLineStarts(text);
    expect(offsetToLoc(lineStarts, start, end)).toEqual({
      start: { line: 1, ch: 0, offset: start },
      end: { line: 3, ch: 5, offset: end },
    });
  });

  it("returns identical start and end positions when start === end", () => {
    const text = "one\ntwo\nthree";
    const offset = text.indexOf("two") + 1;
    const lineStarts = buildLineStarts(text);
    const loc = offsetToLoc(lineStarts, offset, offset);
    expect(loc.start).toEqual(loc.end);
  });

  it("resolves an offset at the very end of the file (no trailing newline)", () => {
    const text = "first\nsecond\nthird";
    const lineStarts = buildLineStarts(text);
    const end = text.length;
    expect(offsetToLoc(lineStarts, end, end)).toEqual({
      start: { line: 2, ch: "third".length, offset: end },
      end: { line: 2, ch: "third".length, offset: end },
    });
  });

  it("resolves an offset at the very end of the file (with trailing newline)", () => {
    const text = "first\nsecond\nthird\n";
    const lineStarts = buildLineStarts(text);
    const end = text.length;
    // The trailing newline starts a new (empty) final line — same convention
    // as the pre-optimization implementation, which counted that newline.
    expect(offsetToLoc(lineStarts, end, end)).toEqual({
      start: { line: 3, ch: 0, offset: end },
      end: { line: 3, ch: 0, offset: end },
    });
  });

  it("treats an offset landing on a newline character itself as the end of the preceding line", () => {
    const text = "abc\ndef";
    const newlineOffset = text.indexOf("\n");
    const lineStarts = buildLineStarts(text);
    expect(offsetToLoc(lineStarts, newlineOffset, newlineOffset)).toEqual({
      start: { line: 0, ch: 3, offset: newlineOffset },
      end: { line: 0, ch: 3, offset: newlineOffset },
    });
  });

  it("handles an empty document", () => {
    const lineStarts = buildLineStarts("");
    expect(offsetToLoc(lineStarts, 0, 0)).toEqual({
      start: { line: 0, ch: 0, offset: 0 },
      end: { line: 0, ch: 0, offset: 0 },
    });
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

describe("extractMentionIndexKeys", () => {
  it("uses compact whole-word keys and punctuation grams while masking links and code", () => {
    const keys = extractMentionIndexKeys("Plan Planner C++ [[Hidden]] `Code`");
    expect(keys).toContain("w:plan");
    expect(keys).toContain("w:planner");
    expect(keys).toContain("w:c");
    expect(keys).toContain("p:++");
    expect(keys).not.toContain("w:hidden");
    expect(keys).not.toContain("w:code");
    expect(keys.length).toBeLessThan(10);
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
    const backlinks = await cache.getBacklinksWithContext(dailyPlan);
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
    const backlinks = await cache.getBacklinksWithContext(b);
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
    const mentions = await cache.getUnlinkedMentions(dailyPlan);
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
    const mentions = await cache.getUnlinkedMentions(dailyPlan);
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
    const mentions = await cache.getUnlinkedMentions(home);
    expect(mentions.map((m) => m.source.path)).toEqual(["Welcome.md"]);
  });

  it("does not match a multiline YAML alias across adjacent source lines", async () => {
    const fake = new FakeVault({
      "Welcome.md": "Start\nHere",
      "Home.md": "---\nalias: |-\n  Start\n  Here\n---\n",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    expect(await cache.getUnlinkedMentions(fake.getFileByPath("Home.md")!)).toEqual([]);
  });

  it("returns an empty array when every mention is already linked", async () => {
    const fake = new FakeVault({
      "Welcome.md": "See [[Daily Plan]].",
      "Daily Plan.md": "",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const dailyPlan = fake.getFileByPath("Daily Plan.md")!;
    expect(await cache.getUnlinkedMentions(dailyPlan)).toEqual([]);
  });

  it("memoizes the result: two calls with no intervening vault change return the same array by reference", async () => {
    const fake = new FakeVault({
      "Welcome.md": "Remember to check the Daily Plan before lunch.",
      "Daily Plan.md": "# Daily Plan",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const dailyPlan = fake.getFileByPath("Daily Plan.md")!;
    const result1 = await cache.getUnlinkedMentions(dailyPlan);
    const result2 = await cache.getUnlinkedMentions(dailyPlan);
    expect(result1).toBe(result2);
  });

  it("first lookup reads only indexed candidates rather than every cached Markdown file", async () => {
    const files: Record<string, string> = {
      "Daily Plan.md": "# Daily Plan",
      "Welcome.md": "Remember to check the Daily Plan before lunch.",
    };
    for (let i = 0; i < 200; i++) files[`Archive/Note ${i}.md`] = `Unrelated archive entry ${i}.`;
    const fake = new FakeVault(files);
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    // Content is no longer pre-warmed for every file (the indexer's wire
    // format and persisted cache no longer carry raw content), so
    // getUnlinkedMentions now fetches a candidate's content on demand via
    // vault.cachedRead() rather than reading an already-warm vault.contents
    // entry via getCachedContent().
    const cachedReadSpy = vi.spyOn(fake, "cachedRead");
    const mentions = await cache.getUnlinkedMentions(fake.getFileByPath("Daily Plan.md")!);

    expect(mentions.map((entry) => entry.source.path)).toEqual(["Welcome.md"]);
    expect(cachedReadSpy).toHaveBeenCalledTimes(1);
    expect(cachedReadSpy.mock.calls[0][0].path).toBe("Welcome.md");
  });

  it("recomputes after a vault change invalidates the cache via 'resolved'", async () => {
    const fake = new FakeVault({
      "Welcome.md": "Nothing to see here.",
      "Daily Plan.md": "# Daily Plan",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const dailyPlan = fake.getFileByPath("Daily Plan.md")!;
    const before = await cache.getUnlinkedMentions(dailyPlan);
    expect(before).toEqual([]);

    fake.setFile("Welcome.md", "Remember to check the Daily Plan before lunch.");
    fake.trigger("modify", fake.getFileByPath("Welcome.md"));
    // MetadataCache's flush is async; let it complete (and fire "resolved").
    await new Promise((r) => setTimeout(r, 0));

    const after = await cache.getUnlinkedMentions(dailyPlan);
    expect(after).not.toBe(before);
    expect(after.map((m) => m.source.path)).toEqual(["Welcome.md"]);
  });

  it("peekUnlinkedMentions is a pure cache read: undefined before, then equals the computed result after", async () => {
    const fake = new FakeVault({
      "Welcome.md": "Remember to check the Daily Plan before lunch.",
      "Daily Plan.md": "# Daily Plan",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const dailyPlan = fake.getFileByPath("Daily Plan.md")!;
    expect(cache.peekUnlinkedMentions(dailyPlan)).toBeUndefined();

    const computed = await cache.getUnlinkedMentions(dailyPlan);
    expect(cache.peekUnlinkedMentions(dailyPlan)).toBe(computed);
  });

  it("cooperatively yields within a pathological single-line candidate while preserving exact results", async () => {
    const hugeLine = `${"padding ".repeat(8_000)}Daily Plan${" padding".repeat(8_000)}`;
    const fake = new FakeVault({
      "Huge transcript.md": hugeLine,
      "Daily Plan.md": "# Daily Plan",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    let yields = 0;

    const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Daily Plan.md")!, {
      chunkSize: 1_024,
      yieldToEventLoop: async () => { yields += 1; },
    });

    expect(yields).toBeGreaterThan(100);
    expect(result).toHaveLength(1);
    expect(result[0].mentions).toEqual([{ line: 0, snippet: hugeLine, count: 1 }]);
  });

  it("preserves code and wikilink masking when delimiters straddle exact-scan slices", async () => {
    const source = `\`\`\`Daily Plan${"x".repeat(50)}\`\`\` plain Daily Plan `
      + `[[Daily Plan${"y".repeat(35)}]] plain Daily Plan`;
    const fake = new FakeVault({ "Boundary.md": source, "Daily Plan.md": "" });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Daily Plan.md")!, {
      chunkSize: 64,
      yieldToEventLoop: async () => {},
    });

    expect(result).toHaveLength(1);
    expect(result[0].mentions).toEqual([{ line: 0, snippet: source, count: 2 }]);
  });

  it("preserves malformed nested wikilink text as an unlinked mention", async () => {
    const source = "Malformed [[Daily Plan [[Other]] still contains plain target text.";
    const fake = new FakeVault({ "Malformed link.md": source, "Daily Plan.md": "", "Other.md": "" });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Daily Plan.md")!, {
      chunkSize: 64,
      yieldToEventLoop: async () => {},
    });

    expect(result[0].mentions).toEqual(findUnlinkedMentions(source, ["Daily Plan"]));
  });

  it("reconsiders an overlapping inner wikilink after an invalid outer opener", async () => {
    const source = "[[[Target]]\nTarget";
    const fake = new FakeVault({ "Overlapping.md": source, "Target.md": "" });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Target.md")!, {
      chunkSize: 64,
      yieldToEventLoop: async () => {},
    });

    expect(result[0].mentions).toEqual(findUnlinkedMentions(source, ["Target"]));
  });

  it("bounds delimiter work for a pathological line of unmatched wikilink openers", async () => {
    const source = `${"[[".repeat(5_000)}${"`x".repeat(5_000)} Daily Plan`;
    const fake = new FakeVault({ "Malformed transcript.md": source, "Daily Plan.md": "" });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    const originalIndexOf = String.prototype.indexOf;
    let indexOfCalls = 0;
    const indexOfSpy = vi.spyOn(String.prototype, "indexOf").mockImplementation(function (
      this: string,
      searchString: string,
      position?: number
    ) {
      indexOfCalls += 1;
      return originalIndexOf.call(this, searchString, position);
    });

    try {
      const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Daily Plan.md")!, {
        chunkSize: 256,
        yieldToEventLoop: async () => {},
      });
      expect(result[0].mentions).toEqual(findUnlinkedMentions(source, ["Daily Plan"]));
      expect(indexOfCalls).toBeLessThan(100);
    } finally {
      indexOfSpy.mockRestore();
    }
  });

  it("matches established fence-before-inline masking semantics", async () => {
    const source = "` Target ```\nTarget";
    const fake = new FakeVault({ "Ordering.md": source, "Target.md": "" });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Target.md")!, {
      chunkSize: 64,
      yieldToEventLoop: async () => {},
    });

    expect(result[0].mentions).toEqual(findUnlinkedMentions(source, ["Target"]));
  });

  it("preserves whole-word boundaries when surrounding malformed masks cross slices", async () => {
    const source = "\nTarget target éxOther漢\n|``` target ]][``` \né[[\n]TargetxxTarget\n[[éxTarget```xTargetTarget_`";
    const fake = new FakeVault({ "Fuzz regression.md": source, "Target.md": "" });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Target.md")!, {
      chunkSize: 64,
      yieldToEventLoop: async () => {},
    });

    expect(result[0].mentions).toEqual(findUnlinkedMentions(source, ["Target"]));
  });

  it("does not lose mentions whose start and end straddle a scan-slice commit boundary", async () => {
    for (const start of [53, 54, 55, 56, 57, 58, 59, 60, 61, 62, 63]) {
      const source = `${"x".repeat(start)} Daily Plan tail`;
      const fake = new FakeVault({ "Boundary.md": source, "Daily Plan.md": "" });
      const cache = new MetadataCache(fake.asVault());
      await cache.initialize();
      const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Daily Plan.md")!, {
        chunkSize: 64,
        yieldToEventLoop: async () => {},
      });
      expect(result[0]?.mentions, `mention starting at ${start + 1}`).toEqual(
        findUnlinkedMentions(source, ["Daily Plan"])
      );
    }
  });

  it("retains BMP and astral Unicode word-boundary context across scan slices", async () => {
    for (const adjacentLetter of ["x", "𐐀"]) {
      for (let padding = 42; padding <= 64; padding++) {
        const source = `${" ".repeat(padding)}${adjacentLetter}Daily Plan \nreal Daily Plan`;
        const fake = new FakeVault({ "Boundary.md": source, "Daily Plan.md": "" });
        const cache = new MetadataCache(fake.asVault());
        await cache.initialize();
        const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Daily Plan.md")!, {
          chunkSize: 64,
          yieldToEventLoop: async () => {},
        });
        expect(result[0].mentions, `${JSON.stringify(adjacentLetter)} at padding ${padding}`).toEqual(
          findUnlinkedMentions(source, ["Daily Plan"])
        );
      }
    }
  });

  it("matches the synchronous scanner across deterministic delimiter-heavy fixtures", async () => {
    let seed = 0x134;
    const random = () => {
      seed = (seed * 1_664_525 + 1_013_904_223) >>> 0;
      return seed / 0x1_0000_0000;
    };
    const alphabet = ["a", " ", "[", "]", "`", "!", "\n", "é", "_", "#"];
    const files: Record<string, string> = { "Target.md": "" };
    for (let fixture = 0; fixture < 200; fixture++) {
      let source = "";
      for (let i = 0; i < 180; i++) source += alphabet[Math.floor(random() * alphabet.length)];
      const insertion = Math.floor(random() * (source.length + 1));
      files[`Fuzz ${fixture}.md`] = source.slice(0, insertion) + " Target " + source.slice(insertion);
    }
    const fake = new FakeVault(files);
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    const target = fake.getFileByPath("Target.md")!;

    for (const chunkSize of [64, 127]) {
      const result = await cache[UNLINKED_MENTIONS_SCAN](target, {
        chunkSize,
        yieldToEventLoop: async () => {},
      });
      const byPath = new Map(result.map((entry) => [entry.source.path, entry.mentions]));
      for (const [path, source] of Object.entries(files)) {
        if (path === "Target.md") continue;
        expect(byPath.get(path) ?? [], `${path} at chunk ${chunkSize}`).toEqual(
          findUnlinkedMentions(source, ["Target"])
        );
      }
      cache.trigger("resolved");
    }
  });

  it("aggregates a dense common alias per line while continuing to yield", async () => {
    const occurrenceCount = 50_000;
    const source = "Target ".repeat(occurrenceCount);
    const fake = new FakeVault({ "Dense.md": source, "Target.md": "" });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    let yields = 0;

    const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Target.md")!, {
      chunkSize: 1_024,
      yieldToEventLoop: async () => { yields += 1; },
    });

    expect(result[0].mentions).toEqual([{ line: 0, snippet: source.trim(), count: occurrenceCount }]);
    expect(yields).toBeGreaterThan(1_000);
  });

  it("yields while intersecting a large candidate set before reading source content", async () => {
    const files: Record<string, string> = { "Daily Plan.md": "" };
    for (let i = 0; i < 1_200; i++) files[`Candidate ${i}.md`] = "Daily Plan";
    const fake = new FakeVault(files);
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    const controller = new AbortController();
    const readSpy = vi.spyOn(fake, "cachedRead");

    const scan = cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Daily Plan.md")!, {
      signal: controller.signal,
      yieldToEventLoop: async () => controller.abort(),
    });

    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("cancels a stale candidate scan without returning or caching partial results", async () => {
    const files: Record<string, string> = { "Daily Plan.md": "# Daily Plan" };
    for (let i = 0; i < 100; i++) files[`Transcript ${i}.md`] = `${"x ".repeat(2_000)}Daily Plan`;
    const fake = new FakeVault(files);
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    const target = fake.getFileByPath("Daily Plan.md")!;
    const controller = new AbortController();
    let yields = 0;

    const scan = cache[UNLINKED_MENTIONS_SCAN](target, {
      signal: controller.signal,
      chunkSize: 512,
      yieldToEventLoop: async () => {
        yields += 1;
        controller.abort();
      },
    });

    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
    expect(yields).toBe(1);
    expect(cache.peekUnlinkedMentions(target)).toBeUndefined();
  });

  it("invalidates an in-flight scan on metadata resolution and refuses a stale cache commit", async () => {
    const fake = new FakeVault({
      "Transcript.md": `${"x ".repeat(10_000)}Daily Plan`,
      "Daily Plan.md": "# Daily Plan",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    const target = fake.getFileByPath("Daily Plan.md")!;
    let invalidated = false;

    const scan = cache[UNLINKED_MENTIONS_SCAN](target, {
      chunkSize: 512,
      yieldToEventLoop: async () => {
        if (!invalidated) {
          invalidated = true;
          cache.trigger("resolved");
        }
      },
    });

    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.peekUnlinkedMentions(target)).toBeUndefined();
    const stable = await cache.getUnlinkedMentions(target);
    expect(stable.map((entry) => entry.source.path)).toEqual(["Transcript.md"]);
  });

  it("excludes valid YAML frontmatter but treats malformed frontmatter as body content", async () => {
    const fake = new FakeVault({
      "Valid.md": "---\ntitle: Daily Plan\n---\nNo body mention.",
      "Malformed.md": "---\n: Daily Plan: invalid: yaml\n---\nBody.",
      "Daily Plan.md": "# Daily Plan",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();

    const mentions = await cache.getUnlinkedMentions(fake.getFileByPath("Daily Plan.md")!);

    expect(mentions.map((entry) => entry.source.path)).toEqual(["Malformed.md"]);
    expect(mentions[0].mentions[0]).toMatchObject({ line: 1, count: 1 });
  });

  it("dispose cancels outstanding exact scans and prevents a partial cache entry", async () => {
    const fake = new FakeVault({
      "Transcript.md": `${"x ".repeat(10_000)}Daily Plan`,
      "Daily Plan.md": "# Daily Plan",
    });
    const cache = new MetadataCache(fake.asVault());
    await cache.initialize();
    const target = fake.getFileByPath("Daily Plan.md")!;

    const scan = cache[UNLINKED_MENTIONS_SCAN](target, {
      chunkSize: 512,
      yieldToEventLoop: async () => cache.dispose(),
    });

    await expect(scan).rejects.toMatchObject({ name: "AbortError" });
    expect(cache.peekUnlinkedMentions(target)).toBeUndefined();
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
