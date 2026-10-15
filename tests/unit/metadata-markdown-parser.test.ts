import { describe, expect, it } from "vitest";
import { parser } from "@lezer/markdown";
import type { Tree } from "@lezer/common";
import { parseMetadata } from "../../src/wiki/metadata";
import * as markdown from "../../src/wiki/markdown-references";

const nodes = (tree: Tree) => {
  const result: [string, number, number][] = [];
  tree.iterate({ enter(node) { result.push([node.name, node.from, node.to]); } });
  return result;
};

describe("metadata-only linear HardBreak parser", () => {
  it.each(["", "[after](After.md)"])("extracts links across a long space run with suffix %j without repeated scans", suffix => {
      const source = "[before](Before.md)" + " ".repeat(40_000) + suffix;
      const start = performance.now();
      const metadata = parseMetadata(source);
      expect(metadata.links.map(link => link.link)).toEqual(suffix ? ["Before.md", "After.md"] : ["Before.md"]);
      expect(metadata.links.map(link => source.slice(link.position.start.offset, link.position.end.offset))).toEqual(suffix ? ["[before](Before.md)", "[after](After.md)"] : ["[before](Before.md)"]);
      expect(performance.now() - start).toBeLessThan(500);
  });
  it("matches stock syntax node names and exact spans on the short syntax matrix", () => {
    expect(markdown.metadataMarkdownParser).toBeDefined();
    const examples = [
      "plain words   and trailing   ", "tabs\t\t text\t", "one two\nthree", "one  \ntwo", "one   \ntwo", "one\\\ntwo", "one\\ \ntwo",
      "one  \r\ntwo", "one\\\r\ntwo", "a\r\nb\r\n", "**bold   text** *em* [one](Note.md)",
      "`code   ` and `` x ` y  ``", "```\n[hidden](No.md)   \n```\n[shown](Yes.md)",
      "[link](<Note One.md> \"title  text\") ![alt](image.png 'title')", "[paren](Note(one).md) [escape](Note\\(one\\).md)",
      "[full][ID] [id][] [id]\n\n[id]: Note.md \"a title\"", "[multi\n line][key]\n\n[key]: <Note One.md>",
      "[label   with  spaces](Note.md)", "[ref   key]\n\n[ref key]: Note.md", "[^note]: text   \n\nbody[^note]",
      "> quoted  \n> next", "    code   \n    next", "\\*literal\\*  [label](Note.md)",
    ];
    for (const source of examples) expect(nodes(markdown.metadataMarkdownParser.parse(source)), JSON.stringify(source)).toEqual(nodes(parser.parse(source)));
  });
  it("keeps original CRLF offsets and destination bytes around long space runs", () => {
    const source = "# Heading\r\n\r\n[one](Note%20One.md#Header)" + " ".repeat(20_000) + "[two](Note(two).md)\r\n";
    const metadata = parseMetadata(source);
    expect(metadata.links.map(link => link.link)).toEqual(["Note One.md#Header", "Note(two).md"]);
    expect(metadata.links.map(link => [link.position.start.line, source.slice(link.position.start.offset, link.position.end.offset)])).toEqual([[2, "[one](Note%20One.md#Header)"], [2, "[two](Note(two).md)"]]);
  });
});
