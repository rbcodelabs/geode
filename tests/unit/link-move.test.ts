import { describe, expect, it } from "vitest";
import { assertValidMove, collectMoves, planLinkRewrites } from "../../src/renderer/link-move";

const FILES = [
  "Projects/Alpha/Note.md",
  "Projects/Alpha/Other.md",
  "Projects/Alpha/sub/Deep.md",
  "Projects/Alpha/pic.png",
  "Projects/Beta/Sibling.md",
  "Inbox.md",
  "Unrelated.md",
];
const folderMove = collectMoves(FILES, "Projects/Alpha", "Archive/Alpha", true);

function plan(sources: Record<string, string>, moves = folderMove, files = FILES) {
  return planLinkRewrites({
    files,
    moves,
    sources: Object.entries(sources).map(([path, text]) => ({ path, text })),
  });
}

describe("collectMoves", () => {
  it("maps every file under a moved folder and only that folder", () => {
    expect([...folderMove]).toEqual([
      ["Projects/Alpha/Note.md", "Archive/Alpha/Note.md"],
      ["Projects/Alpha/Other.md", "Archive/Alpha/Other.md"],
      ["Projects/Alpha/sub/Deep.md", "Archive/Alpha/sub/Deep.md"],
      ["Projects/Alpha/pic.png", "Archive/Alpha/pic.png"],
    ]);
  });
  it("maps a single file", () => {
    expect([...collectMoves(FILES, "Inbox.md", "Archive/Inbox.md", false)]).toEqual([["Inbox.md", "Archive/Inbox.md"]]);
  });
});

describe("planLinkRewrites: wikilinks and embeds", () => {
  it("leaves a bare basename that still resolves uniquely untouched", () => {
    const out = plan({ "Inbox.md": "See [[Note]] and ![[pic.png]]" });
    expect(out.size).toBe(0);
  });
  it("rewrites path-qualified wikilinks, embeds, aliases, headings and blocks", () => {
    const out = plan({
      "Inbox.md": [
        "[[Projects/Alpha/Note]]",
        "[[Projects/Alpha/Note|the alias]]",
        "[[Projects/Alpha/Note#Heading]]",
        "[[Projects/Alpha/Note#^block|alias]]",
        "![[Projects/Alpha/pic.png]]",
        "[[Projects/Alpha/Note.md]]",
      ].join("\n"),
    });
    expect(out.get("Inbox.md")).toBe([
      "[[Archive/Alpha/Note]]",
      "[[Archive/Alpha/Note|the alias]]",
      "[[Archive/Alpha/Note#Heading]]",
      "[[Archive/Alpha/Note#^block|alias]]",
      "![[Archive/Alpha/pic.png]]",
      "[[Archive/Alpha/Note.md]]",
    ].join("\n"));
  });
  it("switches a basename link to a path when the basename becomes ambiguous", () => {
    const files = [...FILES, "Projects/Beta/Gamma/Note.md"];
    const moves = collectMoves(files, "Projects/Alpha", "Archive/Alpha/Deeper/Still/Folder", true);
    // Before the move [[Note]] picks the shortest path (Projects/Alpha/Note.md); after it the rival is shorter.
    const out = plan({ "Inbox.md": "[[Other]] [[Note]]" }, moves, files);
    expect(out.get("Inbox.md")).toBe("[[Other]] [[Archive/Alpha/Deeper/Still/Folder/Note]]");
  });
  it("renames a basename link when the basename itself changes", () => {
    const moves = collectMoves(FILES, "Projects/Alpha/Note.md", "Projects/Alpha/Renamed.md", false);
    const out = plan({ "Inbox.md": "[[Note]] [[Note#H|x]] [[Projects/Alpha/Note]]" }, moves);
    expect(out.get("Inbox.md")).toBe("[[Renamed]] [[Renamed#H|x]] [[Projects/Alpha/Renamed]]");
  });
  it("does not touch wikilinks in code fences or inline code", () => {
    const text = "```\n[[Projects/Alpha/Note]]\n```\n`[[Projects/Alpha/Note]]` and [[Projects/Alpha/Note]]";
    expect(plan({ "Inbox.md": text }).get("Inbox.md")).toBe(
      "```\n[[Projects/Alpha/Note]]\n```\n`[[Projects/Alpha/Note]]` and [[Archive/Alpha/Note]]",
    );
  });
  it("does not rewrite dangling or unrelated links", () => {
    const text = "[[Nope]] [[Projects/Beta/Sibling]] [[Unrelated#x]]";
    expect(plan({ "Inbox.md": text }).size).toBe(0);
  });
});

