import { describe, expect, it } from "vitest";
import { MetadataCache, parseMetadata } from "../../src/renderer/metadata-cache";
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

  it("treats malformed frontmatter YAML as body text", () => {
    const meta = parseMetadata(`---\n: not valid: yaml: at all\n---\nBody\n`);
    expect(meta.frontmatter).toBeNull();
  });

  it("has no frontmatter when the document doesn't start with a --- block", () => {
    const meta = parseMetadata(`# Just a note\n\nNo frontmatter here.\n`);
    expect(meta.frontmatter).toBeNull();
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

    expect(cache.unresolvedLinks.get(welcome.path)?.get("Ghost Note")).toBe(1);
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
});
