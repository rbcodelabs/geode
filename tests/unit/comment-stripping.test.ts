import { describe, expect, it } from "vitest";
import { createCommentMarkers } from "../../src/renderer/comments/model";
import { parseMetadata } from "../../src/renderer/metadata-cache";
import { matchFileAgainstTerms, parseQuery } from "../../src/renderer/views/search-view";
import type { TFile } from "../../src/renderer/types";

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
