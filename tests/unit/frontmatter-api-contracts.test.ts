import { describe, expect, it } from "vitest";
import * as ObsidianApi from "../../src/renderer/api/obsidian";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";
import { parseMetadata } from "../../src/renderer/metadata-cache";

describe("getFrontMatterInfo", () => {
  it("exports the documented function from the Obsidian compatibility module", () => {
    expect(ObsidianApi.getFrontMatterInfo).toBeTypeOf("function");
  });

  it("returns the raw frontmatter and exact LF-delimited offsets", () => {
    const content = "---\ntitle: Hello\ntags:\n  - one\n---\n# Body\n";
    const from = content.indexOf("\n") + 1;
    const to = content.indexOf("\n---", from);
    const contentStart = content.indexOf("\n", to + 1) + 1;

    expect(ObsidianApi.getFrontMatterInfo(content)).toEqual({
      exists: true,
      frontmatter: content.slice(from, to),
      from,
      to,
      contentStart,
    });
    expect(content.slice(contentStart)).toBe("# Body\n");
  });

  it("preserves CRLF frontmatter text while placing contentStart at body content", () => {
    const content = "---\r\ntitle: Hello\r\n---\r\nBody";
    const from = content.indexOf("\r\n") + 2;
    const to = content.indexOf("\r\n---", from);
    const contentStart = content.indexOf("\r\n", to + 2) + 2;

    expect(ObsidianApi.getFrontMatterInfo(content)).toEqual({
      exists: true,
      frontmatter: "title: Hello",
      from,
      to,
      contentStart,
    });
    expect(content.slice(contentStart)).toBe("Body");
  });

  it("reports no block when delimiters are absent or an opener is unclosed", () => {
    const absent = {
      exists: false,
      frontmatter: "",
      from: 0,
      to: 0,
      contentStart: 0,
    };
    expect(ObsidianApi.getFrontMatterInfo("# Body\n")).toEqual(absent);
    expect(ObsidianApi.getFrontMatterInfo("---\ntitle: unclosed\n")).toEqual(absent);
  });
});

describe("getAllTags public contract", () => {
  it("combines parsed frontmatter and inline tags, de-duplicated", () => {
    const cache = parseMetadata(
      "---\ntags:\n  - project\n  - shared\n---\n#inline and #shared\n",
    );

    expect(ObsidianApi.getAllTags(cache)).toEqual([
      "#project",
      "#shared",
      "#inline",
    ]);
  });

  it("returns null when a parsed note contains no tags", () => {
    expect(ObsidianApi.getAllTags(parseMetadata("# Heading\nNo tags."))).toBeNull();
  });
});

describe("frontmatter helpers through plugin require('obsidian')", () => {
  it("makes getFrontMatterInfo and getAllTags available to CommonJS plugins", () => {
    const PluginClass = instantiatePluginClass(
      `
        const obsidian = require("obsidian");
        module.exports = class FrontmatterProbe extends obsidian.Plugin {
          static results = {
            info: obsidian.getFrontMatterInfo("---\\ntitle: Probe\\n---\\nBody"),
            tags: obsidian.getAllTags({
              tags: [
                { tag: "frontmatter", position: {} },
                { tag: "inline", position: {} },
                { tag: "frontmatter", position: {} }
              ]
            })
          };
        };
      `,
      "frontmatter-probe",
    ) as unknown as {
      results: {
        info: unknown;
        tags: string[];
      };
    };

    expect(PluginClass.results.info).toEqual({
      exists: true,
      frontmatter: "title: Probe",
      from: 4,
      to: 16,
      contentStart: 21,
    });
    expect(PluginClass.results.tags).toEqual(["#frontmatter", "#inline"]);
  });
});
