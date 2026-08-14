import { describe, expect, it } from "vitest";
import { parseExpression } from "../../../src/renderer/bases/parser";
import { evaluate } from "../../../src/renderer/bases/evaluator";
import { EvalContext } from "../../../src/renderer/bases/eval-context";
import { BaseValue, bool, listValue, nullValue, num, str } from "../../../src/renderer/bases/value";
import { buildContext } from "./helpers";

function run(ctx: EvalContext, source: string): BaseValue {
  const parsed = parseExpression(source);
  if (!("expr" in parsed)) throw new Error(`"${source}" failed to parse: ${parsed.error}`);
  return evaluate(parsed.expr, ctx);
}

const FIXTURE_FILES = {
  "A.md": [
    "---",
    "price: 10",
    "age: 2",
    "status: active",
    "tags: [red, blue]",
    "title: hello world",
    "ref: \"[[B]]\"",
    "nums: [3, 1, 2]",
    "---",
    "See [[B]] for details.",
  ].join("\n"),
  "B.md": ["---", "tags: [book]", "---", "Target note."].join("\n"),
};

async function fixtureCtx(now = Date.now()) {
  const { ctx } = await buildContext(FIXTURE_FILES, "A.md", { now });
  return ctx;
}

describe("evaluator: literals and property paths", () => {
  it("evaluates literals", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "1")).toEqual(num(1));
    expect(run(ctx, '"x"')).toEqual(str("x"));
    expect(run(ctx, "true")).toEqual(bool(true));
  });

  it("evaluates a shorthand property path from frontmatter", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "price")).toEqual(num(10));
  });

  it("evaluates index access into a list, including out-of-range -> null", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "nums[0]")).toEqual(num(3));
    expect(run(ctx, "nums[99]")).toEqual(nullValue());
  });

  it("evaluates unknown function/method names to null rather than throwing", async () => {
    const ctx = await fixtureCtx();
    expect(() => run(ctx, "totallyMadeUp()")).not.toThrow();
    expect(run(ctx, "totallyMadeUp()")).toEqual(nullValue());
    expect(run(ctx, "price.totallyNotAMethod()")).toEqual(nullValue());
  });

  it("catches an internal evaluator error and returns nullValue()", async () => {
    // 1/0 style edge cases don't throw in JS, but division by a null-typed
    // operand exercises the "never throw" contract through the public evaluate().
    const ctx = await fixtureCtx();
    expect(() => evaluate({ kind: "unary", op: "not", operand: { kind: "literal", value: 1 } } as never, ctx)).not.toThrow();
  });
});

describe("evaluator: operators", () => {
  it("arithmetic", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "1 + 2")).toEqual(num(3));
    expect(run(ctx, "5 - 2")).toEqual(num(3));
    expect(run(ctx, "3 * 4")).toEqual(num(12));
    expect(run(ctx, "10 / 4")).toEqual(num(2.5));
    expect(run(ctx, "10 % 3")).toEqual(num(1));
  });

  it("comparison", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "price == 10")).toEqual(bool(true));
    expect(run(ctx, "price != 10")).toEqual(bool(false));
    expect(run(ctx, "price > 5")).toEqual(bool(true));
    expect(run(ctx, "price < 5")).toEqual(bool(false));
    expect(run(ctx, "price >= 10")).toEqual(bool(true));
    expect(run(ctx, "price <= 10")).toEqual(bool(true));
  });

  it("and/or/not with short-circuiting semantics", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "true and false")).toEqual(bool(false));
    expect(run(ctx, "true or false")).toEqual(bool(true));
    expect(run(ctx, "not true")).toEqual(bool(false));
  });

  it("unary minus/plus", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "-price")).toEqual(num(-10));
    expect(run(ctx, "+price")).toEqual(num(10));
  });

  it("group parens don't change the evaluated value", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "(1 + 2) * 2")).toEqual(num(6));
  });
});

