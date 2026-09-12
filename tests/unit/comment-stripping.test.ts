import { describe, expect, it } from "vitest";
import { createCommentMarkers } from "../../src/renderer/comments/model";
import { extractSection } from "../../src/renderer/markdown/embed";
import {
  MetadataCache,
  UNLINKED_MENTIONS_SCAN,
  findUnlinkedMentions,
  parseMetadata,
} from "../../src/renderer/metadata-cache";
import { hasMarkdownHeading, safePreviewMarkdownSource } from "../../src/renderer/page-preview";
import { matchFileAgainstTerms, parseQuery } from "../../src/renderer/views/search-view";
import type { TFile } from "../../src/renderer/types";
import { FakeVault } from "../helpers/fake-vault";

describe("comment metadata consumers", () => {
  it("does not index links, tags, or headings from comment payloads", () => {
    const markers = createCommentMarkers("thread-1", { messages: [{
      id: "m1", author: { type: "user", name: "Rick" },
      body: "#hidden [[Secret]]", createdAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z",
    }] });
    const source = `${markers.open}Visible${markers.close}\n# Real\n[[Target]] #public`;
    const metadata = parseMetadata(source);
    expect(metadata.headings.map((heading) => heading.heading)).toEqual(["Real"]);
    expect(metadata.links.map((link) => link.link)).toEqual(["Target"]);
    expect(metadata.tags.map((tag) => tag.tag)).toEqual(["public"]);
  });

  it("keeps metadata positions addressed to the original raw Markdown", () => {
    const first = createCommentMarkers("thread-1", { messages: [] });
    const second = createCommentMarkers("thread-2", { messages: [] });
    const source = `${first.open}Visible${first.close}\nPlain ${second.open}anchor${second.close}\n# Exact heading\n[[Target]] #public`;

    const metadata = parseMetadata(source);
    const heading = metadata.headings[0];
    const link = metadata.links[0];
    const tag = metadata.tags[0];

    expect(source.slice(heading.position.start.offset, heading.position.end.offset)).toBe("# Exact heading");
    expect(source.slice(link.position.start.offset, link.position.end.offset)).toBe("[[Target]]");
    expect(source.slice(tag.position.start.offset, tag.position.end.offset)).toBe("#public");
  });

  it("does not return search hits or snippets from comment payloads", () => {
    const markers = createCommentMarkers("thread-1", { messages: [{
      id: "m1", author: { type: "user", name: "Rick" }, body: "secret needle",
      createdAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z",
    }] });
    const file = { path: "Note.md", name: "Note.md" } as TFile;
    expect(matchFileAgainstTerms(file, `${markers.open}Visible${markers.close}`, parseQuery("needle"), () => [])).toBeNull();
    expect(matchFileAgainstTerms(file, `${markers.open}Visible${markers.close}`, parseQuery("visible"), () => [])?.snippets[0].text).toBe("Visible");
  });

  it("maps search matches after and across multiple marker pairs to exact raw offsets", () => {
    const first = createCommentMarkers("thread-1", { messages: [] });
    const second = createCommentMarkers("thread-2", { messages: [] });
    const file = { path: "Note.md", name: "Note.md" } as TFile;
    const source = `Start ${first.open}commented${first.close} middle ${second.open}an${second.close}chor needle end`;

    const after = matchFileAgainstTerms(file, source, parseQuery("needle"), () => [])!;
    expect(after.snippets[0].offset).toBe(source.indexOf("needle"));
    expect(source.slice(after.snippets[0].offset, after.snippets[0].offset + "needle".length)).toBe("needle");

    const across = matchFileAgainstTerms(file, source, parseQuery("anchor"), () => [])!;
    expect(across.snippets[0].offset).toBe(source.indexOf("an"));
    expect(across.snippets[0].text).toContain("anchor needle");
  });

  it.each(["hello", "https://example.com", "[[Target]]", "#tag", "[label][ref]", "Heading\n===", "one two"])(
    "keeps anchored prose contiguous for consumers: %s",
    (prose) => {
      const split = Math.max(1, Math.floor(prose.length / 2));
      const markers = createCommentMarkers(`thread-${split}`, { messages: [] });
      const source = prose.slice(0, split) + markers.open + prose.slice(split) + markers.close;
      const query = prose.replace(/[^A-Za-z]+/g, " ").trim().split(/\s+/)[0]?.toLowerCase();
      if (query) expect(matchFileAgainstTerms({ path: "N.md", name: "N.md" } as TFile, source, parseQuery(query), () => [])).not.toBeNull();
    }
  );
});

/**
 * Comments may now anchor inside headings, list items, and table cells — not
 * just plain paragraphs. Every consumer that reads *text* out of one of those
 * structures has to see the prose the author typed, never the marker bytes and
 * never the space-run `maskCommentMetadata` leaves behind.
 */
