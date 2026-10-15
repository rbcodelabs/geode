import { describe, expect, it } from "vitest";
import { parseMetadata } from "../../src/wiki/metadata";
import { createWikiSnapshot } from "../../src/wiki/snapshot";
import { FakeVault } from "../helpers/fake-vault";
import { scanFootnotes } from "../../src/wiki/footnote-scan";
import { resolveBlockBoundary } from "../../src/renderer/block-boundary";
import { MetadataCache } from "../../src/renderer/metadata-cache";

const span = (text: string, position: { start: { offset: number }; end: { offset: number } }) => text.slice(position.start.offset, position.end.offset);

describe("metadata parity extraction", () => {
  it("bounds delimiter-heavy parsing below the normal note scan cap", () => {
    const text = "prefix " + "`".repeat(8_000);
    const start = performance.now();
    expect(parseMetadata(text).links).toEqual([]);
    expect(scanFootnotes(text).definitions).toEqual([]);
    expect(performance.now() - start).toBeLessThan(500);
  });
  it("extracts Markdown destinations with nested and escaped parentheses, titles and encoded paths", () => {
    const text = '[plain](Note%20One.md#Heading "title") [nested](folder/Note(two).md) [escaped](Note\\(one\\).md) ![alt](image.png)';
    const metadata = parseMetadata(text);
    expect(metadata.links.map(link => link.link)).toEqual(["Note One.md#Heading", "folder/Note(two).md", "Note(one).md"]);
    expect(metadata.links.map(link => span(text, link.position))).toEqual(['[plain](Note%20One.md#Heading "title")', '[nested](folder/Note(two).md)', '[escaped](Note\\(one\\).md)']);
    expect(metadata.embeds.map(link => link.link)).toEqual(["image.png"]);
  });
  it.fails("diagnostic: nested bracket labels need a richer CommonMark reference context", () => {
    expect(parseMetadata("[see [[Label]]](Actual.md)").links.map(link => link.link)).toEqual(["Actual.md"]);
  });
  it("preserves percent literals in wiki syntax and decodes authored Markdown paths once", () => {
    expect(parseMetadata("[[literal%20name]] [encoded](literal%2520name.md) [bad](bad%XY.md)").links.map(link => link.link)).toEqual(["literal%20name", "literal%20name.md", "bad%XY.md"]);
  });
  it("ignores escaped wiki syntax in body and properties", () => {
    const text = "---\nrelated: '\\[[Hidden]]'\n---\n\\[[Hidden]] [[Actual]]";
    const metadata = parseMetadata(text);
    expect(metadata.links.map(link => link.link)).toEqual(["Actual"]);
    expect(metadata.frontmatterLinks).toBeUndefined();
  });
  it("keeps source order without duplicating Markdown-looking labels or wiki links", () => {
    const metadata = parseMetadata('[one](One.md) [[Two]] [three](Three.md) ![[asset.png]] ![image](picture.png)');
    expect(metadata.links.map(link => link.link)).toEqual(["One.md", "Two", "Three.md"]);
    expect(metadata.embeds.map(link => link.link)).toEqual(["asset.png", "picture.png"]);
  });
  it("ignores code, escapes and comments, and preserves original CRLF offsets", () => {
    const text = '~~~\r\n[no](Code.md)\r\n~~~\r\n`[no](Inline.md)` %% [no](Hidden.md) %%\\[escaped](No.md)\r\n[yes](Actual.md)';
    const metadata = parseMetadata(text);
    expect(metadata.links.map(link => link.link)).toEqual(["Actual.md"]);
    expect(span(text, metadata.links[0].position)).toBe('[yes](Actual.md)');
    expect(metadata.links[0].position.start.line).toBe(4);
  });
  it("resolves full, collapsed, shortcut and image reference definitions case-insensitively", () => {
    const text = '[Label][ID] [id][] [id] ![image][ID]\n\n[id]: <Target%20One.md> "title"\n';
    const metadata = parseMetadata(text);
    expect(metadata.referenceLinks?.map(link => [link.id, link.link])).toEqual([["ID", "Target One.md"], ["id", "Target One.md"], ["id", "Target One.md"], ["ID", "Target One.md"]]);
    expect(metadata.links.map(link => link.link)).toEqual(["Target One.md", "Target One.md", "Target One.md"]);
    expect(metadata.embeds.map(link => link.link)).toEqual(["Target One.md"]);
    expect(parseMetadata('[missing] [label][unknown]').referenceLinks).toBeUndefined();
  });
  it("extracts blocks and multiline footnote definitions with exact source spans", () => {
    const text = 'Paragraph line\ncontinued ^block\n\n- item ^list\n\n[^id]: first\n    continued\n\nafter\n';
    const metadata = parseMetadata(text);
    expect(metadata).toHaveProperty('blocks.block.id', 'block');
    expect(span(text, (metadata as any).blocks.block.position)).toBe('Paragraph line\ncontinued ^block');
    expect(metadata).toHaveProperty('blocks.list.id', 'list');
    expect(metadata).toHaveProperty('footnotes.0.id', 'id');
    expect(span(text, (metadata as any).footnotes[0].position)).toBe('[^id]: first\n    continued');
  });
  it("exposes frontmatter links separately with property keys and a real frontmatter span", () => {
    const text = '---\r\nrelated: "[[Target|Alias]]"\r\nlist:\r\n  - "[[Other]]"\r\n---\r\nBody [[Body]]';
    const metadata = parseMetadata(text) as any;
    expect(metadata.frontmatterLinks.map((link: any) => [link.key, link.link, link.original])).toEqual([["related", "Target", "[[Target|Alias]]"], ["list.0", "Other", "[[Other]]"]]);
    expect(span(text, metadata.frontmatterPosition)).toBe(text.slice(0, text.indexOf('Body')).trimEnd());
    expect(metadata.links.map((link: any) => link.link)).toEqual(["Body"]);
  });
  it("recognizes footnote definitions after a CRLF code fence", () => {
    const metadata = parseMetadata("~~~\r\n[^fake]: hidden\r\n~~~\r\n\r\n[^real]: visible\r\n");
    expect(metadata.footnotes?.map(note => note.id)).toEqual(["real"]);
  });
  it("keeps block and footnote metadata absent when examples occur only in code", () => {
    const metadata = parseMetadata('```\nParagraph ^id\n[^note]: text\n```\n');
    expect((metadata as any).blocks).toBeUndefined();
    expect((metadata as any).footnotes).toBeUndefined();
  });
  it("keeps line-zero grouping safe for real bookmark and SDK block consumers", () => {
    const text = "- [ ] root ^root\n  - [ ] child ^child\n- [ ] sibling ^sibling\n";
    const metadata = parseMetadata(text);
    expect(Object.is(metadata.listItems![0].parent, -0)).toBe(true);
    expect(Object.is(metadata.listItems![2].parent, -0)).toBe(true);
    expect(metadata.listItems![1].parent).toBe(0);
    // JSON cannot preserve -0. These actual consumers resolve source spans,
    // not parent<0 or recursive parent lookups, so hydration stays safe.
    const restored = JSON.parse(JSON.stringify(metadata));
    for (const line of [0, 1, 2]) expect(resolveBlockBoundary(line, restored.sections, restored.listItems)).toEqual({ kind: "line", line });
    const snapshot = createWikiSnapshot([{ path: "Tasks.md", kind: "note", text }]);
    for (const id of ["root", "child", "sibling"]) expect(snapshot.resolve("Tasks.md", `#^${id}`).subpath.status).toBe("found");
  });
  it("uses one shared negative first-item parent per root list", () => {
    expect(parseMetadata('\n\n- first\n  - child\n- second\n\nprose\n\n- next\n').listItems?.map(item => item.parent)).toEqual([-2, 2, -2, -8]);
  });
  it("does not turn external URLs into unresolved vault references", async () => {
    const vault = new FakeVault({ 'Source.md': '---\nrelated: "[[Target]]"\n---\n[internal](Target.md) [external](https://example.com) ![remote](https://example.com/image.png)', 'Target.md': '' });
    const cache = new MetadataCache(vault.asVault());
    await cache.initialize();
    expect(cache.resolvedLinks['Source.md']).toEqual({ 'Target.md': 2 });
    expect(cache.unresolvedLinks['Source.md']).toEqual({});
  });
  it("shares ordered Markdown/property projections with headless outgoing and backlinks", () => {
    const snapshot = createWikiSnapshot([{ path: 'Source.md', kind: 'note', text: '---\nrelated: "[[Target]]"\n---\n[label](Target.md) ![image](image.png)' }, { path: 'Target.md', kind: 'note', text: '' }, { path: 'image.png', kind: 'attachment' }]);
    expect(snapshot.outgoing('Source.md').references.map(link => link.link)).toEqual(['Target', 'Target.md', 'image.png']);
    expect(snapshot.backlinks('Target.md').references).toHaveLength(2);
  });
});
