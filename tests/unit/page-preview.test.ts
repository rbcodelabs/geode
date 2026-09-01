import { describe, expect, it } from "vitest";
import {
  isExternalPreviewTarget,
  hasMarkdownHeading,
  previewMarkdownExcerpt,
  safePreviewMarkdownSource,
  splitPreviewTarget,
} from "../../src/renderer/page-preview";

describe("page preview target rules", () => {
  it("keeps authored heading subpaths separate from the resolvable link path", () => {
    expect(splitPreviewTarget("Folder/Note.md#Details")).toEqual({
      linkpath: "Folder/Note.md#Details",
      subpath: "#Details",
    });
    expect(splitPreviewTarget("Alias")).toEqual({ linkpath: "Alias", subpath: "" });
  });

  it("rejects external, protocol-relative, and empty targets", () => {
    for (const target of ["https://example.com", "mailto:test@example.com", "//example.com/a", ""]) {
      expect(isExternalPreviewTarget(target), target).toBe(true);
    }
    expect(isExternalPreviewTarget("Sibling.md#Details")).toBe(false);
    expect(isExternalPreviewTarget("#local")).toBe(false);
  });
});

describe("safePreviewMarkdownSource", () => {
  it("omits embeds/comments, renders wikilink aliases, and leaves code literal", () => {
    const source = "---\ntitle: Hidden\n---\n%%secret%% [[Target|Alias]] ![[Embed]] `[[Code]] ![[CodeEmbed]]`";
    expect(safePreviewMarkdownSource(source)).toBe(" Alias  `[[Code]] ![[CodeEmbed]]`");
  });
});

describe("previewMarkdownExcerpt", () => {
  const markdown = [
    "# Note",
    "Intro.",
    "## Details",
    "**Rendered detail**",
    "### Child",
    "Child detail.",
    "## Later",
    "Not in the section.",
  ].join("\n");

  it("extracts the authored heading through its child headings", () => {
    expect(previewMarkdownExcerpt(markdown, "#Details", 1_000)).toBe(
      "## Details\n**Rendered detail**\n### Child\nChild detail."
    );
  });

  it("falls back to the note when a heading is missing and bounds long content", () => {
    const result = previewMarkdownExcerpt(markdown.repeat(100), "#Missing", 80);
    expect(result.length).toBeLessThanOrEqual(81);
    expect(result.endsWith("…")).toBe(true);
    expect(result).toContain("# Note");
  });

  it("distinguishes an authored heading from a missing subpath even when the section is the whole note", () => {
    expect(hasMarkdownHeading("## Details\nOnly section.", "Details")).toBe(true);
    expect(hasMarkdownHeading("## Details\nOnly section.", "Missing")).toBe(false);
  });
});
