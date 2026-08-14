import { describe, expect, it } from "vitest";
import { runQuery } from "../../../src/renderer/bases/query-engine";
import { parseBaseFile } from "../../../src/renderer/bases/base-file";
import { MetadataCache } from "../../../src/renderer/metadata-cache";
import { FakeVault } from "../../helpers/fake-vault";
import { num, str } from "../../../src/renderer/bases/value";

const BASE_YAML = `
formulas:
  ppu: "(price / age).toFixed(2)"
filters:
  and:
    - 'status != "done"'
views:
  - type: table
    name: "Main"
    sort:
      - property: note.price
        direction: ASC
    order:
      - file.name
      - note.price
      - formula.ppu
    summaries:
      note.price: total
  - type: table
    name: "Grouped"
    groupBy:
      property: note.status
      direction: ASC
summaries:
  total: "values.reduce(acc + value, 0)"
`;

async function setup() {
  const files: Record<string, string> = {
    "Apple.md": "---\nprice: 10\nage: 2\nstatus: active\n---\n",
    "Banana.md": "---\nprice: 4\nage: 4\nstatus: active\n---\n",
    "Cherry.md": "---\nprice: 20\nage: 5\nstatus: done\n---\n",
    "Date.md": "---\nprice: 1\nage: 1\nstatus: pending\n---\n",
  };
  const fake = new FakeVault(files);
  const vault = fake.asVault();
  const metadataCache = new MetadataCache(vault);
  await metadataCache.initialize();
  const parsed = parseBaseFile(BASE_YAML);
  if (!("def" in parsed)) throw new Error(parsed.error);
  return { def: parsed.def, vault, metadataCache };
}

describe("runQuery: end-to-end", () => {
  it("returns an error for an unknown view name", async () => {
    const { def, vault, metadataCache } = await setup();
    const result = runQuery(def, "Nope", vault.getMarkdownFiles(), vault, metadataCache, null, Date.now());
    expect("error" in result).toBe(true);
  });

  it("filters out rows that fail the base-level filter", async () => {
    const { def, vault, metadataCache } = await setup();
    const result = runQuery(def, "Main", vault.getMarkdownFiles(), vault, metadataCache, null, Date.now());
    if ("error" in result) throw new Error(result.error);
    // Cherry.md has status: done -> excluded by `status != "done"`.
    expect(result.rows.map((r) => r.file.basename).sort()).toEqual(["Apple", "Banana", "Date"]);
  });

  it("sorts by the declared sort key (note.price ASC)", async () => {
    const { def, vault, metadataCache } = await setup();
    const result = runQuery(def, "Main", vault.getMarkdownFiles(), vault, metadataCache, null, Date.now());
    if ("error" in result) throw new Error(result.error);
    expect(result.rows.map((r) => r.file.basename)).toEqual(["Date", "Banana", "Apple"]);
  });

  it("resolves order columns (file.name, note.price, formula.ppu) per row", async () => {
    const { def, vault, metadataCache } = await setup();
    const result = runQuery(def, "Main", vault.getMarkdownFiles(), vault, metadataCache, null, Date.now());
    if ("error" in result) throw new Error(result.error);
    const apple = result.rows.find((r) => r.file.basename === "Apple")!;
    expect(apple.properties["file.name"]).toEqual(str("Apple.md"));
    expect(apple.properties["note.price"]).toEqual(num(10));
    expect(apple.properties["formula.ppu"]).toEqual(str("5.00")); // 10 / 2 = 5.00
    expect(apple.formulas.ppu).toEqual(str("5.00"));
  });

  it("computes a custom named summary over the visible column values", async () => {
    const { def, vault, metadataCache } = await setup();
    const result = runQuery(def, "Main", vault.getMarkdownFiles(), vault, metadataCache, null, Date.now());
    if ("error" in result) throw new Error(result.error);
    // Visible prices after filtering out Cherry (done): Date=1, Banana=4, Apple=10 -> sum 15.
    expect(result.summaries["note.price"]).toEqual(num(15));
  });

  it("respects view.limit", async () => {
    const { def, vault, metadataCache } = await setup();
    const limitedDef = { ...def, views: def.views.map((v) => (v.name === "Main" ? { ...v, limit: 2 } : v)) };
    const result = runQuery(limitedDef, "Main", vault.getMarkdownFiles(), vault, metadataCache, null, Date.now());
    if ("error" in result) throw new Error(result.error);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.map((r) => r.file.basename)).toEqual(["Date", "Banana"]);
  });

  it("groups rows by the declared groupBy property (base-level filter still applies to every view)", async () => {
    const { def, vault, metadataCache } = await setup();
    const result = runQuery(def, "Grouped", vault.getMarkdownFiles(), vault, metadataCache, null, Date.now());
    if ("error" in result) throw new Error(result.error);
    expect(result.groups).not.toBeNull();
    // Cherry.md (status: done) is still excluded by the base-wide filter,
    // which the spec says concatenates with AND across every view.
    const keys = result.groups!.map((g) => g.key);
    expect(keys).toEqual([str("active"), str("pending")]); // ASC by status
    const activeGroup = result.groups!.find((g) => g.key.type === "string" && g.key.value === "active")!;
    expect(activeGroup.rows.map((r) => r.file.basename).sort()).toEqual(["Apple", "Banana"]);
  });

  it("returns an empty result set (no error) for an empty file list", async () => {
    const { def, vault, metadataCache } = await setup();
    const result = runQuery(def, "Main", [], vault, metadataCache, null, Date.now());
    if ("error" in result) throw new Error(result.error);
    expect(result.rows).toEqual([]);
  });
});
