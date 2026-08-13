import { describe, expect, it } from "vitest";
import { sortChildren } from "../../src/renderer/views/file-explorer";
import type { TAbstractFile, TFile, TFolder } from "../../src/renderer/types";

function file(name: string): TFile {
  return {
    kind: "file",
    path: name,
    name,
    basename: name.replace(/\.md$/, ""),
    extension: "md",
    mtime: 0,
    size: 0,
    parent: "",
  };
}

function folder(name: string): TFolder {
  return {
    kind: "folder",
    path: name,
    name,
    parent: "",
    children: [],
  };
}

describe("sortChildren", () => {
  it("sorts folders before files regardless of name", () => {
    const children: TAbstractFile[] = [file("Aardvark.md"), folder("Zebra"), file("Banana.md")];
    const sorted = sortChildren(children, "name-asc");
    expect(sorted.map((c) => c.name)).toEqual(["Zebra", "Aardvark.md", "Banana.md"]);
  });

  it("sorts alphabetically, case-insensitively, within each group for name-asc", () => {
    const children: TAbstractFile[] = [file("banana.md"), file("Apple.md"), folder("zoo"), folder("Attic")];
    const sorted = sortChildren(children, "name-asc");
    expect(sorted.map((c) => c.name)).toEqual(["Attic", "zoo", "Apple.md", "banana.md"]);
  });

  it("name-desc reverses the alphabetical order within each group but keeps folders first", () => {
    const children: TAbstractFile[] = [file("banana.md"), file("Apple.md"), folder("zoo"), folder("Attic")];
    const sorted = sortChildren(children, "name-desc");
    expect(sorted.map((c) => c.name)).toEqual(["zoo", "Attic", "banana.md", "Apple.md"]);
  });

  it("does not mutate the input array", () => {
    const original: TAbstractFile[] = [file("banana.md"), folder("zoo"), file("Apple.md")];
    const originalOrder = original.map((c) => c.name);
    const originalRef = original;

    const sorted = sortChildren(original, "name-asc");

    expect(original).toBe(originalRef); // same array reference
    expect(original.map((c) => c.name)).toEqual(originalOrder); // unchanged order
    expect(sorted).not.toBe(original); // a new array was returned
  });
});
