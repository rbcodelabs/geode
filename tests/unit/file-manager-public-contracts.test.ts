import { describe, expect, it, vi } from "vitest";
import { FileManager } from "../../src/renderer/file-manager";
import { App } from "../../src/renderer/app";
import { instantiatePluginClass } from "../../src/renderer/plugin-manager";
import type { TFile, TFolder } from "../../src/renderer/types";

const file = (path: string): TFile => {
  const name = path.split("/").pop()!;
  const dot = name.lastIndexOf(".");
  return {
    kind: "file", path, name, basename: dot < 0 ? name : name.slice(0, dot),
    extension: dot < 0 ? "" : name.slice(dot + 1), parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "",
    ctime: 0, mtime: 0, size: 0,
  };
};

const folder = (path: string): TFolder => ({
  kind: "folder", path, name: path.split("/").pop()!, parent: path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "", children: [],
});

function fakeApp() {
  return {
    vault: { rename: vi.fn(async () => {}), trash: vi.fn(async () => {}) },
    metadataCache: { fileToLinktext: vi.fn((target: TFile) => target.basename) },
    renameFileWithLinkUpdate: vi.fn(async () => {}),
  } as any;
}

describe("FileManager public foundation", () => {
  it("is wired to App with the App's vault and metadata services", () => {
    const app = new App();
    expect(app.fileManager).toBeInstanceOf(FileManager);
  });

  it("renames files through link-aware handling and folders through Vault", async () => {
    const app = fakeApp();
    const manager = new FileManager(app);
    const note = file("Old.md");
    const docs = folder("Docs");

    await manager.renameFile(note, "New.md");
    await manager.renameFile(docs, "Archive");
    expect(app.renameFileWithLinkUpdate).toHaveBeenCalledWith(note, "New.md");
    expect(app.vault.rename).toHaveBeenCalledWith(docs, "Archive");
  });

  it("trashes files and folders through the Vault trash implementation", async () => {
    const app = fakeApp();
    const manager = new FileManager(app);
    const note = file("Note.md");
    const docs = folder("Docs");

    await manager.trashFile(note);
    await manager.trashFile(docs);
    expect(app.vault.trash.mock.calls).toEqual([[note], [docs]]);
  });

  it("generates wikilinks with optional subpaths and aliases", () => {
    const app = fakeApp();
    const manager = new FileManager(app);
    const note = file("Folder/Note.md");

    expect(manager.generateMarkdownLink(note, "Source.md")).toBe("[[Note]]");
    expect(manager.generateMarkdownLink(note, "Source.md", "#Heading")).toBe("[[Note#Heading]]");
    expect(manager.generateMarkdownLink(note, "Source.md", "#Heading", "Read this")).toBe("[[Note#Heading|Read this]]");
    expect(app.metadataCache.fileToLinktext).toHaveBeenCalledWith(note, "Source.md", true);
  });
});

describe("FileManager through require('obsidian')", () => {
  it("exports the runtime class and selected methods to CommonJS plugins", async () => {
    const PluginClass = instantiatePluginClass(
      `
        const { FileManager } = require("obsidian");
        module.exports = class FileManagerProbe {
          static results = (async () => {
            const calls = [];
            const app = {
              vault: { rename: async (...args) => calls.push(["rename", ...args]), trash: async (...args) => calls.push(["trash", ...args]) },
              metadataCache: { fileToLinktext: () => "Note" },
              renameFileWithLinkUpdate: async (...args) => calls.push(["link-rename", ...args])
            };
            const manager = new FileManager(app);
            const note = { kind: "file", path: "Note.md", basename: "Note", extension: "md" };
            await manager.renameFile(note, "Moved.md");
            await manager.trashFile(note);
            return [manager.generateMarkdownLink(note, "Source.md", "#H", "Alias"), calls.map(call => call[0])];
          })();
        };
      `,
      "file-manager-probe",
    ) as unknown as { results: Promise<unknown[]> };

    await expect(PluginClass.results).resolves.toEqual(["[[Note#H|Alias]]", ["link-rename", "trash"]]);
  });
});
