import { describe, expect, it } from "vitest";
import { parseMetadata } from "../../src/renderer/metadata-cache";

/**
 * Audit against obsidian-api 9abd9605ce081383674aae1ed111c456edde0688.
 * Regressions assert the formerly missing public metadata contracts.
 */
describe("CachedMetadata parity audit", () => {
  it("returns positioned footnote references without counting definitions or code", () => {
    const text = "Claim [^one]. `[^code]`\n\n[^one]: Source.\n";
    const refs = parseMetadata(text).footnoteRefs!;
    expect(refs).toHaveLength(1);
    expect(refs[0].id).toBe("one");
    expect(text.slice(refs[0].position.start.offset, refs[0].position.end.offset)).toBe("[^one]");
    expect(parseMetadata("No references.").footnoteRefs).toBeUndefined();
  });

  it("groups root list items using the negative first-item line", () => {
    const items = parseMetadata("\n\n- a\n- b\n").listItems!;
    expect(items.map(item => item.parent)).toEqual([-2, -2]);
  });

  it("returns reference definition destinations rather than displayed labels", () => {
    const text = "[label][target]\n\n[target]: https://example.com\n";
    expect(parseMetadata(text).referenceLinks).toEqual([
      expect.objectContaining({ id: "target", link: "https://example.com" }),
    ]);
  });

  it("includes Markdown links in addition to wikilinks", () => {
    expect(parseMetadata("[[Wiki]] [label](Note.md)").links.map(({ link }) => link)).toEqual(["Wiki", "Note.md"]);
  });

  it("includes Markdown image embeds in addition to wiki embeds", () => {
    expect(parseMetadata("![[one.png]] ![label](two.png)").embeds.map(({ link }) => link)).toEqual(["one.png", "two.png"]);
  });

  it("exposes block IDs in the blocks record", () => {
    expect(parseMetadata("Paragraph ^block-id\n")).toHaveProperty("blocks.block-id.id", "block-id");
  });

  it("exposes footnote definitions in footnotes", () => {
    expect(parseMetadata("Claim [^one]\n\n[^one]: Source.\n")).toHaveProperty("footnotes.0.id", "one");
  });

  it("exposes links in frontmatter with their property key", () => {
    expect(parseMetadata('---\nrelated: "[[Note]]"\n---\n')).toHaveProperty("frontmatterLinks.0.key", "related");
  });

  it("exposes the frontmatter position span", () => {
    expect(parseMetadata("---\ntitle: Test\n---\n")).toHaveProperty("frontmatterPosition.start.offset", 0);
  });

  it("recognizes the documented shortcut reference-link example", () => {
    expect(parseMetadata("[google]\n\n[google]: https://google.com\n")).toHaveProperty("referenceLinks.0.id", "google");
  });
});