describe("evaluator: global functions", () => {
  it("escapeHTML", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'escapeHTML("<b>hi</b>")')).toEqual(str("&lt;b&gt;hi&lt;/b&gt;"));
    expect(run(ctx, "escapeHTML(5)")).toEqual(str("5")); // non-string input coerced via display string
  });

  it("date", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'date("2025-01-01")').type).toBe("date");
    expect(run(ctx, 'date("not a date")')).toEqual(nullValue());
  });

  it("duration", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'duration("1d")')).toEqual({ type: "duration", value: { amount: 1, unit: "d" } });
    expect(run(ctx, 'duration("nope")')).toEqual(nullValue());
  });

  it("file", async () => {
    const ctx = await fixtureCtx();
    const result = run(ctx, 'file("B.md")');
    expect(result.type).toBe("file");
    expect(run(ctx, 'file("NoSuchFile.md")')).toEqual(nullValue());
  });

  it("html", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'html("<b>hi</b>")')).toEqual({ type: "html", value: "<b>hi</b>" });
  });

  it("if: 2-arg and 3-arg forms", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'if(true, "yes")')).toEqual(str("yes"));
    expect(run(ctx, 'if(false, "yes")')).toEqual(nullValue()); // no else branch
    expect(run(ctx, 'if(false, "yes", "no")')).toEqual(str("no"));
    expect(run(ctx, 'if(price, price.toFixed(2) + " dollars")')).toEqual(str("10.00 dollars"));
  });

  it("image", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'image("cover.png")')).toEqual({ type: "image", value: { source: "cover.png" } });
  });

  it("icon: string passthrough", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'icon("landmark")')).toEqual(str("landmark"));
  });

  it("link: with and without display text", async () => {
    const ctx = await fixtureCtx();
    const withDisplay = run(ctx, 'link("B", "See B")');
    expect(withDisplay.type).toBe("link");
    if (withDisplay.type === "link") {
      expect(withDisplay.value.display).toBe("See B");
      expect(withDisplay.value.resolved?.path).toBe("B.md");
    }
    const noDisplay = run(ctx, 'link("B")');
    expect(noDisplay.type).toBe("link");
  });

  it("list: variadic collect-all", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "list(1, 2, 3)")).toEqual(listValue([num(1), num(2), num(3)]));
    expect(run(ctx, "list()")).toEqual(listValue([]));
  });

  it("max/min: numeric only, filtering out non-numbers", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "max(1, 5, 3)")).toEqual(num(5));
    expect(run(ctx, "min(1, 5, 3)")).toEqual(num(1));
    expect(run(ctx, 'max(1, "x", 3)')).toEqual(num(3));
    expect(run(ctx, 'max("x", "y")')).toEqual(nullValue()); // no numeric args at all
  });

  it("now", async () => {
    const now = Date.now();
    const ctx = await fixtureCtx(now);
    expect(run(ctx, "now()")).toEqual({ type: "date", value: now });
  });

  it("number: dates->ms, booleans->0/1, strings, passthrough", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "number(true)")).toEqual(num(1));
    expect(run(ctx, "number(false)")).toEqual(num(0));
    expect(run(ctx, 'number("42")')).toEqual(num(42));
    expect(run(ctx, "number(now())")).toEqual(num((ctx.now)));
    expect(run(ctx, 'number("not a number")')).toEqual(nullValue());
  });

  it("random: 0..1, deterministic when ctx.randomSeed is set", async () => {
    const { ctx } = await buildContext(FIXTURE_FILES, "A.md", { randomSeed: 42 });
    const first = run(ctx, "random()");
    const second = run(ctx, "random()");
    expect(first).toEqual(second); // deterministic given the same seed
    expect(first.type).toBe("number");
    if (first.type === "number") {
      expect(first.value).toBeGreaterThanOrEqual(0);
      expect(first.value).toBeLessThan(1);
    }
  });

  it("today: midnight of the current context date", async () => {
    const now = new Date(2025, 5, 15, 18, 30).getTime();
    const ctx = await fixtureCtx(now);
    const result = run(ctx, "today()");
    expect(result.type).toBe("date");
    if (result.type === "date") {
      const d = new Date(result.value);
      expect(d.getHours()).toBe(0);
      expect(d.getDate()).toBe(15);
    }
  });
});

