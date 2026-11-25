import { describe, expect, it } from "vitest";
import { resolveEmbed } from "../../src/renderer/markdown/embed";
import type { App } from "../../src/renderer/app";
import type { TFile } from "../../src/renderer/types";

function fakeApp(files: Record<string, TFile>): App {
  return {
    metadataCache: {
      getFirstLinkpathDest(linkpath: string) {
        const clean = linkpath.split("#")[0];
        return files[clean] ?? null;
      },
    },
  } as unknown as App;
}

function fakeFile(filePath: string): TFile {
  const parts = filePath.split("/");
  const name = parts[parts.length - 1];
  const dot = name.lastIndexOf(".");
  const basename = dot === -1 ? name : name.slice(0, dot);
  const extension = dot === -1 ? "" : name.slice(dot + 1);
  return {
    path: filePath,
    name,
    basename,
    extension,
    parent: parts.slice(0, -1).join("/"),
  } as TFile;
}

describe("resolveEmbed artifact.json detection", () => {
  it("recognizes artifact.json without a subpath", () => {
    const file = fakeFile("Artifacts/threads-artifacts/pricing/artifact.json");
    const resolved = resolveEmbed(file.path, "Artifacts/threads-artifacts/pricing/board.canvas", fakeApp({ [file.path]: file }));
    expect(resolved).toEqual({ kind: "artifact", file, subpath: "" });
  });

  it("recognizes artifact.json with a #subpath screen entry", () => {
    const file = fakeFile("Artifacts/threads-artifacts/pricing/artifact.json");
    const resolved = resolveEmbed(
      `${file.path}#screens/mobile.html`,
      "Artifacts/threads-artifacts/pricing/board.canvas",
      fakeApp({ [file.path]: file }),
    );
    expect(resolved).toEqual({ kind: "artifact", file, subpath: "#screens/mobile.html" });
  });

  it("keeps ordinary json files as kind 'other'", () => {
    const file = fakeFile("data/config.json");
    const resolved = resolveEmbed(file.path, "board.canvas", fakeApp({ [file.path]: file }));
    expect(resolved).toEqual({ kind: "other", file, subpath: "" });
  });
});
