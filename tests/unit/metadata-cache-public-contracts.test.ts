import { describe, expect, it, vi } from "vitest";
import { FakeVault } from "../helpers/fake-vault";
import { MetadataCache } from "../../src/renderer/metadata-cache";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";

async function settleMetadataEvents(): Promise<void> {
  await Promise.resolve();
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe("MetadataCache public contracts", () => {
  it("looks up cached metadata by file or vault path", async () => {
    const vault = new FakeVault({ "Note.md": "# Heading\n[[Target]]", "Target.md": "target" });
    const metadata = new MetadataCache(vault.asVault());
    await metadata.initialize();

    const file = vault.getFileByPath("Note.md")!;
    expect(metadata.getCache("Note.md")).toBe(metadata.getFileCache(file));
    expect(metadata.getCache("Note.md")?.headings[0]?.heading).toBe("Heading");
    expect(metadata.getCache("Missing.md")).toBeNull();
  });

  it("uses a filename for unique files and a full path for duplicate filenames", async () => {
    const vault = new FakeVault({
      "Unique.md": "",
      "A/Duplicate.md": "",
      "B/Duplicate.md": "",
      "Source.md": "",
    });
    const metadata = new MetadataCache(vault.asVault());
    await metadata.initialize();
    const source = "Source.md";

    expect(metadata.fileToLinktext(vault.getFileByPath("Unique.md")!, source)).toBe("Unique.md");
    expect(metadata.fileToLinktext(vault.getFileByPath("Unique.md")!, source, true)).toBe("Unique");
    expect(metadata.fileToLinktext(vault.getFileByPath("A/Duplicate.md")!, source)).toBe("A/Duplicate.md");
    expect(metadata.fileToLinktext(vault.getFileByPath("A/Duplicate.md")!, source, true)).toBe("A/Duplicate");
  });

  it("exposes resolved and unresolved link counts as records", async () => {
    const vault = new FakeVault({
      "Source.md": "[[Target]] [[Target]] [[Missing]]",
      "Target.md": "",
    });
    const metadata = new MetadataCache(vault.asVault());
    await metadata.initialize();

    expect(metadata.resolvedLinks["Source.md"]["Target.md"]).toBe(2);
    expect(metadata.unresolvedLinks["Source.md"]["Missing"]).toBe(1);
  });

  it("safely represents source and target keys that collide with Map and object members", async () => {
    const vault = new FakeVault({
      get: "[[get]] [[set]] [[clear]] [[__proto__]]",
      set: "[[Missing]]",
      clear: "",
      ["__proto__"]: "",
    });
    // Exercise the record projection independently of extension filtering so
    // every legal string key collides at both nesting levels.
    vault.getMarkdownFiles = () => vault.getFiles();
    const metadata = new MetadataCache(vault.asVault());
    await metadata.initialize();

    expect(Object.getPrototypeOf(metadata.resolvedLinks)).toBeNull();
    expect(Object.getPrototypeOf(metadata.resolvedLinks.get)).toBeNull();
    for (const key of ["get", "set", "clear", "__proto__"]) expect(metadata.resolvedLinks.get[key]).toBe(1);
    expect(metadata.unresolvedLinks.set.Missing).toBe(1);
    for (const key of ["get", "set", "clear", "__proto__"]) {
      expect(Object.prototype.hasOwnProperty.call(metadata.resolvedLinks, key)).toBe(true);
    }
  });

  it("emits documented resolution, change, deletion, and resolved event payloads", async () => {
    const vault = new FakeVault({ "Note.md": "# Old", "Target.md": "" });
    const metadata = new MetadataCache(vault.asVault());
    const resolve = vi.fn();
    const resolved = vi.fn();
    const changed = vi.fn();
    const deleted = vi.fn();
    metadata.on("resolve", resolve);
    metadata.on("resolved", resolved);
    metadata.on("changed", changed);
    metadata.on("deleted", deleted);

    await metadata.initialize();
    expect(resolve.mock.calls.map(([file]) => file.path).sort()).toEqual(["Note.md", "Target.md"]);
    expect(resolved).toHaveBeenCalledOnce();

    vault.setFile("Note.md", "# New");
    const modified = vault.getFileByPath("Note.md")!;
    vault.trigger("modify", modified);
    await settleMetadataEvents();
    expect(changed).toHaveBeenCalledOnce();
    expect(changed).toHaveBeenCalledWith(modified, "# New", metadata.getFileCache(modified));
    expect(resolve).toHaveBeenLastCalledWith(modified);
    expect(resolved).toHaveBeenCalledTimes(2);

    changed.mockClear();
    const oldPath = modified.path;
    vault.removeFile(oldPath);
    vault.setFile("Renamed.md", "# New");
    const renamed = vault.getFileByPath("Renamed.md")!;
    vault.trigger("rename", renamed, oldPath);
    await settleMetadataEvents();
    expect(changed).not.toHaveBeenCalled();

    const previousCache = metadata.getFileCache(renamed);
    vault.removeFile("Renamed.md");
    vault.trigger("delete", renamed);
    await settleMetadataEvents();
    expect(deleted).toHaveBeenCalledWith(renamed, previousCache);
    expect(resolved).toHaveBeenCalledTimes(4);
  });
});

describe("MetadataCache through plugin require('obsidian')", () => {
  it("exposes the selected public foundation to CommonJS plugins", async () => {
    const PluginClass = instantiatePluginClass(
      `
        const { MetadataCache } = require("obsidian");
        module.exports = class MetadataProbe {
          static results = (async () => {
            const files = new Map([
              ["Source.md", "[[Target]] [[Missing]]"],
              ["Target.md", ""]
            ]);
            const toFile = (path) => ({
              kind: "file", path, name: path, basename: path.replace(/\\.md$/, ""),
              extension: "md", mtime: 1, ctime: 1, size: files.get(path).length, parent: ""
            });
            const vault = {
              on() { return () => {}; },
              getFiles() { return [...files.keys()].map(toFile); },
              getMarkdownFiles() { return this.getFiles(); },
              getFileByPath(path) { return files.has(path) ? toFile(path) : null; },
              cachedRead(file) { return Promise.resolve(files.get(file.path)); },
              getCachedContent(path) { return files.get(path); },
              primeCachedContent() {}
            };
            const metadata = new MetadataCache(vault);
            await metadata.initialize();
            return [
              metadata.getCache("Source.md").links.length,
              metadata.fileToLinktext(toFile("Target.md"), "Source.md", true),
              metadata.resolvedLinks["Source.md"]["Target.md"],
              metadata.unresolvedLinks["Source.md"]["Missing"]
            ];
          })();
        };
      `,
      "metadata-probe",
    ) as unknown as { results: Promise<unknown[]> };

    await expect(PluginClass.results).resolves.toEqual([2, "Target", 1, 1]);
  });
});
