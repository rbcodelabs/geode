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

  it("does not return search hits or snippets from comment payloads", () => {
    const markers = createCommentMarkers("thread-1", { messages: [{
      id: "m1", author: { type: "user", name: "Rick" }, body: "secret needle",
      createdAt: "2026-09-04T00:00:00Z", updatedAt: "2026-09-04T00:00:00Z",
    }] });
    const file = { path: "Note.md", name: "Note.md" } as TFile;
    expect(matchFileAgainstTerms(file, `${markers.open}Visible${markers.close}`, parseQuery("needle"), () => [])).toBeNull();
    expect(matchFileAgainstTerms(file, `${markers.open}Visible${markers.close}`, parseQuery("visible"), () => [])?.snippets[0].text).toBe("Visible");
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