describe("planLinkRewrites: markdown links", () => {
  it("rewrites a vault-root path link, keeping fragment", () => {
    const out = plan({ "Inbox.md": "[x](Projects/Alpha/Note.md) [y](Projects/Alpha/Note.md#Head) ![i](Projects/Alpha/pic.png)" });
    expect(out.get("Inbox.md")).toBe("[x](Archive/Alpha/Note.md) [y](Archive/Alpha/Note.md#Head) ![i](Archive/Alpha/pic.png)");
  });
  it("keeps url-encoded and angle-bracket styles", () => {
    const files = [...FILES, "Projects/Alpha/My Note.md"];
    const moves = collectMoves(files, "Projects/Alpha", "Archive/Alpha", true);
    const out = plan({ "Inbox.md": "[a](Projects/Alpha/My%20Note.md) [b](<Projects/Alpha/My Note.md>)" }, moves, files);
    expect(out.get("Inbox.md")).toBe("[a](Archive/Alpha/My%20Note.md) [b](<Archive/Alpha/My Note.md>)");
  });
  it("rewrites relative links from an unmoved note", () => {
    const out = plan({ "Projects/Beta/Sibling.md": "[n](../Alpha/Note.md) [o](./../Alpha/Other.md#x)" });
    expect(out.get("Projects/Beta/Sibling.md")).toBe("[n](../../Archive/Alpha/Note.md) [o](../../Archive/Alpha/Other.md#x)");
  });
  it("leaves external, anchor-only, code and unrelated markdown links alone", () => {
    const text = "[a](https://x.test/Projects/Alpha/Note.md) [b](#H) [c](mailto:a@b.c) `[d](Projects/Alpha/Note.md)` [e](Unrelated.md)";
    expect(plan({ "Inbox.md": text }).size).toBe(0);
  });
  it("rewrites reference-style link definitions", () => {
    const out = plan({ "Inbox.md": "see [n][ref]\n\n[ref]: Projects/Alpha/Note.md\n" });
    expect(out.get("Inbox.md")).toBe("see [n][ref]\n\n[ref]: Archive/Alpha/Note.md\n");
  });
});

describe("planLinkRewrites: moved notes", () => {
  it("keeps links between two moved notes valid (no rewrite needed for relative or basename links)", () => {
    const out = plan({
      "Projects/Alpha/Note.md": "[[Other]] [o](Other.md) [d](sub/Deep.md) [[sub/Deep]]",
      "Projects/Alpha/sub/Deep.md": "[up](../Note.md)",
    });
    expect(out.size).toBe(0);
  });
  it("fixes relative markdown links inside a moved note that point at notes that did not move", () => {
    const out = plan({ "Projects/Alpha/Note.md": "[s](../Beta/Sibling.md#h) [u](../../Unrelated.md) [r](Other.md)" });
    expect(out.get("Projects/Alpha/Note.md")).toBe("[s](../../Projects/Beta/Sibling.md#h) [u](../../Unrelated.md) [r](Other.md)");
  });
  it("fixes path-qualified wikilinks inside moved notes only when they stop resolving", () => {
    const out = plan({ "Projects/Alpha/Note.md": "[[Projects/Beta/Sibling]] [[Projects/Alpha/Other]]" });
    // Sibling did not move and the path is root-qualified: still resolves. Other moved with the note.
    expect(out.get("Projects/Alpha/Note.md")).toBe("[[Projects/Beta/Sibling]] [[Archive/Alpha/Other]]");
  });
  it("is keyed by the OLD path of the source", () => {
    const out = plan({ "Projects/Alpha/Note.md": "[[Projects/Alpha/Other]]" });
    expect([...out.keys()]).toEqual(["Projects/Alpha/Note.md"]);
  });
});

describe("assertValidMove", () => {
  const exists = (p: string) => (p === "A.md" || p === "Dir" ? true : false);
  const ok = (from: string, to: string) => assertValidMove(from, to);
  it("accepts ordinary vault-relative paths", () => {
    expect(() => ok("A/B.md", "C/D.md")).not.toThrow();
    expect(() => ok("Dir", "Other/Dir")).not.toThrow();
  });
  it.each([
    ["absolute", "A.md", "/abs/A.md"],
    ["absolute source", "/A.md", "B.md"],
    ["dotdot", "A.md", "../A.md"],
    ["embedded dotdot", "A.md", "x/../../A.md"],
    ["empty target", "A.md", ""],
    ["empty source", "", "B.md"],
    ["backslash", "A.md", "x\\y.md"],
    ["trailing slash", "A.md", "x/"],
    ["double slash", "A.md", "x//y.md"],
    ["windows drive", "A.md", "C:/x.md"],
    ["hidden segment", "A.md", ".obsidian/x.md"],
    ["same path", "A.md", "A.md"],
    ["folder into itself", "Dir", "Dir/Inner"],
  ])("rejects %s", (_name, from, to) => {
    void exists;
    expect(() => ok(from, to)).toThrow();
  });
});