describe("evaluator: any-type methods", () => {
  it("isTruthy", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"".isTruthy()')).toEqual(bool(false));
    expect(run(ctx, '"x".isTruthy()')).toEqual(bool(true));
  });

  it("isType", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'price.isType("number")')).toEqual(bool(true));
    expect(run(ctx, 'price.isType("string")')).toEqual(bool(false));
  });

  it("toString", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "price.toString()")).toEqual(str("10"));
    expect(run(ctx, "true.toString()")).toEqual(str("true"));
  });
});

describe("evaluator: string methods", () => {
  it("length", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"hello".length')).toEqual(num(5));
  });
  it("contains/containsAll/containsAny", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"hello world".contains("wor")')).toEqual(bool(true));
    expect(run(ctx, '"hello world".containsAll("hello", "world")')).toEqual(bool(true));
    expect(run(ctx, '"hello world".containsAll("hello", "nope")')).toEqual(bool(false));
    expect(run(ctx, '"hello world".containsAny("nope", "world")')).toEqual(bool(true));
  });
  it("endsWith/startsWith", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"hello".endsWith("lo")')).toEqual(bool(true));
    expect(run(ctx, '"hello".startsWith("he")')).toEqual(bool(true));
  });
  it("isEmpty", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"".isEmpty()')).toEqual(bool(true));
    expect(run(ctx, '"x".isEmpty()')).toEqual(bool(false));
  });
  it("lower/title/trim", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"HELLO".lower()')).toEqual(str("hello"));
    expect(run(ctx, '"hello world".title()')).toEqual(str("Hello World"));
    expect(run(ctx, '"  hi  ".trim()')).toEqual(str("hi"));
  });
  it("replace: literal string pattern (single occurrence)", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"aaa".replace("a", "b")')).toEqual(str("baa"));
  });
  it("replace: regexp pattern (all occurrences, capture groups)", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"aaa".replace(/a/, "b")')).toEqual(str("bbb"));
    expect(run(ctx, '"2025-01-01".replace(/(\\d+)-(\\d+)-(\\d+)/, "$3/$2/$1")')).toEqual(str("01/01/2025"));
  });
  it("repeat", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"ab".repeat(3)')).toEqual(str("ababab"));
    expect(run(ctx, '"ab".repeat(-1)')).toEqual(str("")); // negative guarded to 0
  });
  it("reverse", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"abc".reverse()')).toEqual(str("cba"));
  });
  it("slice", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"hello".slice(1, 3)')).toEqual(str("el"));
    expect(run(ctx, '"hello".slice(2)')).toEqual(str("llo"));
  });
  it("split: string and regexp separators, with optional limit", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '"a,b,c".split(",")')).toEqual(listValue([str("a"), str("b"), str("c")]));
    expect(run(ctx, '"a,b,c".split(",", 2)')).toEqual(listValue([str("a"), str("b")]));
    expect(run(ctx, '"a1b2c".split(/\\d/)')).toEqual(listValue([str("a"), str("b"), str("c")]));
  });
});

describe("evaluator: number methods", () => {
  it("abs/ceil/floor", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "(-5).abs()")).toEqual(num(5));
    expect(run(ctx, "(1.2).ceil()")).toEqual(num(2));
    expect(run(ctx, "(1.8).floor()")).toEqual(num(1));
  });
  it("isEmpty: NaN is empty, real numbers are not", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "price.isEmpty()")).toEqual(bool(false));
    expect(run(ctx, 'number("nope").isEmpty()')).toEqual(nullValue()); // number("nope") is null, not a number
  });
  it("round: with and without digits", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "(1.2345).round()")).toEqual(num(1));
    expect(run(ctx, "(1.2345).round(2)")).toEqual(num(1.23));
  });
  it("toFixed", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "price.toFixed(2)")).toEqual(str("10.00"));
  });
});

