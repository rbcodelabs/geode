import { describe, expect, it } from "vitest";
import {
  columnDisplayName,
  enumerateFrontmatterKeys,
  frontmatterKeyForColumn,
  isEditableColumn,
  parseEditedValue,
  resolveColumns,
} from "../../../src/renderer/bases/columns";
import type { TFile } from "../../../src/renderer/types";

function fakeFile(path: string): TFile {
  return { kind: "file", path, name: path, basename: path, extension: "md", mtime: 0, ctime: 0, size: 0, parent: "" };
}

describe("resolveColumns", () => {
  it("falls back to file.name + all known properties when order is unset", () => {
    expect(resolveColumns(undefined, ["status", "priority"])).toEqual(["file.name", "note.status", "note.priority"]);
  });

  it("falls back the same way for an empty explicit order", () => {
    expect(resolveColumns([], ["status"])).toEqual(["file.name", "note.status"]);
  });

  it("uses the explicit order verbatim when set, ignoring known properties", () => {
    expect(resolveColumns(["file.name", "formula.total"], ["status"])).toEqual(["file.name", "formula.total"]);
  });
});

describe("columnDisplayName", () => {
  it("uses the configured displayName override when present", () => {
    const def = { properties: { "note.status": { displayName: "Status" } } };
    expect(columnDisplayName(def, "note.status")).toBe("Status");
  });

  it("falls back to the raw path when no override is configured", () => {
    const def = { properties: {} };
    expect(columnDisplayName(def, "note.status")).toBe("note.status");
  });

  it("falls back to the raw path when displayName is blank", () => {
    const def = { properties: { "note.status": { displayName: "  " } } };
    expect(columnDisplayName(def, "note.status")).toBe("note.status");
  });
});

describe("isEditableColumn / frontmatterKeyForColumn", () => {
  it("treats note.* and bare shorthand columns as editable", () => {
    expect(isEditableColumn("note.status")).toBe(true);
    expect(isEditableColumn("status")).toBe(true);
    expect(frontmatterKeyForColumn("note.status")).toBe("status");
    expect(frontmatterKeyForColumn("status")).toBe("status");
  });

  it("treats file.* and formula.* columns as non-editable", () => {
    expect(isEditableColumn("file.name")).toBe(false);
    expect(isEditableColumn("formula.total")).toBe(false);
    expect(frontmatterKeyForColumn("file.name")).toBeNull();
    expect(frontmatterKeyForColumn("formula.total")).toBeNull();
  });
});

describe("parseEditedValue", () => {
  it("coerces numeric- and boolean-shaped text", () => {
    expect(parseEditedValue("42")).toBe(42);
    expect(parseEditedValue("3.5")).toBe(3.5);
    expect(parseEditedValue("true")).toBe(true);
    expect(parseEditedValue("false")).toBe(false);
  });

  it("keeps everything else as plain text", () => {
    expect(parseEditedValue("Done")).toBe("Done");
  });

  it("treats empty/whitespace-only text as clearing the property", () => {
    expect(parseEditedValue("")).toBeUndefined();
    expect(parseEditedValue("   ")).toBeUndefined();
  });
});

describe("enumerateFrontmatterKeys", () => {
  it("dedupes and sorts keys across files, skipping files with no frontmatter", () => {
    const files = [fakeFile("a.md"), fakeFile("b.md"), fakeFile("c.md")];
    const fm: Record<string, Record<string, unknown> | null> = {
      "a.md": { status: "Done", priority: 1 },
      "b.md": { status: "Todo" },
      "c.md": null,
    };
    expect(enumerateFrontmatterKeys(files, (f) => fm[f.path])).toEqual(["priority", "status"]);
  });

  it("returns an empty list when no file has frontmatter", () => {
    expect(enumerateFrontmatterKeys([fakeFile("a.md")], () => null)).toEqual([]);
  });
});
