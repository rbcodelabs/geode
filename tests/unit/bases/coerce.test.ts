import { describe, expect, it } from "vitest";
import {
  add,
  compareValues,
  divide,
  isTruthy,
  modulo,
  multiply,
  negate,
  subtract,
  valueToDisplayString,
} from "../../../src/renderer/bases/coerce";
import {
  bool,
  dateValue,
  durationValue,
  fileValue,
  linkValue,
  listValue,
  nullValue,
  num,
  objectValue,
  str,
} from "../../../src/renderer/bases/value";
import type { TFile } from "../../../src/renderer/types";

function file(path: string): TFile {
  return { kind: "file", path, name: path, basename: path, extension: "md", mtime: 0, ctime: 0, size: 0, parent: "" };
}

describe("isTruthy", () => {
  it("null is falsy", () => expect(isTruthy(nullValue())).toBe(false));
  it("empty string is falsy, non-empty is truthy", () => {
    expect(isTruthy(str(""))).toBe(false);
    expect(isTruthy(str("x"))).toBe(true);
  });
  it("zero and NaN are falsy, other numbers truthy", () => {
    expect(isTruthy(num(0))).toBe(false);
    expect(isTruthy(num(NaN))).toBe(false);
    expect(isTruthy(num(1))).toBe(true);
    expect(isTruthy(num(-1))).toBe(true);
  });
  it("boolean passes through", () => {
    expect(isTruthy(bool(true))).toBe(true);
    expect(isTruthy(bool(false))).toBe(false);
  });
  it("date and duration are always truthy", () => {
    expect(isTruthy(dateValue(0))).toBe(true);
    expect(isTruthy(durationValue(0, "d"))).toBe(true);
  });
  it("list/object truthy iff non-empty", () => {
    expect(isTruthy(listValue([]))).toBe(false);
    expect(isTruthy(listValue([num(1)]))).toBe(true);
    expect(isTruthy(objectValue({}))).toBe(false);
    expect(isTruthy(objectValue({ a: num(1) }))).toBe(true);
  });
  it("link/file/regexp/html/image are always truthy", () => {
    expect(isTruthy(fileValue(file("A.md")))).toBe(true);
    expect(isTruthy(linkValue("A", null))).toBe(true);
  });
});

describe("valueToDisplayString", () => {
  it("renders primitives", () => {
    expect(valueToDisplayString(nullValue())).toBe("");
    expect(valueToDisplayString(str("hi"))).toBe("hi");
    expect(valueToDisplayString(num(5))).toBe("5");
    expect(valueToDisplayString(bool(true))).toBe("true");
  });
  it("renders a list by joining display strings", () => {
    expect(valueToDisplayString(listValue([num(1), str("a")]))).toBe("1, a");
  });
  it("renders a link by display text, falling back to raw", () => {
    expect(valueToDisplayString(linkValue("Target", null, "Shown"))).toBe("Shown");
    expect(valueToDisplayString(linkValue("Target", null))).toBe("Target");
  });
  it("renders a file by path", () => {
    expect(valueToDisplayString(fileValue(file("Notes/A.md")))).toBe("Notes/A.md");
  });
});

describe("compareValues: equality", () => {
  it("same-type equality is value-based", () => {
    expect(compareValues(num(1), num(1), "==")).toEqual(bool(true));
    expect(compareValues(str("a"), str("b"), "==")).toEqual(bool(false));
    expect(compareValues(dateValue(5), dateValue(5), "==")).toEqual(bool(true));
  });

  it("cross-type equality is always false (and != is true), never throws", () => {
    expect(compareValues(num(1), str("1"), "==")).toEqual(bool(false));
    expect(compareValues(num(1), str("1"), "!=")).toEqual(bool(true));
    expect(() => compareValues(listValue([]), objectValue({}), "==")).not.toThrow();
  });

  it("link == file / file == link compares resolved target identity", () => {
    const f = file("Target.md");
    expect(compareValues(linkValue("Target", f), fileValue(f), "==")).toEqual(bool(true));
    expect(compareValues(fileValue(f), linkValue("Target", f), "==")).toEqual(bool(true));
    expect(compareValues(linkValue("Other", null), fileValue(f), "==")).toEqual(bool(false));
  });

  it("lists/objects compare by deep equality", () => {
    expect(compareValues(listValue([num(1), num(2)]), listValue([num(1), num(2)]), "==")).toEqual(bool(true));
    expect(compareValues(listValue([num(1)]), listValue([num(1), num(2)]), "==")).toEqual(bool(false));
    expect(compareValues(objectValue({ a: num(1) }), objectValue({ a: num(1) }), "==")).toEqual(bool(true));
    expect(compareValues(objectValue({ a: num(1) }), objectValue({ a: num(2) }), "==")).toEqual(bool(false));
  });
});

