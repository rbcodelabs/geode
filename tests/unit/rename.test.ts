import { describe, expect, it } from "vitest";
import { rewriteWikilinksForRename } from "../../src/renderer/rename";

// "Daily Plan.md" renamed to "Daily Notes.md" throughout these cases.
const oldBasename = "Daily Plan";
const oldPathNoExt = "Daily Plan";
const oldPath = "Daily Plan.md";
const newBasename = "Daily Notes";

describe("rewriteWikilinksForRename", () => {
  it("rewrites a link matching the old basename", () => {
    const out = rewriteWikilinksForRename(
      "See [[Daily Plan]] for today.",
      oldBasename,
      oldPathNoExt,
      oldPath,
      newBasename
    );
    expect(out).toBe("See [[Daily Notes]] for today.");
  });

  it("rewrites a link that targets the old path without its extension", () => {
    // File "Notes/Daily Plan.md" renamed to "Notes/Daily Notes.md" — a link
    // written by full relative path (not just basename) must also update.
    const out = rewriteWikilinksForRename(
      "See [[Notes/Daily Plan]] for today.",
      "Daily Plan",
      "Notes/Daily Plan",
      "Notes/Daily Plan.md",
      "Daily Notes"
    );
    expect(out).toBe("See [[Daily Notes]] for today.");
  });

  it("does not touch a link to a different note that merely shares a substring", () => {
    const out = rewriteWikilinksForRename(
      "See [[Notes/Daily Plan]] for today.",
      "Different Basename",
      "Notes/Other Plan",
      "Notes/Other Plan.md",
      newBasename
    );
    expect(out).toBe("See [[Notes/Daily Plan]] for today.");
  });

  it("rewrites a link matching the full old path", () => {
    const out = rewriteWikilinksForRename(
      "See [[Daily Plan.md]] for today.",
      oldBasename,
      oldPathNoExt,
      oldPath,
      newBasename
    );
    expect(out).toBe("See [[Daily Notes]] for today.");
  });

  it("is case-insensitive on the basename match", () => {
    const out = rewriteWikilinksForRename(
      "See [[daily plan]] for today.",
      oldBasename,
      oldPathNoExt,
      oldPath,
      newBasename
    );
    expect(out).toBe("See [[Daily Notes]] for today.");
  });

  it("preserves piped display text", () => {
    const out = rewriteWikilinksForRename(
      "See [[Daily Plan|today's plan]].",
      oldBasename,
      oldPathNoExt,
      oldPath,
      newBasename
    );
    expect(out).toBe("See [[Daily Notes|today's plan]].");
  });

  it("preserves a #heading suffix", () => {
    const out = rewriteWikilinksForRename(
      "See [[Daily Plan#Tasks]] for today.",
      oldBasename,
      oldPathNoExt,
      oldPath,
      newBasename
    );
    expect(out).toBe("See [[Daily Notes#Tasks]] for today.");
  });

  it("does not rewrite a ^block-reference link (pre-existing limitation)", () => {
    // The target-matching regex excludes '#' (so headings are stripped
    // correctly) but not '^', so a block reference gets swallowed into the
    // captured target and never matches the old basename/path. This mirrors
    // the original, unrefactored behavior in App.renameFileWithLinkUpdate —
    // documenting it here rather than silently "fixing" it as part of an
    // unrelated extraction.
    const out = rewriteWikilinksForRename(
      "See [[Daily Plan^abc123]] for today.",
      oldBasename,
      oldPathNoExt,
      oldPath,
      newBasename
    );
    expect(out).toBe("See [[Daily Plan^abc123]] for today.");
  });

  it("rewrites the target of an embed while keeping the leading '!'", () => {
    const out = rewriteWikilinksForRename(
      "![[Daily Plan]]",
      oldBasename,
      oldPathNoExt,
      oldPath,
      newBasename
    );
    expect(out).toBe("![[Daily Notes]]");
  });

  it("leaves links to unrelated notes untouched", () => {
    const text = "See [[Projects/Roadmap]] and [[Welcome]].";
    expect(rewriteWikilinksForRename(text, oldBasename, oldPathNoExt, oldPath, newBasename)).toBe(
      text
    );
  });

  it("rewrites every matching link when a note is referenced multiple times", () => {
    const out = rewriteWikilinksForRename(
      "[[Daily Plan]] ... later, [[Daily Plan|again]].",
      oldBasename,
      oldPathNoExt,
      oldPath,
      newBasename
    );
    expect(out).toBe("[[Daily Notes]] ... later, [[Daily Notes|again]].");
  });

  it("returns the text unchanged when there are no wikilinks", () => {
    const text = "Just plain prose, no links here.";
    expect(rewriteWikilinksForRename(text, oldBasename, oldPathNoExt, oldPath, newBasename)).toBe(
      text
    );
  });
});
