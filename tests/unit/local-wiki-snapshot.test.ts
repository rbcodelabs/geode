import { describe, expect, it } from "vitest";
import { createWikiSnapshot, type CapturedFile } from "../../src/wiki/snapshot";

const note = (path: string, text = ""): CapturedFile => ({ path, kind: "note", text });
const fixture = () => createWikiSnapshot([
  note("folder/Source.md", "# Source\n[[Twin]] [[Target#Absent]] ![[asset.png]] [[#Source]]"),
  note("Target.md", "---\naliases: [Guide, Guide]\n---\n# Found\n\n- item ^block\n# Duplicate\n# Duplicate"),
  note("folder/Target.md"), note("folder/Local.md"),
  note("a/Twin.md"), note("b/Twin.md"),
  { path: "asset.png", kind: "attachment" },
]);

describe("strict snapshot resolution", () => {
  it("uses ordered root, source-folder, basename and alias tiers", () => {
    const s = fixture();
    expect(s.resolve("folder/Source.md", "Target")).toMatchObject({ status: "resolved", path: "Target.md" });
    expect(s.resolve("folder/Source.md", "Local")).toMatchObject({ status: "resolved", path: "folder/Local.md" });
    expect(s.resolve("folder/Source.md", "Guide")).toMatchObject({ status: "resolved", path: "Target.md" });
    expect(s.resolve("folder/Source.md", "Twin")).toMatchObject({ status: "ambiguous", candidates: ["a/Twin.md", "b/Twin.md"] });
    expect(s.resolve("folder/Source.md", "asset")).toMatchObject({ status: "missing" });
  });

  it("normalizes explicit relative paths without falling back elsewhere", () => {
    const s = fixture();
    expect(s.resolve("folder/Source.md", "../Target")).toMatchObject({ path: "Target.md" });
    expect(s.resolve("folder/Source.md", "./Target")).toMatchObject({ path: "folder/Target.md" });
    expect(s.resolve("folder/Source.md", "./Twin")).toMatchObject({ status: "missing" });
    expect(s.resolve("folder/Source.md", "../../Target")).toMatchObject({ status: "invalid" });
  });

  it("returns all distinct files sharing an alias without duplicating one file's alias", () => {
    const s = createWikiSnapshot([note("Source.md"), note("a.md", "---\naliases: [Guide, Guide]\n---\n"), note("b.md", "---\naliases: [GUIDE]\n---\n")]);
    expect(s.resolve("Source.md", "guide")).toMatchObject({ status: "ambiguous", candidates: ["a.md", "b.md"] });
  });

  it("reports file identity independently of heading or block validation", () => {
    const s = fixture();
    const resolve = (target: string) => s.resolve("folder/Source.md", target);
    expect(resolve("#Source")).toMatchObject({ status: "resolved", path: "folder/Source.md", subpath: { status: "found" } });
    expect(resolve("Target#Found")).toMatchObject({ subpath: { status: "found" } });
    expect(resolve("Target#^block")).toMatchObject({ subpath: { status: "found" } });
    expect(resolve("Target#Duplicate")).toMatchObject({ subpath: { status: "ambiguous" } });
    expect(resolve("Target#Absent")).toMatchObject({ status: "resolved", subpath: { status: "missing" } });
    expect(resolve("Target#^absent")).toMatchObject({ subpath: { status: "missing" } });
    expect(resolve("Target#one#two")).toMatchObject({ subpath: { status: "unknown" } });
    expect(resolve("asset.png#Heading")).toMatchObject({ status: "resolved", subpath: { status: "unknown" } });
    expect(s.resolve("absent.md", "Target")).toMatchObject({ status: "unavailable" });
  });

  it.each(["/Target", "C:/Target", "C:Target", "\\\\host\\Target", "a\\b", "x\0y", "file:///tmp/Target", "../Target"])("rejects unsafe local target %j", (target) => {
    expect(fixture().resolve("Target.md", target)).toMatchObject({ status: "invalid" });
  });

  it("classifies URLs, preserves percent literals, and requires source identity", () => {
    const s = createWikiSnapshot([note("Source.md"), note("%2e%2e.md")]);
    expect(s.resolve("Source.md", "https://example.test/note")).toMatchObject({ status: "external" });
    expect(s.resolve("Source.md", "%2e%2e")).toMatchObject({ path: "%2e%2e.md" });
    expect(s.resolve("source.md", "Source")).toMatchObject({ status: "unavailable" });
  });

  it("preserves exact case/Unicode identities and reports normalized collisions", () => {
    const s = createWikiSnapshot([note("Source.md"), note("a/CAFÉ.md"), note("a/cafe\u0301.md")]);
    expect(s.listFiles().map(f => f.path)).toEqual(["Source.md", "a/CAFÉ.md", "a/cafe\u0301.md"]);
    expect(s.info.diagnostics).toContainEqual({ code: "portability-collision", paths: ["a/CAFÉ.md", "a/cafe\u0301.md"] });
    expect(s.readNote("a/CAFÉ.md")).toMatchObject({ status: "ok" });
    expect(s.readNote("a/café.md")).toMatchObject({ status: "absent" });
    expect(s.resolve("Source.md", "café")).toMatchObject({ status: "ambiguous", candidates: ["a/CAFÉ.md", "a/cafe\u0301.md"] });
  });

  it("keeps confirmed backlinks with original spans and failed subpaths", () => {
    const s = fixture();
    const result = s.backlinks("Target.md");
    expect(result.status).toBe("ok");
    expect(result.references).toHaveLength(1);
    const ref = result.references[0];
    expect(ref.resolution).toMatchObject({ status: "resolved", subpath: { status: "missing" } });
    const source = s.readNote(ref.sourcePath);
    expect(source.status === "ok" && source.note.text.slice(ref.position.start.offset, ref.position.end.offset)).toBe("[[Target#Absent]]");
    expect(s.backlinks("a/Twin.md").references).toEqual([]);
    expect(s.backlinks("asset.png").references[0].isEmbed).toBe(true);
    expect(result.coverage).toMatchObject({ referenceSyntax: "wikilinks", completeMarkdownGraph: false });
  });
});

