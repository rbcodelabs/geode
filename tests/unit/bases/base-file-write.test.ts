import { describe, expect, it } from "vitest";
import { parseBaseFile, type BaseDefinition } from "../../../src/renderer/bases/base-file";
import { stringifyBaseFile } from "../../../src/renderer/bases/base-file-write";

function minimalDef(): BaseDefinition {
  return {
    filters: undefined,
    formulas: {},
    properties: {},
    summaries: {},
    views: [{ type: "table", name: "Table" }],
  };
}

describe("stringifyBaseFile", () => {
  it("round-trips a minimal definition through parseBaseFile", () => {
    const def = minimalDef();
    const parsed = parseBaseFile(stringifyBaseFile(def));
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.def).toEqual(def);
  });

  it("round-trips filters, formulas, properties, summaries, and full view config", () => {
    const def: BaseDefinition = {
      filters: { and: ['note.status == "Done"'] },
      formulas: { total: "note.price * note.qty" },
      properties: { "note.status": { displayName: "Status" } },
      summaries: { sum: "values.sum()" },
      views: [
        {
          type: "table",
          name: "Table",
          limit: 50,
          groupBy: { property: "note.status", direction: "DESC" },
          filters: { or: ['note.priority > 1'] },
          order: ["file.name", "note.status"],
          sort: [{ property: "note.priority", direction: "ASC" }],
          summaries: { "note.price": "sum" },
        },
      ],
    };
    const parsed = parseBaseFile(stringifyBaseFile(def));
    if ("error" in parsed) throw new Error(parsed.error);
    expect(parsed.def).toEqual(def);
  });

  it("omits empty collections rather than writing empty-object/array noise", () => {
    const yamlText = stringifyBaseFile(minimalDef());
    expect(yamlText).not.toContain("formulas:");
    expect(yamlText).not.toContain("properties:");
    expect(yamlText).not.toContain("summaries:");
    expect(yamlText).not.toContain("filters:");
  });
});
