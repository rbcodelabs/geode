import { describe, expect, it } from "vitest";
import { MetadataCache, parseMetadata } from "../../src/renderer/metadata-cache";
import { FakeVault } from "../helpers/fake-vault";

// These are compatibility observations, including gaps; they are not the
// stricter agent-facing semantics proposed for the subsequent engine phase.
describe("headless extraction compatibility baseline", () => {
  it("preserves CRLF locations, aliases, tags, embeds and task block IDs", () => {
    const source = "---\r\naliases: [Guide]\r\ntags: [wiki]\r\n---\r\n# Plan\r\n[[Target#Details|read]] ![[asset.png]] #body\r\n- [x] task ^done\r\n";
    const metadata = parseMetadata(source);
    expect(metadata.aliases).toEqual(["Guide"]);
    expect(metadata.tags.map(({ tag }) => tag)).toEqual(["wiki", "body"]);
    expect(metadata.links.map(({ link }) => link)).toEqual(["Target#Details"]);
    const { start, end } = metadata.links[0].position;
    expect(source.slice(start.offset, end.offset)).toBe("[[Target#Details|read]]");
    expect(start.line).toBe(5);
    expect(metadata.embeds[0].link).toBe("asset.png");
    // Existing heading regexp does not accept the trailing CR.
    expect(metadata.headings).toEqual([]);
    expect(parseMetadata(source.replaceAll("\r\n", "\n")).headings[0].heading).toBe("Plan");
    expect(metadata.listItems?.[0]).toMatchObject({ task: "x", id: "done" });
  });

  it("characterizes code masking and the existing tilde-fence gap", () => {
    const metadata = parseMetadata("`[[inline]]`\n```md\n[[backticks]]\n```\n~~~md\n[[tilde]]\n~~~\n[[visible]]");
    expect(metadata.links.map(({ link }) => link)).toEqual(["tilde", "visible"]);
  });

  it("characterizes inline Markdown links and malformed YAML without rewriting bytes", () => {
    const source = "---\naliases: [broken\n---\n[local](Target.md) [[Wiki]]";
    const metadata = parseMetadata(source);
    expect(metadata.frontmatter).toBeUndefined();
    expect(metadata.frontmatterEndOffset).toBe(0);
    expect(metadata.links.map(({ link }) => link)).toEqual(["Wiki"]);
  });

  it("retains frontmatter but omits body metadata above the string-length scan cap", () => {
    const metadata = parseMetadata("---\naliases: [Guide]\n---\n[[Target]]", 5);
    expect(metadata.aliases).toEqual(["Guide"]);
    expect(metadata.links).toEqual([]);
    expect(metadata.sections).toBeUndefined();
  });

  it("characterizes exact, relative, basename, alias, self and missing resolution", async () => {
    const vault = new FakeVault({
      "Target.md": "",
      "folder/Source.md": "",
      "folder/Local.md": "",
      "a/Twin.md": "",
      "b/Twin.md": "",
      "Alias.md": "---\naliases: [Other]\n---\n",
    });
    const cache = new MetadataCache(vault.asVault());
    await cache.initialize();
    const resolve = (target: string) => cache.getFirstLinkpathDest(target, "folder/Source.md")?.path ?? null;
    expect(resolve("Target#MissingHeading")).toBe("Target.md");
    expect(resolve("Local")).toBe("folder/Local.md");
    expect(resolve("Twin")).toBe("a/Twin.md");
    expect(resolve("Other")).toBe("Alias.md");
    expect(resolve("#Heading")).toBe("folder/Source.md");
    expect(resolve("absent")).toBeNull();
    expect(resolve("../Target")).toBeNull();
  });
});