describe("parser coverage and detached queries", () => {
  it.each([
    ["crlf-headings", "# Heading\r\n", "Heading"],
    ["tilde-fence-references", "~~~\n[[Target]]\n~~~", "Missing"],
    ["frontmatter-malformed", "---\na: [\n---\n", "Missing"],
    ["frontmatter-unterminated", "---\na: yes\n", "Missing"],
    ["frontmatter-nonmapping", "---\n- yes\n---\n", "Missing"],
  ])("diagnoses %s and avoids certain negative subpath claims", (code, text, heading) => {
    const s = createWikiSnapshot([note("Target.md", text)]);
    expect(s.info.diagnostics).toContainEqual(expect.objectContaining({ code, path: "Target.md" }));
    expect(s.resolve("Target.md", `#${heading}`)).toMatchObject({ subpath: { status: "unknown" } });
  });

  it("marks unsupported Markdown links without changing raw search coverage", () => {
    const s = createWikiSnapshot([note("Target.md", "[inline](Other.md) [ref][id]\n[id]: Other.md")]);
    expect(s.info.diagnostics).toContainEqual(expect.objectContaining({ code: "markdown-links-unsupported" }));
    expect(s.search("Other")).toMatchObject({ complete: true, hits: [{ path: "Target.md" }] });
    expect(s.outgoing("Target.md").references).toEqual([]);
  });

  it("detects body scan limits in code units at the exact parser boundary", () => {
    const s = createWikiSnapshot([note("at.md", "x".repeat(300_000)), note("over.md", "---\naliases: [Big]\n---\n" + "é".repeat(300_001))]);
    expect(s.info.diagnostics.filter(d => d.code === "parser-body-cap").map(d => d.path)).toEqual(["over.md"]);
    expect(s.resolve("at.md", "Big#No")).toMatchObject({ path: "over.md", subpath: { status: "unknown" } });
    expect(s.search("é").complete).toBe(true);
  });

  it("resolves unloaded identities while disclosing unavailable content", () => {
    const s = createWikiSnapshot([note("Source.md"), { path: "Bad.md", kind: "note" }], { discoveryComplete: false });
    expect(s.readNote("Bad.md")).toMatchObject({ status: "unavailable" });
    expect(s.resolve("Source.md", "Bad#Heading")).toMatchObject({ status: "resolved", subpath: { status: "unknown", reason: "content-unavailable" } });
    expect(s.resolve("Source.md", "Absent")).toMatchObject({ status: "unavailable", discoveryComplete: false, aliasCoverageComplete: false });
    expect(s.search("anything").complete).toBe(false);
  });

  it("does not claim a missing or unique alias while another note's aliases are unavailable", () => {
    const s = createWikiSnapshot([note("Source.md"), note("Good.md", "---\naliases: [Guide]\n---\n"), { path: "Unread.md", kind: "note" }]);
    expect(s.resolve("Source.md", "Guide")).toMatchObject({ status: "unavailable", reason: "alias-coverage", candidates: ["Good.md"], aliasCoverageComplete: false });
    expect(s.resolve("Source.md", "Absent")).toMatchObject({ status: "unavailable", reason: "alias-coverage" });
    expect(s.resolve("Source.md", "./Absent")).toMatchObject({ status: "missing" });
    expect(s.resolve("Source.md", "Good")).toMatchObject({ status: "resolved", path: "Good.md" });
  });

  it("freezes cyclic frontmatter and discloses paragraph-block coverage", () => {
    const s = createWikiSnapshot([note("Target.md", "---\ncycle: &cycle\n  self: *cycle\n---\nparagraph ^para")]);
    const result = s.readNote("Target.md");
    if (result.status !== "ok") throw Error("expected loaded note");
    const cycle = result.note.metadata!.frontmatter!.cycle as Record<string, unknown>;
    expect(cycle.self).toBe(cycle);
    expect(() => { cycle.changed = true; }).toThrow();
    expect(s.resolve("Target.md", "#^para")).toMatchObject({ subpath: { status: "unknown" } });
    expect(s.info.diagnostics).toContainEqual({ code: "paragraph-block-ids-unsupported", path: "Target.md" });
  });

  it("keeps YAML Set/Map mutations on returned metadata detached from the snapshot", () => {
    const s = createWikiSnapshot([note("Set.md", "---\nvalues: !!set\n  a:\nordered: !!omap\n  - first: yes\n---\n")]);
    const first = s.readNote("Set.md");
    if (first.status !== "ok") throw Error("expected note");
    (first.note.metadata!.frontmatter!.values as Set<string>).add("corruption");
    (first.note.metadata!.frontmatter!.ordered as Map<string, unknown>).set("corruption", true);
    const second = s.readNote("Set.md");
    if (second.status !== "ok") throw Error("expected note");
    expect([...(second.note.metadata!.frontmatter!.values as Set<string>)]).toEqual(["a"]);
    expect([...(second.note.metadata!.frontmatter!.ordered as Map<string, unknown>).keys()]).toEqual(["first"]);
  });

  it("reports unsupported setext headings rather than authoritative absence", () => {
    const s = createWikiSnapshot([note("Target.md", "Heading\n=======\n")]);
    expect(s.resolve("Target.md", "#Heading")).toMatchObject({ subpath: { status: "unknown" } });
    expect(s.info.diagnostics).toContainEqual({ code: "setext-headings-unsupported", path: "Target.md" });
  });

  it("supports YAML binary values and isolates mutations of returned bytes", () => {
    const s = createWikiSnapshot([note("Binary.md", "---\nnested:\n  data: !!binary SGVsbG8=\n---\n")]);
    const first = s.readNote("Binary.md");
    if (first.status !== "ok") throw Error("expected note");
    const bytes = (first.note.metadata!.frontmatter!.nested as { data: Uint8Array }).data;
    expect([...bytes]).toEqual([72, 101, 108, 108, 111]);
    bytes[0] = 0;
    const second = s.readNote("Binary.md");
    if (second.status !== "ok") throw Error("expected note");
    expect((second.note.metadata!.frontmatter!.nested as { data: Uint8Array }).data[0]).toBe(72);
  });

  it("discloses BOM-prefixed frontmatter unsupported by the unchanged parser", () => {
    const s = createWikiSnapshot([note("Source.md"), note("Target.md", "\ufeff---\naliases: [Guide]\n---\n")]);
    expect(s.info.diagnostics).toContainEqual({ code: "frontmatter-bom-unsupported", path: "Target.md" });
    expect(s.resolve("Source.md", "Guide")).toMatchObject({ status: "unavailable", reason: "alias-coverage" });
  });

  it("isolates caller input and every returned object from later mutation", () => {
    const input = [note("Target.md", "---\naliases: [Guide]\ndata: {nested: yes}\n---\n[[Target]]")];
    const s = createWikiSnapshot(input);
    input[0].text = "changed";
    const result = s.readNote("Target.md");
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw Error("expected note");
    expect(() => { result.note.metadata!.aliases.push("Corrupt"); }).toThrow();
    expect(() => { s.listFiles()[0].path = "changed"; }).toThrow();
    expect(() => { s.backlinks("Target.md").references[0].position.start.offset = 900; }).toThrow();
    expect(s.resolve("Target.md", "Guide")).toMatchObject({ path: "Target.md" });
    expect(s.search("changed").hits).toEqual([]);
  });

  it("searches literal raw text with ASCII folding and original code-unit offsets", () => {
    const s = createWikiSnapshot([note("z.md", "İ🙂 NEEDLE .* [literal]"), note("a.md", "needle"), note("b.md", "NEEDLE")]);
    expect(s.search(" nEeDlE ", 2)).toMatchObject({ hits: [{ path: "a.md" }, { path: "b.md" }], truncated: true });
    expect(s.search("NEEDLE").hits[2].offset).toBe(4);
    expect(s.search(".*").hits).toHaveLength(1);
    expect(s.search(" ").hits).toEqual([]);
    expect(s.search("i").hits.some(h => h.offset === 0)).toBe(false);
    expect(s.search("İ").hits[0].offset).toBe(0);
    expect(s.search("absent").truncated).toBe(false);
    expect(s.search("n", 0).status).toBe("invalid");
    expect(s.search("n", 501).status).toBe("invalid");
    expect(s.search("n".repeat(1025)).status).toBe("invalid");
  });

  it("bounds long-line snippets and rejects invalid read paths", () => {
    const s = createWikiSnapshot([note("Long.md", "x".repeat(500) + "needle" + "y".repeat(500))]);
    const hit = s.search("needle").hits[0];
    expect(hit.snippet.length).toBeLessThanOrEqual(250);
    expect(hit.snippet).toContain("needle");
    expect(s.readNote("../Long.md").status).toBe("invalid");
    expect(s.readNote("").status).toBe("invalid");
  });
});