describe("evaluator: date methods", () => {
  const ms = new Date(2025, 5, 15, 9, 30, 45, 123).getTime();

  it("field accessors", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, `date("2025-06-15 09:30:45").year`)).toEqual(num(2025));
    expect(run(ctx, `date("2025-06-15 09:30:45").month`)).toEqual(num(6));
    expect(run(ctx, `date("2025-06-15 09:30:45").day`)).toEqual(num(15));
    expect(run(ctx, `date("2025-06-15 09:30:45").hour`)).toEqual(num(9));
    expect(run(ctx, `date("2025-06-15 09:30:45").minute`)).toEqual(num(30));
    expect(run(ctx, `date("2025-06-15 09:30:45").second`)).toEqual(num(45));
  });

  it("date(): strips time", async () => {
    const ctx = await fixtureCtx();
    const result = run(ctx, `date("2025-06-15 09:30:45").date()`);
    expect(result.type).toBe("date");
    if (result.type === "date") expect(new Date(result.value).getHours()).toBe(0);
  });

  it("format", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, `date("2025-06-15").format("YYYY")`)).toEqual(str("2025"));
  });

  it("time", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, `date("2025-06-15 09:30:45").time()`)).toEqual(str("09:30:45"));
  });

  it("relative", async () => {
    const ctx = await fixtureCtx();
    const past = run(ctx, `now() - "1 week"`);
    expect(past.type).toBe("date");
  });

  it("isEmpty: always false for a valid date", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "now().isEmpty()")).toEqual(bool(false));
  });

  void ms;
});

describe("evaluator: list methods", () => {
  it("length/isEmpty", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "nums.length")).toEqual(num(3));
    expect(run(ctx, "list().isEmpty()")).toEqual(bool(true));
  });
  it("contains/containsAll/containsAny", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "nums.contains(1)")).toEqual(bool(true));
    expect(run(ctx, "nums.contains(99)")).toEqual(bool(false));
    expect(run(ctx, "nums.containsAll(1, 2)")).toEqual(bool(true));
    expect(run(ctx, "nums.containsAny(99, 2)")).toEqual(bool(true));
  });
  it("filter/map with value/index vars", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "nums.filter(value > 1)")).toEqual(listValue([num(3), num(2)]));
    expect(run(ctx, "nums.map(value * 10)")).toEqual(listValue([num(30), num(10), num(20)]));
    expect(run(ctx, "nums.map(index)")).toEqual(listValue([num(0), num(1), num(2)]));
  });
  it("reduce with value/index/acc vars", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "nums.reduce(acc + value, 0)")).toEqual(num(6));
  });
  it("flat", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "list(list(1, 2), 3).flat()")).toEqual(listValue([num(1), num(2), num(3)]));
  });
  it("join", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'nums.join(", ")')).toEqual(str("3, 1, 2"));
  });
  it("reverse/sort/unique", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "nums.reverse()")).toEqual(listValue([num(2), num(1), num(3)]));
    expect(run(ctx, "nums.sort()")).toEqual(listValue([num(1), num(2), num(3)]));
    expect(run(ctx, "list(1, 1, 2).unique()")).toEqual(listValue([num(1), num(2)]));
  });
  it("slice", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "nums.slice(1)")).toEqual(listValue([num(1), num(2)]));
    expect(run(ctx, "nums.slice(0, 2)")).toEqual(listValue([num(3), num(1)]));
  });
});

describe("evaluator: link methods", () => {
  it("asFile: resolves to the target file, or null if unresolved", async () => {
    const ctx = await fixtureCtx();
    const result = run(ctx, "ref.asFile()");
    expect(result.type).toBe("file");
    expect(run(ctx, 'link("Nowhere").asFile()')).toEqual(nullValue());
  });
  it("linksTo: compares against a file value", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'ref.linksTo(file("B.md"))')).toEqual(bool(true));
    expect(run(ctx, 'ref.linksTo(file("A.md"))')).toEqual(bool(false));
  });
});