describe("compareValues: ordering", () => {
  it("numeric ordering for numbers and dates", () => {
    expect(compareValues(num(1), num(2), "<")).toEqual(bool(true));
    expect(compareValues(dateValue(5), dateValue(2), ">")).toEqual(bool(true));
    expect(compareValues(num(2), num(2), ">=")).toEqual(bool(true));
    expect(compareValues(num(2), num(2), "<=")).toEqual(bool(true));
  });

  it("lexicographic ordering for strings", () => {
    expect(compareValues(str("a"), str("b"), "<")).toEqual(bool(true));
    expect(compareValues(str("b"), str("a"), ">")).toEqual(bool(true));
  });

  it("returns a null BaseValue for non-orderable types (collapses to false via isTruthy)", () => {
    const result = compareValues(listValue([]), listValue([]), "<");
    expect(result).toEqual(nullValue());
    expect(isTruthy(result)).toBe(false);
  });
});

describe("arithmetic coercion", () => {
  it("add: numeric addition", () => {
    expect(add(num(1), num(2))).toEqual(num(3));
  });

  it("add: date + duration produces a date", () => {
    const base = dateValue(Date.UTC(2025, 0, 1));
    const result = add(base, durationValue(1, "d"));
    expect(result.type).toBe("date");
    expect((result as { type: "date"; value: number }).value).toBeGreaterThan(base.value as number);
  });

  it("add: date + string-shaped-duration", () => {
    const base = dateValue(Date.UTC(2025, 0, 1));
    const result = add(base, str("1M"));
    expect(result.type).toBe("date");
  });

  it("add: string concatenation via display-string conversion", () => {
    expect(add(str("a"), str("b"))).toEqual(str("ab"));
    expect(add(str("Count: "), num(5))).toEqual(str("Count: 5"));
  });

  it("add: unsupported combination returns null", () => {
    expect(add(bool(true), bool(false))).toEqual(nullValue());
  });

  it("subtract: numeric subtraction", () => {
    expect(subtract(num(5), num(2))).toEqual(num(3));
  });

  it("subtract: date - date produces a duration", () => {
    const a = dateValue(Date.UTC(2025, 0, 2));
    const b = dateValue(Date.UTC(2025, 0, 1));
    const result = subtract(a, b);
    expect(result.type).toBe("duration");
  });

  it("subtract: date - duration produces a date", () => {
    const base = dateValue(Date.UTC(2025, 0, 10));
    const result = subtract(base, durationValue(2, "h"));
    expect(result.type).toBe("date");
  });

  it("multiply/divide/modulo: numeric only, else null", () => {
    expect(multiply(num(3), num(4))).toEqual(num(12));
    expect(divide(num(10), num(4))).toEqual(num(2.5));
    expect(modulo(num(10), num(3))).toEqual(num(1));
    expect(multiply(str("x"), num(2))).toEqual(nullValue());
  });

  it("negate: numbers and durations", () => {
    expect(negate(num(5))).toEqual(num(-5));
    expect(negate(durationValue(2, "d"))).toEqual(durationValue(-2, "d"));
    expect(negate(str("x"))).toEqual(nullValue());
  });
});