describe("structural comment anchors", () => {
  const wrap = (id: string, text: string): string => {
    const markers = createCommentMarkers(id, { messages: [] });
    return `${markers.open}${text}${markers.close}`;
  };

  describe("metadata cache heading text", () => {
    it("reads a commented heading as the prose the author typed", () => {
      const source = `# Alpha ${wrap("t1", "beta")} gamma`;
      const metadata = parseMetadata(source);
      expect(metadata.headings[0].heading).toBe("Alpha beta gamma");
    });

    it("keeps the commented heading's position addressed to the raw source", () => {
      const source = `Intro\n\n# Alpha ${wrap("t1", "beta")} gamma\n\nBody`;
      const heading = parseMetadata(source).headings[0];
      expect(source.slice(heading.position.start.offset, heading.position.end.offset)).toBe(
        source.split("\n")[2]
      );
      expect(heading.level).toBe(1);
    });

    it("handles a marker at the head and the tail of the heading text", () => {
      expect(parseMetadata(`## ${wrap("t1", "Alpha")} beta`).headings[0].heading).toBe("Alpha beta");
      expect(parseMetadata(`## Alpha ${wrap("t2", "beta")}`).headings[0].heading).toBe("Alpha beta");
    });

    it("still records a heading whose entire text is a detached comment", () => {
      const markers = createCommentMarkers("t1", { messages: [] });
      const metadata = parseMetadata(`# Alpha${markers.open}${markers.close}`);
      expect(metadata.headings).toHaveLength(1);
      expect(metadata.headings[0].heading).toBe("Alpha");
    });

    it("leaves list item and section positions addressed to the raw source", () => {
      const source = `- one ${wrap("t1", "two")} three\n- plain`;
      const metadata = parseMetadata(source);
      expect(metadata.listItems).toHaveLength(2);
      expect(source.slice(
        metadata.listItems![0].position.start.offset,
        metadata.listItems![0].position.end.offset
      )).toBe(source.split("\n")[0]);
    });
  });

  describe("transclusion and hover preview heading matching", () => {
    const note = [
      "Intro line.",
      "",
      `## Alpha ${wrap("t1", "beta")} gamma`,
      "Section body.",
      "",
      "## Later",
      "Other body.",
    ].join("\n");

    it("extracts only the commented heading's own section", () => {
      const section = extractSection(note, "Alpha beta gamma");
      expect(section).toBe(`${note.split("\n")[2]}\nSection body.\n`);
      expect(section).not.toContain("Other body.");
    });

    it("still matches an uncommented heading after a commented one", () => {
      expect(extractSection(note, "Later")).toBe("## Later\nOther body.");
    });

    it("reports the commented heading as present for hover previews", () => {
      expect(hasMarkdownHeading(note, "Alpha beta gamma")).toBe(true);
      expect(hasMarkdownHeading(note, "Nonexistent")).toBe(false);
    });
  });

  describe("hover preview source", () => {
    it("carries no marker bytes into the rendered preview", () => {
      const source = `# Alpha ${wrap("t1", "beta")} gamma\n\nBody ${wrap("t2", "anchor")} tail.`;
      const preview = safePreviewMarkdownSource(source);
      expect(preview).not.toContain("geode-comment");
      expect(preview).not.toContain("&lt;!--");
      expect(preview).toBe("# Alpha beta gamma\n\nBody anchor tail.");
    });

    it("leaves a marker typed inside inline code alone", () => {
      const markers = createCommentMarkers("t1", { messages: [] });
      expect(safePreviewMarkdownSource(`\`${markers.open}\``)).toBe(`\`${markers.open}\``);
    });
  });

  describe("unlinked mentions", () => {
    it("matches a note name split by a marker and reports clean snippets", () => {
      const markers = createCommentMarkers("t1", { messages: [] });
      const source = `See Daily ${markers.open}Plan${markers.close} tomorrow.`;
      const mentions = findUnlinkedMentions(source, ["Daily Plan"]);
      expect(mentions).toEqual([{ line: 0, snippet: "See Daily Plan tomorrow.", count: 1 }]);
    });

    it("keeps line numbers addressed to the raw source", () => {
      const source = `one\ntwo\nSee ${wrap("t1", "Daily Plan")} here.`;
      expect(findUnlinkedMentions(source, ["Daily Plan"])[0].line).toBe(2);
    });

    it("agrees with the chunked production scan across frontmatter and markers", async () => {
      const markers = createCommentMarkers("t1", { messages: [] });
      // Frontmatter must stay excluded even though removing body markers
      // shortens every offset after them, and the scan is fed the cached
      // frontmatter end offset measured against the *raw* source.
      const source = [
        "---",
        "title: Daily Plan mention that must not count",
        "---",
        "",
        `See Daily ${markers.open}Plan${markers.close} tomorrow.`,
        "Daily Plan again.",
      ].join("\n");
      const fake = new FakeVault({ "Source.md": source, "Daily Plan.md": "" });
      const cache = new MetadataCache(fake.asVault());
      await cache.initialize();

      const result = await cache[UNLINKED_MENTIONS_SCAN](fake.getFileByPath("Daily Plan.md")!, {
        chunkSize: 16,
        yieldToEventLoop: async () => {},
      });

      // Asserted literally rather than against `findUnlinkedMentions`: only the
      // chunked scan is frontmatter-aware, so the two legitimately disagree on
      // the `title:` line.
      expect(result[0].mentions).toEqual([
        { line: 4, snippet: "See Daily Plan tomorrow.", count: 1 },
        { line: 5, snippet: "Daily Plan again.", count: 1 },
      ]);
    });
  });
});