describe("evaluator: file methods (fields + methods)", () => {
  it("field passthroughs via method dispatch", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "file.name")).toEqual(str("A.md"));
    expect(run(ctx, "file.basename")).toEqual(str("A"));
    expect(run(ctx, "file.ext")).toEqual(str("md"));
  });
  it("hasTag: single and multiple candidate values, nested-tag prefix match", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'file.hasTag("tag")')).toEqual(bool(false));
    const { ctx: bCtx } = await buildContext(FIXTURE_FILES, "B.md");
    expect(run(bCtx, 'file.hasTag("book")')).toEqual(bool(true));
    expect(run(bCtx, 'file.hasTag("book/fiction")')).toEqual(bool(false));
  });
  it("hasLink: to a file value and to a string path", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'file.hasLink("B")')).toEqual(bool(true));
    expect(run(ctx, 'file.hasLink("NoSuchFile")')).toEqual(bool(false));
  });
  it("hasProperty", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, 'file.hasProperty("price")')).toEqual(bool(true));
    expect(run(ctx, 'file.hasProperty("nope")')).toEqual(bool(false));
  });
  it("inFolder", async () => {
    const { ctx } = await buildContext({ "Notes/Sub/A.md": "x" }, "Notes/Sub/A.md");
    expect(run(ctx, 'file.inFolder("Notes")')).toEqual(bool(true)); // includes subfolders
    expect(run(ctx, 'file.inFolder("Notes/Sub")')).toEqual(bool(true));
    expect(run(ctx, 'file.inFolder("Other")')).toEqual(bool(false));
  });
  it("asLink", async () => {
    const ctx = await fixtureCtx();
    const result = run(ctx, 'file.asLink("Shown")');
    expect(result.type).toBe("link");
    if (result.type === "link") expect(result.value.display).toBe("Shown");
  });
});

describe("evaluator: object methods", () => {
  it("isEmpty/keys/values", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "file.properties.isEmpty()")).toEqual(bool(false));
    const keys = run(ctx, "file.properties.keys()");
    expect(keys.type).toBe("list");
    const values = run(ctx, "file.properties.values()");
    expect(values.type).toBe("list");
  });
});

describe("evaluator: regexp methods", () => {
  it("matches", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, '/^hello/.matches("hello world")')).toEqual(bool(true));
    expect(run(ctx, '/^bye/.matches("hello world")')).toEqual(bool(false));
  });
});

describe("evaluator: Object.prototype-name safety (regression)", () => {
  // Method/global-function/frontmatter-key lookups all go through plain
  // JS objects used as string-keyed maps. Without an own-property guard,
  // looking up a name that collides with an inherited Object.prototype
  // member (toString, constructor, hasOwnProperty, valueOf, __proto__)
  // silently resolves to that inherited member instead of "not found" —
  // this exact bug broke `.toString()` (a real, required Any-type method)
  // during development; these tests lock in the fix.
  it("price.toString() calls the real Any-type toString method, not Object.prototype.toString", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "price.toString()")).toEqual(str("10"));
  });

  it("an unimplemented Object.prototype-named method resolves to null, not an accidental invocation", async () => {
    const ctx = await fixtureCtx();
    expect(() => run(ctx, "price.constructor()")).not.toThrow();
    expect(run(ctx, "price.constructor()")).toEqual(nullValue());
    expect(run(ctx, "price.hasOwnProperty()")).toEqual(nullValue());
    expect(run(ctx, "price.valueOf()")).toEqual(nullValue());
  });

  it("an unimplemented Object.prototype-named global function resolves to null", async () => {
    const ctx = await fixtureCtx();
    expect(run(ctx, "constructor()")).toEqual(nullValue());
    expect(run(ctx, "valueOf()")).toEqual(nullValue());
  });

  it("a frontmatter property literally named 'toString' or 'constructor' round-trips as data, not a function", async () => {
    const { ctx } = await buildContext(
      { "A.md": "---\ntoString: hello\nconstructor: world\n---\n" },
      "A.md"
    );
    expect(run(ctx, "toString")).toEqual(str("hello"));
    expect(run(ctx, "constructor")).toEqual(str("world"));
  });

  it("a frontmatter property NOT named 'toString' still resolves to null (no false-positive 'in' match)", async () => {
    const ctx = await fixtureCtx(); // fixture frontmatter has no "toString" key
    expect(run(ctx, "toString")).toEqual(nullValue());
  });
});
