import { describe, expect, it } from "vitest";
import { normalizePath, TFileClass, TFolderClass } from "../../src/renderer/types";
import type { TFile, TFolder } from "../../src/renderer/types";

/**
 * Pure-logic coverage for the Obsidian-compat primitives that don't need a
 * DOM (those are exercised by the Electron e2e harness). `normalizePath` and
 * the `instanceof`-via-`Symbol.hasInstance` behaviour are what hosted plugins
 * like Claude Threads rely on for path handling and file-type checks.
 */

describe("normalizePath", () => {
  it("converts backslashes to forward slashes", () => {
    expect(normalizePath("foo\\bar\\baz.md")).toBe("foo/bar/baz.md");
  });
  it("collapses duplicate slashes", () => {
    expect(normalizePath("foo//bar///baz")).toBe("foo/bar/baz");
  });
  it("strips a leading ./ and leading/trailing slashes", () => {
    expect(normalizePath("./foo/bar/")).toBe("foo/bar");
    expect(normalizePath("/foo/bar/")).toBe("foo/bar");
  });
  it("returns '/' for an empty or root path", () => {
    expect(normalizePath("")).toBe("/");
    expect(normalizePath("/")).toBe("/");
  });
});

describe("TFile / TFolder instanceof", () => {
  const file = { kind: "file", path: "A.md", name: "A.md", basename: "A", extension: "md", mtime: 0, ctime: 0, size: 0, parent: "" } as TFile;
  const folder = { kind: "folder", path: "Sub", name: "Sub", parent: "", children: [] } as TFolder;

  it("recognizes a Geode file object as an instanceof TFile (via Symbol.hasInstance)", () => {
    expect(file instanceof (TFileClass as any)).toBe(true);
    expect(folder instanceof (TFileClass as any)).toBe(false);
  });

  it("recognizes a Geode folder object as an instanceof TFolder", () => {
    expect(folder instanceof (TFolderClass as any)).toBe(true);
    expect(file instanceof (TFolderClass as any)).toBe(false);
  });

  it("does not treat null/undefined/plain objects as either", () => {
    expect((null as any) instanceof (TFileClass as any)).toBe(false);
    expect((undefined as any) instanceof (TFolderClass as any)).toBe(false);
    expect(({} as any) instanceof (TFileClass as any)).toBe(false);
  });
});
