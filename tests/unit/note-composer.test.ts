import moment from "moment";
import { describe, expect, it } from "vitest";
import {
  combineNotes,
  composerLinkTarget,
  extractionReplacement,
  placementForKey,
  renderComposerTemplate,
  resolveNoteComposerConfig,
} from "../../src/renderer/note-composer";
import { rewriteWikilinksForRename } from "../../src/renderer/rename";

describe("resolveNoteComposerConfig", () => {
  it("defaults to enabled, ask-before-merging, link, no template", () => {
    expect(resolveNoteComposerConfig(undefined)).toEqual({
      enabled: true,
      askBeforeMerging: true,
      textAfterExtraction: "link",
      template: "",
    });
  });
  it("keeps valid values and rejects invalid ones field by field", () => {
    expect(
      resolveNoteComposerConfig({ enabled: false, askBeforeMerging: false, textAfterExtraction: "embed", template: " T/x " })
    ).toEqual({ enabled: false, askBeforeMerging: false, textAfterExtraction: "embed", template: "T/x" });
    expect(resolveNoteComposerConfig({ textAfterExtraction: "bogus", askBeforeMerging: "no", template: 4 })).toMatchObject({
      textAfterExtraction: "link",
      askBeforeMerging: true,
      template: "",
    });
  });
});

describe("placementForKey", () => {
  it("maps Enter, Shift+Enter and Ctrl/Cmd+Enter", () => {
    expect(placementForKey({})).toBe("append");
    expect(placementForKey({ shiftKey: true })).toBe("prepend");
    expect(placementForKey({ metaKey: true })).toBe("new");
    expect(placementForKey({ ctrlKey: true, shiftKey: true })).toBe("new");
  });
});

describe("combineNotes", () => {
  it("appends after a blank line", () => {
    expect(combineNotes("dest\n", "src\n", "append")).toBe("dest\n\nsrc\n");
  });
  it("prepends before the body", () => {
    expect(combineNotes("dest\n", "src\n", "prepend")).toBe("src\n\ndest\n");
  });
  it("keeps destination frontmatter at the top when prepending", () => {
    expect(combineNotes("---\na: 1\n---\nbody\n", "src", "prepend")).toBe("---\na: 1\n---\nsrc\n\nbody\n");
  });
  it("handles empty destination and empty source", () => {
    expect(combineNotes("", "src", "append")).toBe("src\n");
    expect(combineNotes("---\na: 1\n---\n", "src", "prepend")).toBe("---\na: 1\n---\nsrc\n");
    expect(combineNotes("dest\n", "", "append")).toBe("dest\n");
  });
});

describe("renderComposerTemplate", () => {
  const now = moment("2026-03-04T05:06:07");
  const vars = { content: "BODY", fromTitle: "Src", newTitle: "New", now };
  it("expands every variable", () => {
    expect(renderComposerTemplate("# {{newTitle}} from {{fromTitle}} on {{date:YYYY-MM-DD}}\n{{content}}\n", vars)).toBe(
      "# New from Src on 2026-03-04\nBODY\n"
    );
  });
  it("appends content at the bottom when the template omits {{content}}", () => {
    expect(renderComposerTemplate("# {{newTitle}}\n", vars)).toBe("# New\n\nBODY\n");
  });
  it("does not re-expand variable-looking text inside the content", () => {
    expect(renderComposerTemplate("{{content}}", { ...vars, content: "{{newTitle}}" })).toBe("{{newTitle}}");
  });
  it("lets the template own the newline after {{content}}", () => {
    expect(renderComposerTemplate("{{content}}\nend\n", { ...vars, content: "BODY\n\n" })).toBe("BODY\nend\n");
  });
  it("leaves unknown tokens untouched", () => {
    expect(renderComposerTemplate("{{title}} {{content}}", vars)).toBe("{{title}} BODY");
  });
});

describe("extractionReplacement / composerLinkTarget", () => {
  it("builds link, embed and nothing", () => {
    expect(extractionReplacement("link", "N")).toBe("[[N]]");
    expect(extractionReplacement("embed", "N")).toBe("![[N]]");
    expect(extractionReplacement("none", "N")).toBe("");
  });
  it("uses the path when a basename is ambiguous", () => {
    const paths = ["a/Note.md", "b/note.md", "Other.md"];
    expect(composerLinkTarget({ path: "a/Note.md", basename: "Note" }, paths)).toBe("a/Note");
    expect(composerLinkTarget({ path: "Other.md", basename: "Other" }, paths)).toBe("Other");
  });
});

describe("merge link rewriting (via rename rewriting)", () => {
  it("retargets links, embeds, aliases and heading suffixes to the destination", () => {
    const text = "[[Src]] ![[Src]] [[Src|alias]] [[Src#H]] [[folder/Src]] [[Other]]";
    expect(rewriteWikilinksForRename(text, "Src", "folder/Src", "folder/Src.md", "Dest")).toBe(
      "[[Dest]] ![[Dest]] [[Dest|alias]] [[Dest#H]] [[Dest]] [[Other]]"
    );
  });
});
