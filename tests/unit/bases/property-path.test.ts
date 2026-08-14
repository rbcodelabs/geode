import { describe, expect, it } from "vitest";
import { frontmatterValueToBaseValue, resolvePropertyPath } from "../../../src/renderer/bases/property-path";
import { bool, listValue, nullValue, num, objectValue, str } from "../../../src/renderer/bases/value";
import { buildContext } from "./helpers";

describe("resolvePropertyPath: note/shorthand", () => {
  it("resolves a shorthand identifier to note.<name> via frontmatter", async () => {
    const { ctx } = await buildContext({ "A.md": "---\nstatus: active\n---\n" }, "A.md");
    expect(resolvePropertyPath({ root: "shorthand", segments: ["status"] }, ctx)).toEqual(str("active"));
    expect(resolvePropertyPath({ root: "note", segments: ["status"] }, ctx)).toEqual(str("active"));
  });

  it("returns null for a missing frontmatter property", async () => {
    const { ctx } = await buildContext({ "A.md": "---\nstatus: active\n---\n" }, "A.md");
    expect(resolvePropertyPath({ root: "note", segments: ["missing"] }, ctx)).toEqual(nullValue());
  });

  it("returns null when the file has no frontmatter at all", async () => {
    const { ctx } = await buildContext({ "A.md": "no frontmatter here" }, "A.md");
    expect(resolvePropertyPath({ root: "note", segments: ["status"] }, ctx)).toEqual(nullValue());
  });

  it("walks nested frontmatter objects via dot-notation member lookup", async () => {
    const { ctx } = await buildContext({ "A.md": "---\nauthor:\n  name: Ada\n  age: 30\n---\n" }, "A.md");
    expect(resolvePropertyPath({ root: "note", segments: ["author", "name"] }, ctx)).toEqual(str("Ada"));
    expect(resolvePropertyPath({ root: "note", segments: ["author", "age"] }, ctx)).toEqual(num(30));
    expect(resolvePropertyPath({ root: "note", segments: ["author", "missing"] }, ctx)).toEqual(nullValue());
  });

  it("coerces frontmatter arrays to lists and booleans/numbers to their type", async () => {
    const { ctx } = await buildContext(
      { "A.md": "---\ntags: [a, b]\ncount: 3\ndone: true\n---\n" },
      "A.md"
    );
    expect(resolvePropertyPath({ root: "note", segments: ["tags"] }, ctx)).toEqual(listValue([str("a"), str("b")]));
    expect(resolvePropertyPath({ root: "note", segments: ["count"] }, ctx)).toEqual(num(3));
    expect(resolvePropertyPath({ root: "note", segments: ["done"] }, ctx)).toEqual(bool(true));
  });

  it("checks ctx.locals first for shorthand roots (lambda/summary variable shadowing)", async () => {
    const { ctx } = await buildContext({ "A.md": "---\nvalue: fromFrontmatter\n---\n" }, "A.md");
    ctx.locals.value = str("fromLocal");
    expect(resolvePropertyPath({ root: "shorthand", segments: ["value"] }, ctx)).toEqual(str("fromLocal"));
  });
});

describe("resolvePropertyPath: file", () => {
  it("resolves basic file fields", async () => {
    const { ctx } = await buildContext({ "Notes/A.md": "hello" }, "Notes/A.md");
    expect(resolvePropertyPath({ root: "file", segments: ["name"] }, ctx)).toEqual(str("A.md"));
    expect(resolvePropertyPath({ root: "file", segments: ["basename"] }, ctx)).toEqual(str("A"));
    expect(resolvePropertyPath({ root: "file", segments: ["path"] }, ctx)).toEqual(str("Notes/A.md"));
    expect(resolvePropertyPath({ root: "file", segments: ["folder"] }, ctx)).toEqual(str("Notes"));
    expect(resolvePropertyPath({ root: "file", segments: ["ext"] }, ctx)).toEqual(str("md"));
  });

  it("resolves size/ctime/mtime", async () => {
    const { ctx, file } = await buildContext({ "A.md": "hello world" }, "A.md");
    expect(resolvePropertyPath({ root: "file", segments: ["size"] }, ctx)).toEqual(num(file.size));
    expect(resolvePropertyPath({ root: "file", segments: ["ctime"] }, ctx).type).toBe("date");
    expect(resolvePropertyPath({ root: "file", segments: ["mtime"] }, ctx).type).toBe("date");
  });

  it("resolves tags from the file's cached metadata", async () => {
    const { ctx } = await buildContext({ "A.md": "---\ntags: [one, two]\n---\nbody" }, "A.md");
    expect(resolvePropertyPath({ root: "file", segments: ["tags"] }, ctx)).toEqual(listValue([str("one"), str("two")]));
  });

  it("resolves links as a list of Link values", async () => {
    const { ctx } = await buildContext(
      { "A.md": "See [[B]]", "B.md": "target" },
      "A.md"
    );
    const result = resolvePropertyPath({ root: "file", segments: ["links"] }, ctx);
    expect(result.type).toBe("list");
    if (result.type === "list") {
      expect(result.value).toHaveLength(1);
      expect(result.value[0].type).toBe("link");
    }
  });

  it("resolves properties as an object of all frontmatter", async () => {
    const { ctx } = await buildContext({ "A.md": "---\na: 1\nb: two\n---\n" }, "A.md");
    expect(resolvePropertyPath({ root: "file", segments: ["properties"] }, ctx)).toEqual(
      objectValue({ a: num(1), b: str("two") })
    );
  });

  it("resolves file.file to a file BaseValue", async () => {
    const { ctx, file } = await buildContext({ "A.md": "x" }, "A.md");
    const result = resolvePropertyPath({ root: "file", segments: ["file"] }, ctx);
    expect(result).toEqual({ type: "file", value: file });
  });

  it("returns null for an unknown file field", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    expect(resolvePropertyPath({ root: "file", segments: ["notAField"] }, ctx)).toEqual(nullValue());
  });

  it("resolves bare 'file' (zero segments) to a file BaseValue for the current file", async () => {
    // This is the shape `file.hasTag("x")` parses to: methodCall wrapping
    // propertyPath(root:"file", segments:[]) — the target must be the
    // current file itself, not null, or every file.<method>(...) call
    // (hasTag/hasLink/hasProperty/inFolder/asLink) is silently broken.
    const { ctx, file } = await buildContext({ "A.md": "x" }, "A.md");
    expect(resolvePropertyPath({ root: "file", segments: [] }, ctx)).toEqual({ type: "file", value: file });
  });

  it("resolves bare 'this' (zero segments) to a file BaseValue for ctx.thisFile, or null if unset", async () => {
    const { ctx, vault } = await buildContext({ "A.md": "x", "B.md": "y" }, "A.md");
    const thisFile = vault.getFileByPath("B.md")!;
    ctx.thisFile = thisFile;
    expect(resolvePropertyPath({ root: "this", segments: [] }, ctx)).toEqual({ type: "file", value: thisFile });
    ctx.thisFile = null;
    expect(resolvePropertyPath({ root: "this", segments: [] }, ctx)).toEqual(nullValue());
  });

  it("walks a date field's remaining segment (e.g. mtime.year) via dispatchMethod", async () => {
    const now = new Date(2025, 5, 15).getTime();
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md", { now });
    // mtime comes from the fake vault's Date.now() at fixture creation time, so just assert the shape resolves.
    const result = resolvePropertyPath({ root: "file", segments: ["mtime", "year"] }, ctx);
    expect(result.type).toBe("number");
  });
});

