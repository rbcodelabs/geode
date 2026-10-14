import { describe, expect, it } from "vitest";
import {
  DEFAULT_CONVERTER_OPTIONS,
  buildZettelIndex,
  convertBearHighlights,
  convertNote,
  convertRoamHighlights,
  convertRoamTags,
  convertRoamTodos,
  convertVault,
  convertZettelkastenLinks,
  migrateProperties,
  type FormatConverterOptions,
} from "../../src/renderer/format-converter";

const opts = (o: Partial<FormatConverterOptions>): FormatConverterOptions => ({ ...DEFAULT_CONVERTER_OPTIONS, ...o });

describe("Roam", () => {
  it("converts #tag and #[[tag]] to [[tag]]", () => {
    expect(convertRoamTags("a #idea and #[[big idea]] end")).toBe("a [[idea]] and [[big idea]] end");
    expect(convertRoamTags("#start")).toBe("[[start]]");
  });
  it("leaves headings, mid-word hashes, urls and numeric refs alone", () => {
    expect(convertRoamTags("# Heading\n## Two")).toBe("# Heading\n## Two");
    expect(convertRoamTags("C#sharp and https://x.com/#frag and issue #12")).toBe("C#sharp and https://x.com/#frag and issue #12");
  });
  it("converts highlights", () => {
    expect(convertRoamHighlights("a ^^key^^ and ^^two words^^")).toBe("a ==key== and ==two words==");
  });
  it("converts TODOs", () => {
    expect(convertRoamTodos("- {{[[TODO]]}} buy milk")).toBe("- [ ] buy milk");
  });
  it("does not read the TODO macro as a tag link", () => {
    expect(convertNote("- {{[[TODO]]}} x #a", opts({ roamTodos: true, roamTags: true }))).toBe("- [ ] x [[a]]");
  });
});

describe("Bear", () => {
  it("converts ::highlight::", () => {
    expect(convertBearHighlights("see ::this part:: ok")).toBe("see ==this part== ok");
  });
});

describe("Zettelkasten", () => {
  const index = buildZettelIndex(["202401021530 My Note", "Plain", "202401021531 Other Thing"]);
  it("indexes only UID-prefixed names", () => {
    expect([...index.keys()]).toEqual(["202401021530", "202401021531"]);
  });
  it("full style", () => {
    expect(convertZettelkastenLinks("[[202401021530]]", "full", index)).toBe("[[202401021530 My Note]]");
  });
  it("pretty style", () => {
    expect(convertZettelkastenLinks("[[202401021530]]", "pretty", index)).toBe("[[202401021530 My Note|My Note]]");
  });
  it("leaves unknown UIDs, aliased and subpath links alone", () => {
    const s = "[[999999999999]] [[202401021530|x]] [[202401021530#h]] [[Plain]]";
    expect(convertZettelkastenLinks(s, "full", index)).toBe(s);
  });
});

describe("properties migration", () => {
  it("alias single value -> aliases list", () => {
    expect(migrateProperties("---\nalias: Foo\n---\n")).toBe("---\naliases:\n  - Foo\n---\n");
  });
  it("tag comma-separated -> tags list", () => {
    expect(migrateProperties("---\ntag: a, b,#c\n---\n")).toBe("---\ntags:\n  - a\n  - b\n  - c\n---\n");
  });
  it("cssclass -> cssclasses list", () => {
    expect(migrateProperties("---\ncssclass: wide, dark\n---\n")).toBe("---\ncssclasses:\n  - wide\n  - dark\n---\n");
  });
  it("renames key of existing list forms and keeps other keys", () => {
    expect(migrateProperties("---\ntitle: T\ntag: [a, b]\n---\n")).toBe("---\ntitle: T\ntags: [a, b]\n---\n");
    expect(migrateProperties("---\nalias:\n  - A\n---\n")).toBe("---\naliases:\n  - A\n---\n");
  });
  it("does not clobber an existing plural key", () => {
    const fm = "---\ntag: x\ntags:\n  - y\n---\n";
    expect(migrateProperties(fm)).toBe(fm);
  });
  it("preserves CRLF and empty input", () => {
    expect(migrateProperties("---\r\nalias: A\r\n---\r\n")).toBe("---\r\naliases:\r\n  - A\r\n---\r\n");
    expect(migrateProperties("")).toBe("");
  });
});

describe("convertNote", () => {
  const all = opts({ roamTags: true, roamHighlights: true, roamTodos: true, bearHighlights: true, properties: true });
  it("skips code blocks, inline code and frontmatter for body conversions", () => {
    const text = "---\ncolor: #fff\ntag: x\n---\n#a ^^h^^\n`#b ^^c^^`\n```\n#c ^^d^^\n```\n~~~\n#e\n~~~\n#f\n";
    expect(convertNote(text, all)).toBe(
      "---\ncolor: #fff\ntags:\n  - x\n---\n[[a]] ==h==\n`#b ^^c^^`\n```\n#c ^^d^^\n```\n~~~\n#e\n~~~\n[[f]]\n"
    );
  });
  it("is a no-op with nothing enabled and idempotent otherwise", () => {
    const text = "#a ^^h^^ {{[[TODO]]}}\n";
    expect(convertNote(text, DEFAULT_CONVERTER_OPTIONS)).toBe(text);
    const once = convertNote(text, all);
    expect(convertNote(once, all)).toBe(once);
  });
});

describe("convertVault", () => {
  it("writes only changed notes and reports failures", async () => {
    const store = new Map([
      ["a.md", "#x"],
      ["b.md", "plain"],
      ["c.md", "boom"],
    ]);
    const writes: string[] = [];
    const result = await convertVault(
      {
        files: [...store.keys()].map((p) => ({ path: p, basename: p.replace(/\.md$/, "") })),
        read: async (p) => {
          if (p === "c.md") throw new Error("nope");
          return store.get(p)!;
        },
        write: async (p, c) => {
          writes.push(p);
          store.set(p, c);
        },
      },
      opts({ roamTags: true })
    );
    expect(writes).toEqual(["a.md"]);
    expect(store.get("a.md")).toBe("[[x]]");
    expect(result).toEqual({ scanned: 3, changed: ["a.md"], failed: [{ path: "c.md", message: "nope" }] });
  });
});
