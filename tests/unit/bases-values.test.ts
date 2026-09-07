import { describe, expect, it } from "vitest";
import {
  BooleanValue,
  DateValue,
  DurationValue,
  FileValue,
  HtmlValue,
  ImageValue,
  LinkValue,
  ListValue,
  NotNullValue,
  NullValue,
  NumberValue,
  ObjectValue,
  RegexpValue,
  StringValue,
  Value,
  toApiValue,
} from "../../src/renderer/api/bases-values";
import type { BaseValue } from "../../src/renderer/bases/value";
import { valueToDisplayString, isTruthy } from "../../src/renderer/bases/coerce";
import type { TFile } from "../../src/renderer/types";

/**
 * The Bases API hands views class instances, not the engine's tagged-union
 * plain objects, because views branch on them with `instanceof`. These tests
 * pin two things:
 *
 *  1. `toApiValue` is total over the engine union — every arm maps to a
 *     distinct class, so no value silently arrives as the wrong type.
 *  2. The wrappers never disagree with the engine about text or truthiness.
 *
 * `renderTo` needs real element prototypes and is therefore covered by the
 * Electron e2e harness (vitest runs the `node` environment, no jsdom).
 */

const file = {
  kind: "file",
  path: "Notes/A.md",
  name: "A.md",
  basename: "A",
  extension: "md",
  mtime: 0,
  ctime: 0,
  size: 0,
  parent: "Notes",
} as TFile;

/** One sample per arm of `BaseValue`. Kept exhaustive on purpose. */
const samples: Array<{ base: BaseValue; ctor: Function; label: string }> = [
  { base: { type: "null" }, ctor: NullValue, label: "null" },
  { base: { type: "string", value: "hi" }, ctor: StringValue, label: "string" },
  { base: { type: "number", value: 3 }, ctor: NumberValue, label: "number" },
  { base: { type: "boolean", value: true }, ctor: BooleanValue, label: "boolean" },
  { base: { type: "date", value: 1_700_000_000_000 }, ctor: DateValue, label: "date" },
  { base: { type: "duration", value: { amount: 2, unit: "d" } }, ctor: DurationValue, label: "duration" },
  { base: { type: "list", value: [{ type: "string", value: "a" }] }, ctor: ListValue, label: "list" },
  { base: { type: "object", value: { k: { type: "number", value: 1 } } }, ctor: ObjectValue, label: "object" },
  { base: { type: "link", value: { raw: "A", display: "Alpha", resolved: file } }, ctor: LinkValue, label: "link" },
  { base: { type: "file", value: file }, ctor: FileValue, label: "file" },
  { base: { type: "regexp", value: { source: "a+", flags: "i" } }, ctor: RegexpValue, label: "regexp" },
  { base: { type: "html", value: "<b>x</b>" }, ctor: HtmlValue, label: "html" },
  { base: { type: "image", value: { source: "cover.png" } }, ctor: ImageValue, label: "image" },
];

describe("toApiValue is total over the engine's value union", () => {
  it("covers every arm of BaseValue (guards against an arm being added unmapped)", () => {
    // Mirrors the union in ../bases/value.ts. If an arm is added there, this
    // list must grow too — and toApiValue's `never` check will already have
    // failed the build.
    expect(samples.map((s) => s.label)).toEqual([
      "null",
      "string",
      "number",
      "boolean",
      "date",
      "duration",
      "list",
      "object",
      "link",
      "file",
      "regexp",
      "html",
      "image",
    ]);
  });

  for (const { base, ctor, label } of samples) {
    it(`maps "${label}" to ${ctor.name} and preserves engine semantics`, () => {
      const v = toApiValue(base);
      expect(v).toBeInstanceOf(ctor);
      expect(v).toBeInstanceOf(Value);
      expect(v.toString()).toBe(valueToDisplayString(base));
      expect(v.isTruthy()).toBe(isTruthy(base));
    });
  }
});

describe("NullValue", () => {
  it("is the singleton instance every null flows through", () => {
    // The `value instanceof NullValue` check in a hosted view depends on this.
    expect(toApiValue({ type: "null" })).toBe(NullValue.value);
    expect(toApiValue({ type: "null" })).toBeInstanceOf(NullValue);
  });

  it("is falsy and stringifies empty", () => {
    expect(NullValue.value.isTruthy()).toBe(false);
    expect(NullValue.value.toString()).toBe("");
  });

  it("is NOT a NotNullValue, unlike every other arm", () => {
    expect(NullValue.value).not.toBeInstanceOf(NotNullValue);
    for (const { base, label } of samples) {
      if (label === "null") continue;
      expect(toApiValue(base)).toBeInstanceOf(NotNullValue);
    }
  });
});

describe("class relationships match the documented hierarchy", () => {
  it("LinkValue and ImageValue are StringValues", () => {
    expect(toApiValue({ type: "link", value: { raw: "A", resolved: null } })).toBeInstanceOf(StringValue);
    expect(toApiValue({ type: "image", value: { source: "x.png" } })).toBeInstanceOf(StringValue);
  });

  it("a link stringifies to its display text, falling back to the raw target", () => {
    expect(new LinkValue("A", null, "Alpha").toString()).toBe("Alpha");
    expect(new LinkValue("A", null).toString()).toBe("A");
  });
});

describe("nested values are lifted recursively", () => {
  it("wraps list items", () => {
    const v = toApiValue({
      type: "list",
      value: [{ type: "string", value: "a" }, { type: "null" }],
    }) as ListValue;
    expect(v.items[0]).toBeInstanceOf(StringValue);
    expect(v.items[1]).toBe(NullValue.value);
  });

  it("wraps object entries and returns NullValue for a missing key", () => {
    const v = toApiValue({ type: "object", value: { k: { type: "number", value: 1 } } }) as ObjectValue;
    expect(v.get("k")).toBeInstanceOf(NumberValue);
    expect(v.get("nope")).toBe(NullValue.value);
    expect(v.isEmpty()).toBe(false);
  });
});

describe("equality", () => {
  it("compares equal values of the same type", () => {
    expect(new NumberValue(1).equals(new NumberValue(1))).toBe(true);
    expect(new NumberValue(1).equals(new NumberValue(2))).toBe(false);
  });

  it("strict equals rejects a cross-type comparison that loose equals accepts", () => {
    // The engine relates a link to the file it resolves to.
    const link = new LinkValue("A", file);
    const asFile = new FileValue(file);
    expect(Value.equals(link, asFile)).toBe(false);
    expect(Value.looseEquals(link, asFile)).toBe(true);
  });

  it("handles nulls in the static helpers without throwing", () => {
    expect(Value.equals(null, null)).toBe(true);
    expect(Value.equals(null, new NumberValue(1))).toBe(false);
    expect(Value.looseEquals(new NumberValue(1), null)).toBe(false);
  });
});