describe("resolvePropertyPath: this", () => {
  it("resolves this.<field> against ctx.thisFile", async () => {
    const { ctx, vault } = await buildContext({ "A.md": "x", "B.md": "y" }, "A.md");
    const thisFile = vault.getFileByPath("B.md")!;
    ctx.thisFile = thisFile;
    expect(resolvePropertyPath({ root: "this", segments: ["name"] }, ctx)).toEqual(str("B.md"));
  });

  it("returns null for every field when ctx.thisFile is null", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    ctx.thisFile = null;
    expect(resolvePropertyPath({ root: "this", segments: ["name"] }, ctx)).toEqual(nullValue());
  });
});

describe("resolvePropertyPath: formula", () => {
  it("delegates to evaluateFormula for formula.<name>", async () => {
    const { ctx } = await buildContext({ "A.md": "---\nprice: 10\n---\n" }, "A.md", {
      formulas: { doubled: { kind: "binary", op: "*", left: { kind: "propertyPath", root: "note", segments: ["price"] }, right: { kind: "literal", value: 2 } } },
    });
    expect(resolvePropertyPath({ root: "formula", segments: ["doubled"] }, ctx)).toEqual(num(20));
  });

  it("returns null for an unknown formula name", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    expect(resolvePropertyPath({ root: "formula", segments: ["nope"] }, ctx)).toEqual(nullValue());
  });
});

describe("frontmatterValueToBaseValue: link auto-recognition", () => {
  it("recognizes a [[wikilink]]-shaped string as a link", async () => {
    const { ctx } = await buildContext({ "A.md": "x", "Target.md": "y" }, "A.md");
    const result = frontmatterValueToBaseValue("[[Target]]", ctx);
    expect(result.type).toBe("link");
    if (result.type === "link") {
      expect(result.value.raw).toBe("Target");
      expect(result.value.resolved?.path).toBe("Target.md");
    }
  });

  it("recognizes the [[target|display]] alias form", async () => {
    const { ctx } = await buildContext({ "A.md": "x", "Target.md": "y" }, "A.md");
    const result = frontmatterValueToBaseValue("[[Target|Shown]]", ctx);
    expect(result.type).toBe("link");
    if (result.type === "link") expect(result.value.display).toBe("Shown");
  });

  it("leaves an unresolvable wikilink as a link with resolved: null", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    const result = frontmatterValueToBaseValue("[[Nowhere]]", ctx);
    expect(result).toEqual({ type: "link", value: { raw: "Nowhere", display: undefined, resolved: null } });
  });

  it("leaves a date-shaped plain string as a string (see phase report: yaml core schema doesn't produce Date)", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    expect(frontmatterValueToBaseValue("2025-06-01", ctx)).toEqual(str("2025-06-01"));
  });

  it("special-cases a native JS Date instance defensively", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    const d = new Date(2025, 0, 1);
    expect(frontmatterValueToBaseValue(d, ctx)).toEqual({ type: "date", value: d.getTime() });
  });

  it("coerces null/undefined to nullValue()", async () => {
    const { ctx } = await buildContext({ "A.md": "x" }, "A.md");
    expect(frontmatterValueToBaseValue(null, ctx)).toEqual(nullValue());
    expect(frontmatterValueToBaseValue(undefined, ctx)).toEqual(nullValue());
  });
});
