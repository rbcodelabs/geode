import { describe, expect, it } from "vitest";
import { parseBaseFile } from "../../../src/renderer/bases/base-file";

// Verbatim from docs/spec/02-core-plugins.md's Bases section (".base YAML syntax (complete)").
const SPEC_EXAMPLE = `
filters:
  or:
    - file.hasTag("tag")
    - and:
        - file.hasTag("book")
        - file.hasLink("Textbook")
    - not:
        - file.hasTag("book")
formulas:
  formatted_price: 'if(price, price.toFixed(2) + " dollars")'
  ppu: "(price / age).toFixed(2)"
properties:
  status:
    displayName: Status
  formula.formatted_price:
    displayName: "Price"
  file.ext:
    displayName: Extension
summaries:
  customAverage: 'values.mean().round(3)'
views:
  - type: table
    name: "My table"
    limit: 10
    groupBy:
      property: note.age
      direction: DESC
    filters:
      and:
        - 'status != "done"'
        - or:
            - "formula.ppu > 5"
            - "price > 2.1"
    order:
      - file.name
      - file.ext
      - note.age
      - formula.ppu
      - formula.formatted_price
    summaries:
      formula.ppu: Average
`;

describe("parseBaseFile: spec worked example", () => {
  it("parses the exact example YAML from the Bases spec without error", () => {
    const result = parseBaseFile(SPEC_EXAMPLE);
    expect("def" in result).toBe(true);
  });

  it("parses formulas as raw expression-text strings", () => {
    const result = parseBaseFile(SPEC_EXAMPLE);
    if (!("def" in result)) throw new Error(result.error);
    expect(result.def.formulas).toEqual({
      formatted_price: 'if(price, price.toFixed(2) + " dollars")',
      ppu: "(price / age).toFixed(2)",
    });
  });

  it("parses per-property displayName config, keyed by property path", () => {
    const result = parseBaseFile(SPEC_EXAMPLE);
    if (!("def" in result)) throw new Error(result.error);
    expect(result.def.properties).toEqual({
      status: { displayName: "Status" },
      "formula.formatted_price": { displayName: "Price" },
      "file.ext": { displayName: "Extension" },
    });
  });

  it("parses named summaries as raw expression-text strings", () => {
    const result = parseBaseFile(SPEC_EXAMPLE);
    if (!("def" in result)) throw new Error(result.error);
    expect(result.def.summaries).toEqual({ customAverage: "values.mean().round(3)" });
  });

  it("parses the base-level filters block as a raw (unparsed) YAML node", () => {
    const result = parseBaseFile(SPEC_EXAMPLE);
    if (!("def" in result)) throw new Error(result.error);
    expect(result.def.filters).toEqual({
      or: ['file.hasTag("tag")', { and: ['file.hasTag("book")', 'file.hasLink("Textbook")'] }, { not: ['file.hasTag("book")'] }],
    });
  });

  it("parses a view with type/name/limit/groupBy/filters/order/sort/summaries", () => {
    const result = parseBaseFile(SPEC_EXAMPLE);
    if (!("def" in result)) throw new Error(result.error);
    expect(result.def.views).toHaveLength(1);
    const view = result.def.views[0];
    expect(view.type).toBe("table");
    expect(view.name).toBe("My table");
    expect(view.limit).toBe(10);
    expect(view.groupBy).toEqual({ property: "note.age", direction: "DESC" });
    expect(view.order).toEqual(["file.name", "file.ext", "note.age", "formula.ppu", "formula.formatted_price"]);
    expect(view.summaries).toEqual({ "formula.ppu": "Average" });
    expect(view.filters).toEqual({
      and: ['status != "done"', { or: ['formula.ppu > 5', "price > 2.1"] }],
    });
  });
});

describe("parseBaseFile: leniency", () => {
  it("returns empty collections for a completely empty document", () => {
    const result = parseBaseFile("");
    if (!("def" in result)) throw new Error(result.error);
    expect(result.def).toEqual({
      filters: undefined,
      formulas: {},
      properties: {},
      summaries: {},
      views: [],
    });
  });

  it("returns empty collections when top-level keys are missing entirely", () => {
    const result = parseBaseFile("someOtherKey: 5\n");
    if (!("def" in result)) throw new Error(result.error);
    expect(result.def.formulas).toEqual({});
    expect(result.def.views).toEqual([]);
  });

  it("drops malformed formula entries (non-string values) instead of throwing", () => {
    const result = parseBaseFile("formulas:\n  good: \"1 + 1\"\n  bad:\n    nested: true\n");
    if (!("def" in result)) throw new Error(result.error);
    expect(result.def.formulas).toEqual({ good: "1 + 1" });
  });

  it("drops a view missing required type/name fields instead of throwing", () => {
    const result = parseBaseFile("views:\n  - limit: 5\n  - type: table\n    name: Valid\n");
    if (!("def" in result)) throw new Error(result.error);
    expect(result.def.views).toHaveLength(1);
    expect(result.def.views[0].name).toBe("Valid");
  });

  it("defaults an invalid/missing sort direction to ASC", () => {
    const result = parseBaseFile(
      "views:\n  - type: table\n    name: V\n    sort:\n      - property: file.name\n      - property: file.size\n        direction: DESC\n"
    );
    if (!("def" in result)) throw new Error(result.error);
    expect(result.def.views[0].sort).toEqual([
      { property: "file.name", direction: "ASC" },
      { property: "file.size", direction: "DESC" },
    ]);
  });

  it("returns {error} only for actual YAML syntax errors", () => {
    const result = parseBaseFile("filters: [unterminated\n");
    expect("error" in result).toBe(true);
  });
});
